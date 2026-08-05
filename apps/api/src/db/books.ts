/**
 * Acceso a `books` y `enrichments`.
 *
 * La caché es el pilar del presupuesto (CLAUDE.md, regla 2): un cache hit es
 * $0 y <100ms, un miss dispara la cascada y —en la Fase 3— el LLM. Todo lo que
 * se pueda resolver acá no llega nunca a un proveedor.
 */
import type { Book, Enrichment } from '@lector/shared';

/** Fila cruda de `books`, con los nombres de columna tal cual el SQL. */
type BookRow = {
  isbn13: string;
  title: string;
  authors: string;
  publisher: string | null;
  published_year: number | null;
  page_count: number | null;
  language: string | null;
  cover_url: string | null;
  work_key: string | null;
  raw_sources: string | null;
  fetched_at: number;
};

type EnrichmentRow = {
  isbn13: string;
  summary: string;
  hook: string;
  genres: string;
  appeal_vector: string;
  content_flags: string;
  comparables: string | null;
  confidence: number;
  model_used: string;
  prompt_tokens: number | null;
  output_tokens: number | null;
  scan_count: number;
  created_at: number;
};

/** JSON.parse que no tumba el request si una fila quedó corrupta. */
function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function rowToBook(row: BookRow): Book {
  return {
    isbn13: row.isbn13,
    title: row.title,
    authors: parseJson<string[]>(row.authors, []),
    fetchedAt: row.fetched_at,
    // Las columnas NULL se omiten en vez de mapearse a null: el schema Zod de
    // @lector/shared usa `.optional()`, no `.nullable()`.
    ...(row.publisher !== null && { publisher: row.publisher }),
    ...(row.published_year !== null && { publishedYear: row.published_year }),
    ...(row.page_count !== null && { pageCount: row.page_count }),
    ...(row.language !== null && { language: row.language }),
    ...(row.cover_url !== null && { coverUrl: row.cover_url }),
    ...(row.work_key !== null && { workKey: row.work_key }),
    ...(row.raw_sources !== null && { rawSources: parseJson<unknown>(row.raw_sources, null) }),
  };
}

export function rowToEnrichment(row: EnrichmentRow): Enrichment {
  return {
    isbn13: row.isbn13,
    summary: row.summary,
    hook: row.hook,
    genres: parseJson<string[]>(row.genres, []),
    appealVector: parseJson(row.appeal_vector, {} as Enrichment['appealVector']),
    contentFlags: parseJson<Enrichment['contentFlags']>(row.content_flags, []),
    confidence: row.confidence,
    modelUsed: row.model_used,
    scanCount: row.scan_count,
    createdAt: row.created_at,
    ...(row.comparables !== null && {
      comparables: parseJson<string[]>(row.comparables, []),
    }),
    ...(row.prompt_tokens !== null && { promptTokens: row.prompt_tokens }),
    ...(row.output_tokens !== null && { outputTokens: row.output_tokens }),
  };
}

export async function getBook(db: D1Database, isbn13: string): Promise<Book | null> {
  const row = await db
    .prepare('SELECT * FROM books WHERE isbn13 = ?')
    .bind(isbn13)
    .first<BookRow>();

  return row ? rowToBook(row) : null;
}

export async function getEnrichment(
  db: D1Database,
  isbn13: string
): Promise<Enrichment | null> {
  const row = await db
    .prepare('SELECT * FROM enrichments WHERE isbn13 = ?')
    .bind(isbn13)
    .first<EnrichmentRow>();

  return row ? rowToEnrichment(row) : null;
}

/**
 * Guarda (o pisa) un libro.
 *
 * UPSERT en vez de INSERT: dos escaneos simultáneos del mismo ISBN corren la
 * cascada en paralelo y el segundo tiene que sobrescribir sin explotar.
 */
export async function upsertBook(db: D1Database, book: Book): Promise<void> {
  await db
    .prepare(
      `INSERT INTO books (
         isbn13, title, authors, publisher, published_year, page_count,
         language, cover_url, work_key, raw_sources, fetched_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(isbn13) DO UPDATE SET
         title = excluded.title,
         authors = excluded.authors,
         publisher = excluded.publisher,
         published_year = excluded.published_year,
         page_count = excluded.page_count,
         language = excluded.language,
         cover_url = excluded.cover_url,
         work_key = excluded.work_key,
         raw_sources = excluded.raw_sources,
         fetched_at = excluded.fetched_at`
    )
    .bind(
      book.isbn13,
      book.title,
      JSON.stringify(book.authors),
      book.publisher ?? null,
      book.publishedYear ?? null,
      book.pageCount ?? null,
      book.language ?? null,
      book.coverUrl ?? null,
      book.workKey ?? null,
      book.rawSources === undefined ? null : JSON.stringify(book.rawSources),
      book.fetchedAt
    )
    .run();
}

/**
 * Suma uno a `scan_count`. A los 3 se dispara el upgrade perezoso al modelo de
 * la cabeza — eso lo implementa la Fase 3; acá solo se lleva la cuenta.
 */
export async function incrementScanCount(db: D1Database, isbn13: string): Promise<void> {
  await db
    .prepare('UPDATE enrichments SET scan_count = scan_count + 1 WHERE isbn13 = ?')
    .bind(isbn13)
    .run();
}
