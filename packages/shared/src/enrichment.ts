import { z } from 'zod';
import { AppealVectorSchema } from './appeal-vector';
import { ContentFlagSchema } from './content-flag';

/**
 * Lo que produce el LLM para un libro. Es **inmutable y global**: no depende del
 * usuario ni lo ve nunca (CLAUDE.md, regla 2). Espeja la tabla `enrichments`.
 */
export const EnrichmentSchema = z.object({
  isbn13: z.string().regex(/^\d{13}$/, 'ISBN-13 son 13 dígitos'),
  /** Sin spoilers, 60–90 palabras: solo el planteo. */
  summary: z.string().min(1),
  /** Una línea, el gancho. */
  hook: z.string().min(1),
  genres: z.array(z.string().min(1)),
  appealVector: AppealVectorSchema,
  contentFlags: z.array(ContentFlagSchema),
  /** "Si te gustó X…" */
  comparables: z.array(z.string().min(1)).optional(),
  /** 0–1. Baja = poca fuente disponible. La cola larga se penaliza × 0.8. */
  confidence: z.number().min(0).max(1),
  /** Sale de LLM_MODEL / LLM_MODEL_TAIL. Nunca hardcodeado. */
  modelUsed: z.string().min(1),
  /** Para auditar gasto real contra el estimado. */
  promptTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  /**
   * El spoiler guard saltó dos veces seguidas: la ficha se guardó igual —una
   * pantalla vacía es peor— pero hay que mirarla. También encola el upgrade.
   */
  needsReview: z.boolean().default(false),
  /** A los 3 escaneos se encola el upgrade perezoso al modelo pago. */
  scanCount: z.number().int().nonnegative().default(0),
  /** Epoch en milisegundos. */
  createdAt: z.number().int(),
});

export type Enrichment = z.infer<typeof EnrichmentSchema>;
