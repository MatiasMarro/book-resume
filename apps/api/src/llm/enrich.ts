/**
 * Orquestador del enriquecimiento: de un libro resuelto a una ficha validada.
 *
 *   sanitizar → prompt → proveedor → parsear → validar con Zod → guard → penalizar
 *
 * Los dos reintentos viven acá porque son de distinta naturaleza y no hay que
 * confundirlos:
 *
 * - **Por forma** (punto 6 del plan): solo si `supportsStrictSchema === false`.
 *   Con OpenAI y `strict: true` el JSON no puede salir mal, así que reintentar
 *   sería pagar dos veces por nada.
 * - **Por spoiler** (punto 5): con instrucción reforzada, para cualquier
 *   proveedor. Si vuelve a fallar, la ficha se guarda igual pero con el
 *   confidence penalizado y marcada para revisión — dejar al libro sin ficha
 *   es peor para alguien que está parado en el pasillo.
 *
 * **Nunca lanza por culpa del modelo.** Devuelve `null` y el llamador degrada a
 * metadata cruda, que es el mismo camino que ya recorre `LLM_ENABLED=false`.
 * Lo único que lanza es una configuración rota, y eso pasa antes, en
 * `providers/index.ts`.
 */
import type { Book } from '@lector/shared';
import type { DescriptionCandidate } from '../sources/types';
import { sanitizeDescriptions, type Descarte } from './sanitize';
import { validarSalida } from './schema';
import { REFUERZO_ANTI_SPOILER } from './prompts';
import {
  describirHallazgos,
  penalizarConfidence,
  revisarSpoilers,
  type Hallazgo,
} from './spoilerGuard';
import type { EnrichRequest, EnrichResult, LlmProvider, Tramo } from './types';

/**
 * La cola larga usa modelos económicos y calibra peor. El ×0.8 está en
 * docs/LLM.md y hace que la ficha de un libro de cola muestre "info limitada"
 * antes que la de uno de cabeza, que es exactamente la diferencia real.
 */
export const PENALIZACION_COLA = 0.8;

export type EnrichmentGenerado = EnrichResult & {
  modelUsed: string;
  promptTokens?: number;
  outputTokens?: number;
  /** El guard saltó dos veces: la ficha se guardó igual, pero hay que mirarla. */
  needsReview: boolean;
};

export type DiagnosticoEnriquecimiento = {
  /** Cuántas veces se llamó al proveedor. Para auditar el gasto real. */
  llamadas: number;
  descartes: Descarte[];
  hallazgosSpoiler: Hallazgo[];
  /** Por qué no hay ficha, cuando no la hay. */
  motivoFalla?: string;
};

export type ResultadoEnriquecimiento = {
  enrichment: EnrichmentGenerado | null;
  diagnostico: DiagnosticoEnriquecimiento;
};

/**
 * Arma el pedido para el modelo a partir de lo que devolvió la cascada.
 *
 * Acá es donde pasa la sanitización, y es el **único** camino por el que el
 * texto de las fuentes llega al prompt. Si mañana alguien construye un
 * `EnrichRequest` a mano salteándose esta función, el filtro anti-spoiler deja
 * de existir sin que ningún test se ponga rojo.
 */
export function construirEnrichRequest(
  book: Book,
  descriptions: DescriptionCandidate[],
  subjects: string[]
): { req: EnrichRequest; descartes: Descarte[] } {
  const { textos, descartes } = sanitizeDescriptions(descriptions);

  return {
    req: {
      isbn13: book.isbn13,
      title: book.title,
      authors: book.authors,
      ...(book.publisher && { publisher: book.publisher }),
      ...(book.publishedYear !== undefined && { publishedYear: book.publishedYear }),
      ...(book.pageCount !== undefined && { pageCount: book.pageCount }),
      ...(book.language && { language: book.language }),
      subjects,
      descripciones: textos,
    },
    descartes,
  };
}

/** Una llamada al proveedor, parseada y validada. Nunca lanza. */
async function intentar(
  provider: LlmProvider,
  req: EnrichRequest
): Promise<{ ok: true; valor: EnrichResult; crudo: Awaited<ReturnType<LlmProvider['complete']>> } | { ok: false; motivo: string }> {
  let crudo;
  try {
    crudo = await provider.complete(req);
  } catch (error) {
    return { ok: false, motivo: error instanceof Error ? error.message : String(error) };
  }

  const validado = validarSalida(crudo.data);
  if (!validado.ok) return { ok: false, motivo: `salida inválida — ${validado.motivo}` };

  return { ok: true, valor: validado.valor, crudo };
}

export type OpcionesEnriquecimiento = {
  tramo: Tramo;
};

/**
 * Enriquece un libro. El corazón de la Fase 3.
 */
export async function enriquecer(
  provider: LlmProvider,
  req: EnrichRequest,
  opciones: OpcionesEnriquecimiento
): Promise<ResultadoEnriquecimiento> {
  const diagnostico: DiagnosticoEnriquecimiento = {
    llamadas: 0,
    descartes: [],
    hallazgosSpoiler: [],
  };

  // ─── 1 · Llamada, con reintento por forma si el proveedor no garantiza el
  //         schema. Dos intentos y no más: un tercero es plata tirada.
  diagnostico.llamadas++;
  let intento = await intentar(provider, req);

  if (!intento.ok && !provider.supportsStrictSchema) {
    console.warn(`[llm] ${provider.name} devolvió algo inválido, reintento: ${intento.motivo}`);
    diagnostico.llamadas++;
    intento = await intentar(provider, req);
  }

  if (!intento.ok) {
    diagnostico.motivoFalla = intento.motivo;
    console.error(`[llm] ${provider.name} no devolvió una ficha usable: ${intento.motivo}`);
    return { enrichment: null, diagnostico };
  }

  let salida = intento.valor;
  let crudo = intento.crudo;
  let needsReview = false;

  // ─── 2 · Guard de spoilers, con un reintento reforzado.
  const veredicto = revisarSpoilers(salida);

  if (!veredicto.limpio) {
    diagnostico.hallazgosSpoiler = veredicto.hallazgos;
    console.warn(
      `[llm] spoiler detectado en ${req.isbn13}: ${describirHallazgos(veredicto.hallazgos)}`
    );

    diagnostico.llamadas++;
    const segundo = await intentar(provider, {
      ...req,
      refuerzoAntiSpoiler: REFUERZO_ANTI_SPOILER,
    });

    if (segundo.ok) {
      const revision = revisarSpoilers(segundo.valor);
      salida = segundo.valor;
      crudo = segundo.crudo;

      if (!revision.limpio) {
        // Dos veces seguidas: se guarda igual, pero marcado y con el confidence
        // castigado. Una ficha sospechosa con confidence bajo le sirve más al
        // lector que una pantalla vacía.
        needsReview = true;
        diagnostico.hallazgosSpoiler = revision.hallazgos;
        console.error(
          `[llm] el reintento reforzado de ${req.isbn13} volvió a spoilear: ` +
            `${describirHallazgos(revision.hallazgos)} — se guarda para revisión`
        );
      }
    } else {
      // El reintento falló por otra razón: nos quedamos con la primera salida,
      // que al menos es válida, marcada para revisión.
      needsReview = true;
      console.error(`[llm] el reintento reforzado de ${req.isbn13} falló: ${segundo.motivo}`);
    }
  }

  // ─── 3 · Penalizaciones de confidence. Se componen: un libro de cola que
  //         además quedó marcado para revisión acumula las dos.
  let confidence = salida.confidence;
  if (opciones.tramo === 'cola') confidence *= PENALIZACION_COLA;
  if (needsReview) confidence = penalizarConfidence(confidence);

  return {
    enrichment: {
      ...salida,
      confidence: Math.round(Math.max(0, Math.min(1, confidence)) * 1000) / 1000,
      modelUsed: crudo.modelUsed,
      ...(crudo.promptTokens !== undefined && { promptTokens: crudo.promptTokens }),
      ...(crudo.outputTokens !== undefined && { outputTokens: crudo.outputTokens }),
      needsReview,
    },
    diagnostico,
  };
}
