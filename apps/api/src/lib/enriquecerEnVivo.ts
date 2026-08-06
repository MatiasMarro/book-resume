/**
 * El enriquecimiento en el camino del request: la carrera contra el reloj.
 *
 * Une tres piezas que hasta ahora no se hablaban —la cascada, el adapter de LLM
 * y la tabla `enrichments`— y resuelve el único problema real de juntarlas: el
 * modelo tarda más de lo que alguien parado en el pasillo está dispuesto a
 * esperar.
 *
 * ## La carrera, y por qué el guardado va adentro
 *
 * ```
 *   tarea = verificar modelo → enriquecer → GUARDAR      (una sola promesa)
 *   race(tarea, presupuesto)
 *     gana la tarea  → ya está guardada → la ficha sale con resumen
 *     gana el reloj  → responde sin resumen + waitUntil(tarea)
 * ```
 *
 * El `saveEnrichment` está **dentro** de `tarea` a propósito. Si la persistencia
 * viviera después del `race`, un timeout dejaría la llamada al modelo en el aire:
 * habríamos pagado el enriquecimiento para tirarlo, y el próximo escaneo lo
 * volvería a pagar. Con el guardado adentro, el que llega tarde igual deja el
 * trabajo hecho para el que viene después.
 *
 * ## El presupuesto de 6 segundos
 *
 * Decidido con el usuario, y con el trade-off a la vista: el objetivo de producto
 * es ver la ficha en menos de 5 s, así que un cache miss lento se pasa. Se acepta
 * porque el caso es el 5% del tráfico —por definición, un libro que nadie escaneó
 * todavía— y porque a cambio un modelo rápido de free tier a veces llega, y el
 * primer escaneo ya muestra resumen en vez de metadata pelada.
 *
 * Cuando no llega, el `waitUntil` hace que el **segundo** escaneo del mismo libro
 * lo tenga: el primero que escanea paga la espera por todos los demás.
 *
 * ## Siempre la cola, nunca la cabeza
 *
 * Un libro que nadie escaneó no es cabeza. El modelo pago queda para
 * `scripts/enrich-batch.ts` y para el upgrade perezoso (`db/upgrades.ts`).
 */
import type { Book, Enrichment } from '@lector/shared';
import type { Bindings } from '../env';
import { saveEnrichment } from '../db/books';
import { construirEnrichRequest, enriquecer } from '../llm/enrich';
import { configuracionDe, crearProvider, modeloUsable } from '../llm/providers/index';
import type { LlmProvider } from '../llm/types';
import type { DescriptionCandidate } from '../sources/types';

/**
 * Cuánto esperamos al modelo antes de responder sin resumen. Ver el bloque de
 * arriba: pasarse de los 5 s del objetivo está aceptado para este caso.
 */
export const PRESUPUESTO_LLM_MS = 6_000;

/**
 * Qué pasó con el enriquecimiento, para que la ficha sepa qué decir. Sin esto el
 * cliente no puede distinguir "este libro no tiene resumen" de "el resumen está
 * saliendo, volvé a escanear en unos segundos", que son dos mensajes muy
 * distintos cuando tenés el libro en la mano.
 */
export type EstadoEnriquecimiento =
  /** Llegó a tiempo. La ficha sale completa. */
  | 'listo'
  /** Perdió la carrera pero sigue corriendo. El próximo escaneo lo va a tener. */
  | 'pendiente'
  /** `LLM_ENABLED=false`. Modo degradado a propósito. */
  | 'apagado'
  /** Configuración rota, modelo inexistente, o el modelo no devolvió nada usable. */
  | 'fallo';

export type ResultadoEnVivo = {
  enrichment: Enrichment | null;
  estado: EstadoEnriquecimiento;
  /** Presente solo con estado 'pendiente': hay que pasarla a `waitUntil`. */
  enSegundoPlano?: Promise<unknown>;
};

export type DepsEnVivo = {
  db: D1Database;
  env: Bindings;
  book: Book;
  descriptions: DescriptionCandidate[];
  subjects: string[];
  /** Inyectables para testear sin proveedor real ni esperar 6 segundos. */
  provider?: LlmProvider;
  presupuestoMs?: number;
  now?: () => number;
};

/** Marca del reloj. Un valor propio y no `null` para no confundirlo con "no hubo ficha". */
const RELOJ = Symbol('presupuesto agotado');

export async function enriquecerEnVivo(deps: DepsEnVivo): Promise<ResultadoEnVivo> {
  const { db, env, book } = deps;
  const now = deps.now ?? Date.now;
  const presupuesto = deps.presupuestoMs ?? PRESUPUESTO_LLM_MS;

  let provider: LlmProvider | null;
  try {
    provider = deps.provider ?? crearProvider('cola', env);
  } catch (error) {
    // `crearProvider` lanza por configuración rota, y tiene razón en lanzar: es
    // un error de deploy. Pero acá del otro lado hay alguien esperando una
    // ficha, así que se loguea ruidoso y se degrada, igual que hace
    // `modeloUsable` con un modelo inexistente. El fallo duro es
    // `npm run check:models`, antes de deployar.
    console.error(
      `[llm] configuración inválida, se degrada a metadata cruda: ` +
        (error instanceof Error ? error.message : String(error))
    );
    return { enrichment: null, estado: 'fallo' };
  }

  if (!provider) return { enrichment: null, estado: 'apagado' };

  const { model } = configuracionDe(env, 'cola');
  const activo = provider;

  // Una sola promesa: verifica, enriquece y guarda. Nunca rechaza — el llamador
  // puede mandarla a `waitUntil` sin envolverla, y un unhandled rejection
  // después de responder no tiene a quién avisarle.
  const tarea: Promise<Enrichment | null> = (async () => {
    if (!(await modeloUsable(activo, model))) return null;

    const { req } = construirEnrichRequest(book, deps.descriptions, deps.subjects);
    const { enrichment: generado } = await enriquecer(activo, req, { tramo: 'cola' });
    if (!generado) return null;

    const fila: Enrichment = {
      isbn13: book.isbn13,
      summary: generado.summary,
      hook: generado.hook,
      genres: generado.genres,
      appealVector: generado.appealVector,
      contentFlags: generado.contentFlags,
      comparables: generado.comparables,
      confidence: generado.confidence,
      modelUsed: generado.modelUsed,
      ...(generado.promptTokens !== undefined && { promptTokens: generado.promptTokens }),
      ...(generado.outputTokens !== undefined && { outputTokens: generado.outputTokens }),
      needsReview: generado.needsReview,
      // Este escaneo ya quedó registrado en `scan_events`; el contador del
      // upgrade perezoso empieza a correr con el próximo cache hit.
      scanCount: 0,
      createdAt: now(),
    };

    await saveEnrichment(db, fila);
    return fila;
  })().catch((error) => {
    console.error(
      `[llm] el enriquecimiento de ${book.isbn13} se cayó: ` +
        (error instanceof Error ? error.message : String(error))
    );
    return null;
  });

  let reloj: ReturnType<typeof setTimeout> | undefined;
  const vencimiento = new Promise<typeof RELOJ>((resolver) => {
    reloj = setTimeout(() => resolver(RELOJ), presupuesto);
  });

  try {
    const ganador = await Promise.race([tarea, vencimiento]);

    if (ganador === RELOJ) {
      return { enrichment: null, estado: 'pendiente', enSegundoPlano: tarea };
    }

    return ganador
      ? { enrichment: ganador, estado: 'listo' }
      : { enrichment: null, estado: 'fallo' };
  } finally {
    // Sin esto el timer sobrevive a la respuesta: mantiene vivo el isolate en
    // producción y cuelga la corrida de vitest en los tests.
    if (reloj !== undefined) clearTimeout(reloj);
  }
}
