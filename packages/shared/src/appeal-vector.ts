import { z } from 'zod';

/** Toda dimensión de apelación vive en la escala 0.0–1.0. */
const unit = () => z.number().min(0).max(1);

/**
 * Vector de apelación de 14 dimensiones — modelo de reader's advisory de Joyce
 * Saricks (CLAUDE.md, regla 4). El género es un predictor pésimo; esto no.
 *
 * El score se calcula en el cliente con coseno ponderado sobre este vector.
 */
export const AppealVectorSchema = z.object({
  ritmo: unit(), //              0 contemplativo      → 1 trepidante
  densidadPersonajes: unit(), // 0 un protagonista    → 1 elenco coral
  introspeccion: unit(), //      0 acción externa     → 1 vida interior
  linealidad: unit(), //         0 fragmentario       → 1 cronológico
  cierre: unit(), //             0 final abierto      → 1 todo resuelto
  worldbuilding: unit(), //      0 mundo cotidiano    → 1 mundo construido
  anclajeHistorico: unit(), //   0 atemporal          → 1 período específico
  luminosidad: unit(), //        0 oscuro/desolador   → 1 luminoso/esperanzado
  humor: unit(), //              0 sin humor          → 1 humor central
  densidadProsa: unit(), //      0 transparente       → 1 densa/experimental
  exigencia: unit(), //          0 lectura fácil      → 1 requiere esfuerzo
  cargaEmocional: unit(), //     0 distante           → 1 devastador
  romance: unit(), //            0 ausente            → 1 eje central
  extension: unit(), //          0 <200pp             → 1 >600pp
});

export type AppealVector = z.infer<typeof AppealVectorSchema>;

export type AppealDimension = keyof AppealVector;

/** Las 14 dimensiones, en orden de declaración. Derivadas del schema: no duplicar. */
export const APPEAL_DIMENSIONS = Object.keys(
  AppealVectorSchema.shape,
) as readonly AppealDimension[];
