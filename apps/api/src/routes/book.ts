/**
 * GET /api/book/:isbn13
 *
 * Camino feliz del producto entero. El orden importa por presupuesto
 * (CLAUDE.md, regla 2):
 *
 *   validar ISBN → caché D1 → cascada de fuentes → guardar → enriquecer → responder
 *
 * ## El enriquecimiento corre SOLO en cache miss
 *
 * Un libro que ya está en `books` pero no en `enrichments` **no se reintenta**, y
 * es deliberado: si se reintentara, un libro sin descripciones —del que el modelo
 * nunca va a poder sacar una ficha— gastaría una llamada en cada escaneo, para
 * siempre. Eso es exactamente lo que la regla 2 existe para impedir. Un intento
 * por libro; los que fallan son trabajo de `scripts/enrich-batch.ts`, que puede
 * decidir con la tabla entera a la vista.
 *
 * Los libros que quedaron en la base desde la Fase 2 caen en ese grupo.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { isbnErrorMessage, validateIsbn13 } from '../lib/isbn';
import { enriquecerEnVivo } from '../lib/enriquecerEnVivo';
import { enSegundoPlano } from '../lib/segundoPlano';
import { getBook, getEnrichment, incrementScanCount, upsertBook } from '../db/books';
import { decidirUpgrade, encolarUpgrade } from '../db/upgrades';
import { recordScanEvent } from '../db/events';
import { resolveByIsbn } from '../resolver/cascade';

export const book = new Hono<AppEnv>();

book.get('/api/book/:isbn13', async (c) => {
  const started = Date.now();
  const raw = c.req.param('isbn13');

  const validation = validateIsbn13(raw);
  if (!validation.valid) {
    // Un ISBN inválido no se registra en scan_events: no es un escaneo fallido
    // del catálogo, es basura que nunca llegó a ser una consulta.
    return c.json(
      { error: 'isbn-invalido', message: isbnErrorMessage(validation.reason) },
      400
    );
  }

  const { isbn13 } = validation;
  const db = c.env.DB;

  // --- 1. Caché -----------------------------------------------------------
  const cached = await getBook(db, isbn13);
  if (cached) {
    const enrichment = await getEnrichment(db, isbn13);

    // El contador alimenta el upgrade perezoso. Solo se cuenta si ya hay
    // enrichment: sin fila que actualizar no hay nada que contar.
    if (enrichment) {
      await incrementScanCount(db, isbn13);

      // La fila en memoria trae el valor de antes del UPDATE. El +1 es este
      // escaneo, que es justo el que puede cruzar el umbral.
      const scanCount = enrichment.scanCount + 1;
      const motivo = decidirUpgrade({
        modelUsed: enrichment.modelUsed,
        scanCount,
        needsReview: enrichment.needsReview,
        modeloCabeza: c.env.LLM_MODEL ?? '',
      });

      if (motivo) {
        await encolarUpgrade(db, { isbn13, motivo, fromModel: enrichment.modelUsed });
      }
    }

    await recordScanEvent(db, {
      isbn13,
      method: 'barcode',
      resolved: true,
      latencyMs: Date.now() - started,
    });

    return c.json({
      book: cached,
      enrichment,
      source: 'cache' as const,
      meta: { enrichment: enrichment ? ('listo' as const) : ('ausente' as const) },
    });
  }

  // --- 2. Cascada ---------------------------------------------------------
  const resolved = await resolveByIsbn(isbn13, {
    ...(c.env.GOOGLE_BOOKS_KEY && { googleBooksKey: c.env.GOOGLE_BOOKS_KEY }),
  });

  if (!resolved) {
    await recordScanEvent(db, {
      isbn13,
      method: 'barcode',
      resolved: false,
      latencyMs: Date.now() - started,
    });

    return c.json(
      {
        error: 'no-encontrado',
        message:
          'No encontramos este libro en ninguna fuente. Suele pasar con ediciones ' +
          'de editoriales chicas o muy nuevas. Probá buscarlo por título.',
        isbn13,
      },
      404
    );
  }

  // --- 3. Guardar y responder --------------------------------------------
  await upsertBook(db, resolved.book);

  // El evento se registra ANTES de la carrera del LLM, a propósito: `latency_ms`
  // mide cuánto tarda resolver un libro, que es la métrica de cobertura de la
  // Fase 1 llevada a producción. Sumarle los hasta 6 s del modelo la volvería
  // ilegible justo en los casos que más importan.
  await recordScanEvent(db, {
    isbn13,
    method: 'barcode',
    resolved: true,
    latencyMs: Date.now() - started,
  });

  // --- 4. Enriquecimiento, contra el reloj --------------------------------
  const enriquecido = await enriquecerEnVivo({
    db,
    env: c.env,
    book: resolved.book,
    descriptions: resolved.descriptions,
    subjects: resolved.subjects,
  });

  if (enriquecido.enSegundoPlano) enSegundoPlano(c, enriquecido.enSegundoPlano);

  return c.json({
    book: resolved.book,
    enrichment: enriquecido.enrichment,
    source: 'fresh' as const,
    // Diagnóstico de la cascada. Sirve para entender por qué un libro salió
    // pobre sin tener que reproducir el fetch.
    meta: {
      enrichment: enriquecido.estado,
      sourcesHit: resolved.sourcesHit,
      provenance: resolved.provenance,
      descriptions: resolved.descriptions.map((d) => ({
        source: d.source,
        length: d.text.length,
      })),
      subjectCount: resolved.subjects.length,
    },
  });
});
