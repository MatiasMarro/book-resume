/**
 * Bindings del Worker.
 *
 * Los model IDs y proveedores llegan siempre por env — nunca hardcodeados
 * (docs/LLM.md, "El adapter"). Se tipan como `string` a propósito: el adapter los
 * valida con Zod al arrancar y falla ruidoso si el modelo no existe.
 */
export type Bindings = {
  DB: D1Database;
  /**
   * Workers AI. Es el default de la cola larga: 10.000 neuronas/día gratis y sin
   * API key, porque el binding es nativo. Opcional a propósito — con
   * `LLM_PROVIDER=fixture` (el default de desarrollo) no hace falta.
   */
  AI?: Ai;

  // vars públicas — wrangler.toml
  /** 'true' | 'false'. Kill switch: en false degrada a metadata cruda. */
  LLM_ENABLED: string;
  /** Cabeza: 'openai' | 'workersai' | 'fixture' */
  LLM_PROVIDER: string;
  LLM_MODEL: string;
  /** Cola larga: free tier */
  LLM_PROVIDER_TAIL: string;
  LLM_MODEL_TAIL: string;

  // secrets — `wrangler secret put` / .dev.vars
  GOOGLE_BOOKS_KEY?: string;
  OPENAI_API_KEY?: string;
  GOOGLE_AI_STUDIO_KEY?: string;

  /**
   * Solo para verificar el catálogo de Workers AI: el binding `AI` corre
   * inferencia pero no lista modelos, y listarlos pide la API de Cloudflare.
   * Sin esto la verificación queda en 'no-verificable' y el chequeo duro lo hace
   * `scripts/check-models.ts` antes del deploy.
   */
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
};

export type AppEnv = { Bindings: Bindings };
