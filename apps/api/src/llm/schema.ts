/**
 * JSON Schema de la salida del LLM, compartido por todos los proveedores.
 *
 * ## Por qué se genera y no se escribe a mano
 *
 * Las 14 dimensiones salen de `APPEAL_DIMENSIONS` y las advertencias de
 * `CONTENT_FLAGS`, los dos de `@lector/shared`. Copiarlas acá garantizaría que
 * una de las dos listas quede vieja, y el síntoma sería silencioso: el modelo
 * devolvería 13 dimensiones válidas y una inventada, Zod la rechazaría, y el
 * libro se guardaría sin enriquecer sin que nadie entienda por qué.
 *
 * ## Modo estricto
 *
 * OpenAI con `strict: true` restringe la decodificación, o sea que el JSON
 * **no puede** salir mal formado. A cambio exige, en **cada** nivel del schema:
 *   - todas las propiedades listadas en `required` (no hay opcionales)
 *   - `additionalProperties: false`
 *
 * De ahí que `comparables` sea obligatorio: si no hay comparables, el modelo
 * manda `[]`, no omite el campo.
 *
 * ## Lo que el schema NO garantiza
 *
 * Los rangos. `minimum`/`maximum` son una pista para el modelo, no una
 * restricción de decodificación: un 1.4 en `ritmo` pasa el schema igual. Por eso
 * `AppealVectorSchema` de Zod valida y `validarSalida()` clampea antes de tocar
 * la base (docs/LLM.md, "Salida estructurada").
 */
import { APPEAL_DIMENSIONS, AppealVectorSchema, CONTENT_FLAGS } from '@lector/shared';
import { z } from 'zod';
import type { EnrichResult } from './types';

/** Nombre del schema. Viaja en la request de OpenAI y en los logs. */
export const NOMBRE_SCHEMA = 'enriquecimiento_libro';

type PropiedadJson = Record<string, unknown>;

/** Un `number` 0–1 con su descripción. Las 14 dimensiones son todas así. */
function dimension(descripcion: string): PropiedadJson {
  return { type: 'number', minimum: 0, maximum: 1, description: descripcion };
}

/**
 * Qué mide cada dimensión, en una línea, para que viaje **dentro del schema**.
 *
 * Los polos van acá y los ejemplos de libros van en `prompts.ts`: el schema lo
 * lee el decodificador en cada llamada, así que tiene que ser corto. Las anclas
 * con títulos concretos son largas y viven una sola vez en el bloque de sistema,
 * que es el que cachea OpenAI.
 */
export const POLOS: Record<(typeof APPEAL_DIMENSIONS)[number], string> = {
  ritmo: '0 = contemplativo, 1 = trepidante',
  densidadPersonajes: '0 = un protagonista, 1 = elenco coral',
  introspeccion: '0 = acción externa, 1 = vida interior',
  linealidad: '0 = fragmentario, 1 = cronológico',
  cierre: '0 = final abierto, 1 = todo resuelto',
  worldbuilding: '0 = mundo cotidiano, 1 = mundo construido',
  anclajeHistorico: '0 = atemporal, 1 = período histórico específico',
  luminosidad: '0 = oscuro y desolador, 1 = luminoso y esperanzado',
  humor: '0 = sin humor, 1 = el humor es central',
  densidadProsa: '0 = prosa transparente, 1 = densa o experimental',
  exigencia: '0 = lectura fácil, 1 = requiere esfuerzo',
  cargaEmocional: '0 = distante, 1 = devastador',
  romance: '0 = ausente, 1 = eje central',
  extension: '0 = menos de 200 páginas, 1 = más de 600',
};

/** Las 14 dimensiones como propiedades del JSON Schema. */
function propiedadesAppealVector(): PropiedadJson {
  return Object.fromEntries(APPEAL_DIMENSIONS.map((dim) => [dim, dimension(POLOS[dim])]));
}

/**
 * El JSON Schema completo.
 *
 * Es una función y no una constante para que nadie lo mute por accidente: se
 * manda en cada request y un objeto compartido mutado sería un bug de esos que
 * aparecen solo en producción.
 */
export function jsonSchemaEnriquecimiento(): PropiedadJson {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'summary',
      'hook',
      'genres',
      'appeal_vector',
      'content_flags',
      'comparables',
      'confidence',
    ],
    properties: {
      summary: {
        type: 'string',
        description:
          'Resumen de 60 a 90 palabras en español rioplatense neutro. SOLO el planteo: ' +
          'premisa, protagonista, conflicto inicial y tono. Prohibido el punto medio, ' +
          'el giro y el desenlace.',
      },
      hook: {
        type: 'string',
        description: 'Una sola línea, menos de 15 palabras, que dé ganas de leerlo. Sin spoilers.',
      },
      genres: {
        type: 'array',
        description: 'De 1 a 4 géneros, en minúscula y en español.',
        items: { type: 'string' },
      },
      appeal_vector: {
        type: 'object',
        description: 'Las 14 dimensiones de apelación, cada una entre 0.0 y 1.0.',
        additionalProperties: false,
        required: [...APPEAL_DIMENSIONS],
        properties: propiedadesAppealVector(),
      },
      content_flags: {
        type: 'array',
        description:
          'Advertencias de contenido presentes en el libro. Vocabulario cerrado: ' +
          'si ninguna aplica, devolver []. No inventar valores nuevos.',
        items: { type: 'string', enum: [...CONTENT_FLAGS] },
      },
      comparables: {
        type: 'array',
        description:
          'De 0 a 3 títulos parecidos, formato "Título, de Autor". Vacío si no hay ninguno claro.',
        items: { type: 'string' },
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description:
          'Qué tan confiable es este enriquecimiento dada la fuente disponible. ' +
          'Bajo (menos de 0.4) cuando la descripción es corta, ausente o ambigua.',
      },
    },
  };
}

/**
 * Zod sobre la salida del modelo.
 *
 * Acepta `snake_case` porque es lo que devuelve el modelo, y traduce a
 * `camelCase`, que es lo que usa el resto del código. Los rangos se **clampean**
 * en vez de rechazarse: un 1.02 en `ritmo` es un modelo redondeando mal, no una
 * respuesta inservible, y tirar el libro entero por eso sería peor.
 */
const unidadClampeada = z
  .number()
  .transform((n) => Math.min(1, Math.max(0, n)))
  .pipe(z.number().min(0).max(1));

const AppealVectorCrudoSchema = z.object(
  Object.fromEntries(APPEAL_DIMENSIONS.map((dim) => [dim, unidadClampeada]))
) as unknown as z.ZodType<Record<(typeof APPEAL_DIMENSIONS)[number], number>>;

export const SalidaLlmSchema = z.object({
  summary: z.string().min(1),
  hook: z.string().min(1),
  genres: z.array(z.string().min(1)),
  appeal_vector: AppealVectorCrudoSchema,
  /**
   * Los flags desconocidos se **filtran**, no rompen. Un modelo de la cola que
   * inventa 'violencia-psicologica' no puede costarnos el enriquecimiento
   * entero; el vocabulario cerrado de `CONTENT_FLAGS` es la fuente de verdad y
   * alimenta los filtros duros del scoring (regla 5).
   */
  content_flags: z
    .array(z.string())
    .transform((flags) => flags.filter((f): f is (typeof CONTENT_FLAGS)[number] =>
      (CONTENT_FLAGS as readonly string[]).includes(f)
    )),
  comparables: z.array(z.string().min(1)),
  confidence: unidadClampeada,
});

export type ResultadoValidacion =
  | { ok: true; valor: EnrichResult }
  | { ok: false; motivo: string };

/**
 * Valida la salida cruda del modelo.
 *
 * Devuelve un resultado en vez de lanzar: un JSON inválido de un proveedor
 * abierto es esperable y el pipeline tiene que poder reintentar, no explotar.
 */
export function validarSalida(data: unknown): ResultadoValidacion {
  const parsed = SalidaLlmSchema.safeParse(data);
  if (!parsed.success) {
    const problemas = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`)
      .slice(0, 5)
      .join(' · ');
    return { ok: false, motivo: problemas };
  }

  // Segunda pasada por el schema compartido: es el que manda sobre la forma del
  // AppealVector en todo el proyecto, no la copia de acá.
  const vector = AppealVectorSchema.safeParse(parsed.data.appeal_vector);
  if (!vector.success) {
    return { ok: false, motivo: `appeal_vector inválido tras clampear: ${vector.error.message}` };
  }

  return {
    ok: true,
    valor: {
      summary: parsed.data.summary.trim(),
      hook: parsed.data.hook.trim(),
      genres: parsed.data.genres.map((g) => g.trim().toLowerCase()),
      appealVector: vector.data,
      contentFlags: parsed.data.content_flags,
      comparables: parsed.data.comparables.map((c) => c.trim()),
      confidence: parsed.data.confidence,
    },
  };
}
