/**
 * Proveedor `fixture` — el default de desarrollo (CLAUDE.md, "Áreas de
 * atención": si en local dice otra cosa, pará).
 *
 * Reproduce respuestas guardadas en `apps/api/fixtures/llm/`. Un junior corre el
 * mismo código doscientas veces debuggeando el pipeline sin gastar un centavo ni
 * pegarle a ningún proveedor.
 *
 * ## Por qué inventa un vector cuando no hay fixture
 *
 * Si un ISBN sin fixture devolviera un error, media sesión de desarrollo se iría
 * en curar archivos JSON. Devuelve entonces una ficha **sintética y
 * determinística**, derivada del ISBN: el mismo ISBN da siempre el mismo vector,
 * así que los tests son estables.
 *
 * El vector sintético se **estira a propósito sobre todo el rango 0.05–0.95**. Un
 * relleno cómodo alrededor de 0.5 se vería igual que el colapso del vector que
 * la Puerta 2 tiene que detectar, y alguien terminaría celebrando un golden set
 * que en realidad está midiendo datos falsos. Que se note que es mentira es
 * parte del diseño: el `summary` lo dice con todas las letras.
 */
import { APPEAL_DIMENSIONS } from '@lector/shared';
import { FIXTURES_LLM } from '../../../fixtures/llm/index';
import type { EnrichRaw, EnrichRequest, LlmProvider, VerificacionModelo } from '../types';

/** Marca visible en el summary sintético. Si esto llega a producción, se ve. */
export const MARCA_SINTETICA = '[FIXTURE SINTÉTICO]';

export type FixtureDeps = {
  /** Solo para que quede registrado en `model_used`. No se usa para nada más. */
  model: string;
  /** Inyectable en tests. Por defecto, los fixtures del repo. */
  fixtures?: Record<string, unknown>;
};

/**
 * Hash determinístico (FNV-1a de 32 bits). Elegido por ser corto y sin
 * dependencias; no es criptográfico y no tiene por qué serlo.
 */
export function hashIsbn(isbn13: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < isbn13.length; i++) {
    hash ^= isbn13.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** Vector determinístico y bien esparcido a partir del ISBN. */
export function vectorSintetico(isbn13: string): Record<string, number> {
  const base = hashIsbn(isbn13);

  return Object.fromEntries(
    APPEAL_DIMENSIONS.map((dim, i) => {
      // Un primo distinto por dimensión evita que dos dimensiones queden
      // correlacionadas, que es justo lo que arruinaría un golden set de prueba.
      const mezcla = Math.imul(base ^ (i + 1), 0x27220a95) >>> 0;
      const valor = 0.05 + ((mezcla % 91) / 100);
      return [dim, Math.round(valor * 100) / 100];
    })
  );
}

function salidaSintetica(req: EnrichRequest): unknown {
  return {
    summary:
      `${MARCA_SINTETICA} Ficha generada sin llamar a ningún modelo, para ` +
      `desarrollo local. El libro es "${req.title}"` +
      (req.authors[0] ? `, de ${req.authors[0]}` : '') +
      '. Nada de este texto describe el contenido real: sirve para probar el ' +
      'pipeline de punta a punta, no para leerlo.',
    hook: `${MARCA_SINTETICA} Gancho de mentira para desarrollo.`,
    genres: ['sin clasificar'],
    appeal_vector: vectorSintetico(req.isbn13),
    content_flags: [],
    comparables: [],
    // Bajo a propósito: si un fixture sintético se cuela en la base, el
    // producto lo muestra como "info limitada" en vez de como dato bueno.
    confidence: 0.1,
  };
}

export function crearProveedorFixture(deps: FixtureDeps): LlmProvider {
  const fixtures = deps.fixtures ?? FIXTURES_LLM;

  return {
    name: 'fixture',
    // Un archivo JSON siempre parsea: no hace falta el reintento por forma.
    supportsStrictSchema: true,

    async complete(req: EnrichRequest): Promise<EnrichRaw> {
      const guardado = fixtures[req.isbn13];

      return {
        data: guardado ?? salidaSintetica(req),
        modelUsed: guardado ? `fixture:${deps.model}` : `fixture:sintetico`,
        // Los números de un libro típico según docs/LLM.md, para que los
        // reportes de costo en desarrollo den algo verosímil en vez de cero.
        promptTokens: 2_500,
        outputTokens: 600,
      };
    },

    async verificarModelo(): Promise<VerificacionModelo> {
      // No hay catálogo que consultar, y decir 'ok' sería mentir: lo honesto es
      // decir que este proveedor no verifica nada.
      return {
        estado: 'no-verificable',
        motivo: `el proveedor 'fixture' no consulta ningún catálogo (${Object.keys(fixtures).length} fixtures cargados)`,
      };
    },
  };
}
