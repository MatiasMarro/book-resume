/**
 * D1 en memoria, lo mínimo para testear las rutas.
 *
 * No es un SQLite: reconoce las consultas concretas que usa `src/db/` y guarda
 * las filas en Maps. Si agregás una consulta nueva y no la contempla, lanza en
 * vez de devolver un resultado equivocado en silencio.
 */

export type FakeRows = {
  books: Map<string, Record<string, unknown>>;
  enrichments: Map<string, Record<string, unknown>>;
  scanEvents: Record<string, unknown>[];
  upgrades: Map<string, Record<string, unknown>>;
};

export function createFakeD1(seed: Partial<FakeRows> = {}) {
  const rows: FakeRows = {
    books: seed.books ?? new Map(),
    enrichments: seed.enrichments ?? new Map(),
    scanEvents: seed.scanEvents ?? [],
    upgrades: seed.upgrades ?? new Map(),
  };

  /** Contador por tipo de consulta, para verificar que la caché evita trabajo. */
  const calls = {
    selectBook: 0,
    selectEnrichment: 0,
    upsertBook: 0,
    increment: 0,
    insertEvent: 0,
    saveEnrichment: 0,
    encolarUpgrade: 0,
  };

  const db = {
    prepare(sql: string) {
      const statement = {
        _args: [] as unknown[],
        bind(...args: unknown[]) {
          statement._args = args;
          return statement;
        },
        async first<T>(): Promise<T | null> {
          const key = String(statement._args[0]);

          if (sql.includes('FROM books')) {
            calls.selectBook++;
            return (rows.books.get(key) as T) ?? null;
          }
          if (sql.includes('FROM enrichments')) {
            calls.selectEnrichment++;
            return (rows.enrichments.get(key) as T) ?? null;
          }
          throw new Error(`fake-d1: SELECT no contemplado: ${sql}`);
        },
        async run() {
          if (sql.includes('INSERT INTO books')) {
            calls.upsertBook++;
            const [
              isbn13,
              title,
              authors,
              publisher,
              published_year,
              page_count,
              language,
              cover_url,
              work_key,
              raw_sources,
              fetched_at,
            ] = statement._args;
            rows.books.set(String(isbn13), {
              isbn13,
              title,
              authors,
              publisher,
              published_year,
              page_count,
              language,
              cover_url,
              work_key,
              raw_sources,
              fetched_at,
            });
            return { success: true };
          }

          if (sql.includes('INSERT INTO enrichments')) {
            calls.saveEnrichment++;
            const [
              isbn13,
              summary,
              hook,
              genres,
              appeal_vector,
              content_flags,
              comparables,
              confidence,
              model_used,
              prompt_tokens,
              output_tokens,
              needs_review,
              scan_count,
              created_at,
            ] = statement._args;
            const clave = String(isbn13);
            const previa = rows.enrichments.get(clave);
            rows.enrichments.set(clave, {
              isbn13,
              summary,
              hook,
              genres,
              appeal_vector,
              content_flags,
              comparables,
              confidence,
              model_used,
              prompt_tokens,
              output_tokens,
              needs_review,
              // El UPSERT real deja `scan_count` afuera del DO UPDATE: un
              // re-enriquecimiento no borra la demanda acumulada.
              scan_count: previa ? previa.scan_count : scan_count,
              created_at,
            });
            return { success: true };
          }

          if (sql.includes('INSERT OR IGNORE INTO enrichment_upgrades')) {
            calls.encolarUpgrade++;
            const [isbn13, reason, from_model, queued_at] = statement._args;
            const clave = String(isbn13);
            // OR IGNORE: el que ya está encolado no se pisa.
            if (!rows.upgrades.has(clave)) {
              rows.upgrades.set(clave, { isbn13, reason, from_model, queued_at, done_at: null });
            }
            return { success: true };
          }

          if (sql.includes('UPDATE enrichments')) {
            calls.increment++;
            const key = String(statement._args[0]);
            const row = rows.enrichments.get(key);
            if (row) row.scan_count = (row.scan_count as number) + 1;
            return { success: true };
          }

          if (sql.includes('INSERT INTO scan_events')) {
            calls.insertEvent++;
            const [isbn13, method, resolved, latency_ms, created_at] = statement._args;
            rows.scanEvents.push({ isbn13, method, resolved, latency_ms, created_at });
            return { success: true };
          }

          throw new Error(`fake-d1: escritura no contemplada: ${sql}`);
        },
      };
      return statement;
    },
  };

  return { db: db as unknown as D1Database, rows, calls };
}

/** Fila de `books` lista para sembrar la caché. */
export function bookRow(isbn13: string, overrides: Record<string, unknown> = {}) {
  return {
    isbn13,
    title: 'Cien años de soledad',
    authors: JSON.stringify(['Gabriel García Márquez']),
    publisher: 'Alfaguara',
    published_year: 2007,
    page_count: 609,
    language: 'es',
    cover_url: 'https://covers.openlibrary.org/b/id/15219095-L.jpg',
    work_key: '/works/OL274505W',
    raw_sources: JSON.stringify({ openlibrary: {} }),
    fetched_at: 1_700_000_000_000,
    ...overrides,
  };
}

/** Fila de `enrichments`. */
export function enrichmentRow(isbn13: string, overrides: Record<string, unknown> = {}) {
  return {
    isbn13,
    summary: 'Un resumen sin spoilers.',
    hook: 'El gancho.',
    genres: JSON.stringify(['realismo mágico']),
    appeal_vector: JSON.stringify({ ritmo: 0.4 }),
    content_flags: JSON.stringify([]),
    comparables: JSON.stringify(['Pedro Páramo']),
    confidence: 0.8,
    model_used: 'gpt-5.6-luna',
    prompt_tokens: 2500,
    output_tokens: 600,
    needs_review: 0,
    scan_count: 0,
    created_at: 1_700_000_000_000,
    ...overrides,
  };
}
