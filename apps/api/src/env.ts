/**
 * Bindings del Worker.
 *
 * Los model IDs y proveedores llegan siempre por env — nunca hardcodeados
 * (docs/LLM.md, "El adapter"). Se tipan como `string` a propósito: el adapter los
 * valida con Zod al arrancar y falla ruidoso si el modelo no existe.
 */
export type Bindings = {
  DB: D1Database;

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
};

export type AppEnv = { Bindings: Bindings };
