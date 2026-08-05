/**
 * GET /api/book/:isbn13
 *
 * Camino feliz del producto entero. El orden importa por presupuesto
 * (CLAUDE.md, regla 2):
 *
 *   validar ISBN → caché D1 → cascada de fuentes → guardar → responder
 *
 * El enriquecimiento por LLM **no se llama acá todavía** (es la Fase 3). Hasta
 * entonces un libro recién resuelto sale con `enrichment: null` y la ficha
 * muestra metadata cruda, que es exactamente el modo degradado que tiene que
 * funcionar cuando `LLM_ENABLED=false`.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { isbnErrorMessage, validateIsbn13 } from '../lib/isbn';
import { getBook, getEnrichment, incrementScanCount, upsertBook } from '../db/books';
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

    // El contador alimenta el upgrade perezoso de la Fase 3. Solo se cuenta si
    // ya hay enrichment: sin fila que actualizar no hay nada que contar.
    if (enrichment) await incrementScanCount(db, isbn13);

    await recordScanEvent(db, {
      isbn13,
      method: 'barcode',
      resolved: true,
      latencyMs: Date.now() - started,
    });

    return c.json({ book: cached, enrichment, source: 'cache' as const });
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

  await recordScanEvent(db, {
    isbn13,
    method: 'barcode',
    resolved: true,
    latencyMs: Date.now() - started,
  });

  return c.json({
    book: resolved.book,
    enrichment: null,
    source: 'fresh' as const,
    // Diagnóstico de la cascada. Sirve para entender por qué un libro salió
    // pobre sin tener que reproducir el fetch.
    meta: {
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
