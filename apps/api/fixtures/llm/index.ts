/**
 * Índice de fixtures del LLM.
 *
 * Se escribe a mano y no se genera: adentro del Worker no hay filesystem —
 * `fs.readdir` no existe— y el bundler tampoco tiene un `import.meta.glob` como
 * el de Vite. Un `import` explícito por archivo es lo único que sobrevive al
 * bundle, y de paso hace obvio en el diff qué fixture se agregó.
 *
 * Para sumar uno: guardá `<isbn13>.json` en esta carpeta con la forma de la
 * salida del modelo (snake_case, las 14 dimensiones, `content_flags` del
 * vocabulario cerrado) y agregalo al mapa.
 */
import cienAniosDeSoledad from './9788420471839.json';
import laConjuraDeLosNecios from './9788433920423.json';

export const FIXTURES_LLM: Record<string, unknown> = {
  '9788420471839': cienAniosDeSoledad,
  '9788433920423': laConjuraDeLosNecios,
};
