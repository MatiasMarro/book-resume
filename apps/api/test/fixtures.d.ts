/**
 * Importar HTML crudo con `?raw` (lo resuelve Vite, que es lo que corre debajo
 * de Vitest). Se usa así y no con `fs` a propósito: el tsconfig del Worker
 * carga solo `@cloudflare/workers-types`, para que nadie use una API de Node
 * adentro del Worker por accidente.
 */
declare module '*.html?raw' {
  const contenido: string;
  export default contenido;
}
