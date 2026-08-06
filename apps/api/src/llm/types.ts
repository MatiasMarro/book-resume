/**
 * Contrato del adapter de LLM.
 *
 * Es la frontera del sistema: de acá para adentro nadie sabe si atrás hay
 * OpenAI, Workers AI o un archivo JSON. Un proveedor nuevo es un archivo nuevo
 * en `providers/` que cumpla `LlmProvider`, nada más (docs/LLM.md, "El adapter").
 *
 * **Lo que NO entra acá: datos del usuario.** `EnrichRequest` solo tiene
 * metadata pública del libro. El enriquecimiento es inmutable y global; el
 * score personalizado se calcula en el cliente (CLAUDE.md, regla 2). Si alguna
 * vez aparece un campo de perfil en este archivo, algo se rompió de raíz.
 */
import type { AppealVector, ContentFlag } from '@lector/shared';
import type { TextoLimpio } from './sanitize';

/** Cabeza (modelo pago, top de escaneos) o cola (free tier). */
export type Tramo = 'cabeza' | 'cola';

/**
 * Lo que se le manda al modelo para enriquecer un libro. Los textos ya pasaron
 * por `sanitize.ts`: acá no hay nada que filtrar, y por eso llegan como
 * `TextoLimpio` y no como string suelto.
 */
export type EnrichRequest = {
  isbn13: string;
  title: string;
  authors: string[];
  publisher?: string;
  publishedYear?: number;
  pageCount?: number;
  language?: string;
  /** Subjects / BISAC, sin normalizar entre fuentes. */
  subjects: string[];
  /** Descripciones sanitizadas, separadas y con su procedencia. */
  descripciones: TextoLimpio[];
  /**
   * Instrucción extra para el reintento del spoiler guard. Va aparte del bloque
   * de sistema a propósito: ese bloque tiene que ser byte a byte idéntico en
   * todas las llamadas para que pegue el caché de prompt (docs/LLM.md).
   */
  refuerzoAntiSpoiler?: string;
};

/**
 * La salida cruda del modelo, ya parseada a objeto pero **sin validar**.
 *
 * Los campos son `unknown` porque el JSON Schema garantiza la *forma* solo en
 * los proveedores estrictos: en los abiertos puede venir cualquier cosa. Zod
 * valida rangos y semántica después (docs/LLM.md, "Salida estructurada").
 */
export type EnrichRaw = {
  /** El objeto que devolvió el modelo, sin tocar. */
  data: unknown;
  /** El model ID exacto que respondió — sale de env, nunca hardcodeado. */
  modelUsed: string;
  promptTokens?: number;
  outputTokens?: number;
  /** `usage` completo del proveedor, para auditar tokens de razonamiento. */
  usage?: unknown;
};

/** El enriquecimiento validado y clampeado, listo para guardar. */
export type EnrichResult = {
  summary: string;
  hook: string;
  genres: string[];
  appealVector: AppealVector;
  contentFlags: ContentFlag[];
  comparables: string[];
  confidence: number;
};

export interface LlmProvider {
  name: string;
  complete(req: EnrichRequest): Promise<EnrichRaw>;
  /**
   * Si es `false`, el pipeline activa el reintento por JSON malformado. OpenAI
   * con `strict: true` restringe en tiempo de decodificación y el JSON siempre
   * parsea; los proveedores abiertos no dan esa garantía.
   */
  supportsStrictSchema: boolean;
  /**
   * Verifica contra el proveedor que el modelo configurado exista. Los
   * catálogos gratuitos desaparecen sin aviso: el 31 de mayo de 2026 un
   * proveedor borró la mayoría de sus modelos gratis y las pipelines con el ID
   * hardcodeado murieron en silencio (docs/LLM.md).
   */
  verificarModelo(): Promise<VerificacionModelo>;
}

/**
 * Tres estados, no dos. `no-verificable` existe porque Workers AI no expone su
 * catálogo desde el binding: listarlo pide una API token de Cloudflare que el
 * Worker no tiene. Colapsar ese caso en `ok` escondería justo el problema que
 * esta verificación existe para evitar, y colapsarlo en `no-existe` apagaría el
 * enriquecimiento de un modelo que anda perfecto.
 */
export type VerificacionModelo =
  | { estado: 'ok' }
  | { estado: 'no-existe'; motivo: string; modelosDisponibles?: string[] }
  | { estado: 'no-verificable'; motivo: string };

/** Error del adapter. Lo distingue de un bug para no reintentar al pedo. */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly reintentable: boolean
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
