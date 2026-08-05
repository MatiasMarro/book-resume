-- Migration number: 0001 	 esquema inicial
-- **Fuente de verdad del esquema de datos** (CLAUDE.md, "Fuentes de verdad").
-- Si el esquema cambia, cambia acá y en packages/shared/src/, en ningún otro lado.
--
-- El perfil del usuario NO vive acá: vive en localStorage del dispositivo.
-- Sin cuentas, sin login, sin PII en el servidor.

CREATE TABLE books (
  isbn13          TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  authors         TEXT NOT NULL,      -- JSON array
  publisher       TEXT,
  published_year  INTEGER,
  page_count      INTEGER,
  language        TEXT,
  cover_url       TEXT,
  work_key        TEXT,               -- Open Library work, agrupa ediciones
  raw_sources     TEXT,               -- JSON, para poder re-enriquecer sin re-fetch
  fetched_at      INTEGER NOT NULL
);

CREATE TABLE enrichments (
  isbn13          TEXT PRIMARY KEY REFERENCES books(isbn13),
  summary         TEXT NOT NULL,      -- sin spoilers, 60-90 palabras
  hook            TEXT NOT NULL,      -- una línea, gancho
  genres          TEXT NOT NULL,      -- JSON array
  appeal_vector   TEXT NOT NULL,      -- JSON AppealVector
  content_flags   TEXT NOT NULL,      -- JSON array
  comparables     TEXT,               -- JSON array: "si te gustó X..."
  confidence      REAL NOT NULL,      -- 0-1, baja = poca fuente disponible
  model_used      TEXT NOT NULL,      -- ej 'gpt-5.6-luna'
  prompt_tokens   INTEGER,            -- para auditar gasto real
  output_tokens   INTEGER,
  scan_count      INTEGER NOT NULL DEFAULT 0,  -- dispara el upgrade perezoso a 3
  created_at      INTEGER NOT NULL
);

CREATE TABLE scan_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  isbn13     TEXT,
  method     TEXT,        -- 'barcode' | 'ocr' | 'manual'
  resolved   INTEGER,     -- 0/1
  latency_ms INTEGER,
  created_at INTEGER
);
