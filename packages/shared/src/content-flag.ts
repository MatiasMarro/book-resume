import { z } from 'zod';

/**
 * Vocabulario cerrado de advertencias de contenido. **Esta lista es la fuente de
 * verdad** — el enum del JSON Schema del LLM y los `avoids` del perfil salen de acá.
 * Alimenta los filtros duros de la regla 5, así que no se extiende sin migrar los
 * perfiles ya guardados en los dispositivos.
 */
export const CONTENT_FLAGS = [
  'violencia-grafica',
  'violencia-sexual',
  'maltrato-animal',
  'muerte-infantil',
  'suicidio',
  'adicciones',
  'final-tragico',
  'contenido-sexual-explicito',
] as const;

export const ContentFlagSchema = z.enum(CONTENT_FLAGS);

export type ContentFlag = z.infer<typeof ContentFlagSchema>;
