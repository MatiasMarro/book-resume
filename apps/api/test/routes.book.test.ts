import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { bookRow, createFakeD1, enrichmentRow } from './helpers/fake-d1';
import * as cascade from '../src/resolver/cascade';
import type { MergedBook } from '../src/resolver/merge';
import { resetVerificaciones } from '../src/llm/providers/index';

const ISBN = '9788420471839';

beforeEach(() => resetVerificaciones());
afterEach(() => vi.restoreAllMocks());

/**
 * El kill switch apagado es el default de estos tests: la mayoría no tiene nada
 * que ver con el LLM y no hay por qué hacerlos pasar por el adapter.
 */
function env(fake: ReturnType<typeof createFakeD1>, overrides: Record<string, string> = {}) {
  return { DB: fake.db, LLM_ENABLED: 'false', ...overrides } as never;
}

/** Env con el proveedor fixture en los dos tramos: enriquece sin salir a la red. */
function envConLlm(fake: ReturnType<typeof createFakeD1>, overrides: Record<string, string> = {}) {
  return env(fake, {
    LLM_ENABLED: 'true',
    LLM_PROVIDER: 'fixture',
    LLM_MODEL: 'modelo-cabeza',
    LLM_PROVIDER_TAIL: 'fixture',
    LLM_MODEL_TAIL: 'modelo-cola',
    ...overrides,
  });
}

const RESUELTO: MergedBook = {
  book: {
    isbn13: ISBN,
    title: 'Cien años de soledad',
    authors: ['Gabriel García Márquez'],
    pageCount: 609,
    fetchedAt: 1_700_000_000_000,
  },
  provenance: { title: 'openlibrary' },
  descriptions: [{ source: 'openlibrary', text: 'Una descripción larga.' }],
  subjects: ['magic realism'],
  sourcesHit: ['openlibrary'],
};

describe('GET /api/book/:isbn13 — validación', () => {
  it('400 con checksum roto, sin tocar la red ni la base', async () => {
    const fake = createFakeD1();
    const spy = vi.spyOn(cascade, 'resolveByIsbn');

    const res = await app.request('/api/book/9788420471838', {}, env(fake));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'isbn-invalido' });
    expect(spy).not.toHaveBeenCalled();
    expect(fake.calls.selectBook).toBe(0);
  });

  it('400 con formato inválido', async () => {
    const res = await app.request('/api/book/123', {}, env(createFakeD1()));
    expect(res.status).toBe(400);
  });

  it('400 con un EAN-13 que no es de libro', async () => {
    const res = await app.request('/api/book/7790001234561', {}, env(createFakeD1()));
    await expect(res.json()).resolves.toMatchObject({ error: 'isbn-invalido' });
  });

  it('el mensaje de error es accionable, no un código pelado', async () => {
    const res = await app.request('/api/book/9788420471838', {}, env(createFakeD1()));
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/escanear de nuevo|dígito/i);
  });
});

describe('GET /api/book/:isbn13 — cache hit', () => {
  it('devuelve source:cache sin correr la cascada', async () => {
    // El pilar del presupuesto (regla 2): un hit no gasta un centavo.
    const fake = createFakeD1({ books: new Map([[ISBN, bookRow(ISBN)]]) });
    const spy = vi.spyOn(cascade, 'resolveByIsbn');

    const res = await app.request(`/api/book/${ISBN}`, {}, env(fake));
    const body = (await res.json()) as { source: string; book: { title: string } };

    expect(res.status).toBe(200);
    expect(body.source).toBe('cache');
    expect(body.book.title).toBe('Cien años de soledad');
    expect(spy).not.toHaveBeenCalled();
  });

  it('deserializa el JSON de las columnas', async () => {
    const fake = createFakeD1({ books: new Map([[ISBN, bookRow(ISBN)]]) });

    const res = await app.request(`/api/book/${ISBN}`, {}, env(fake));
    const body = (await res.json()) as { book: { authors: string[]; pageCount: number } };

    expect(body.book.authors).toEqual(['Gabriel García Márquez']);
    expect(body.book.pageCount).toBe(609);
  });

  it('devuelve el enrichment si existe', async () => {
    const fake = createFakeD1({
      books: new Map([[ISBN, bookRow(ISBN)]]),
      enrichments: new Map([[ISBN, enrichmentRow(ISBN)]]),
    });

    const res = await app.request(`/api/book/${ISBN}`, {}, env(fake));
    const body = (await res.json()) as { enrichment: { summary: string; modelUsed: string } };

    expect(body.enrichment.summary).toBe('Un resumen sin spoilers.');
    expect(body.enrichment.modelUsed).toBe('gpt-5.6-luna');
  });

  it('incrementa scan_count: alimenta el upgrade perezoso de la Fase 3', async () => {
    const row = enrichmentRow(ISBN);
    const fake = createFakeD1({
      books: new Map([[ISBN, bookRow(ISBN)]]),
      enrichments: new Map([[ISBN, row]]),
    });

    await app.request(`/api/book/${ISBN}`, {}, env(fake));

    expect(row.scan_count).toBe(1);
  });

  it('no intenta incrementar si todavía no hay enrichment', async () => {
    const fake = createFakeD1({ books: new Map([[ISBN, bookRow(ISBN)]]) });

    await app.request(`/api/book/${ISBN}`, {}, env(fake));

    expect(fake.calls.increment).toBe(0);
  });

  it('registra el escaneo como resuelto', async () => {
    const fake = createFakeD1({ books: new Map([[ISBN, bookRow(ISBN)]]) });

    await app.request(`/api/book/${ISBN}`, {}, env(fake));

    expect(fake.rows.scanEvents).toHaveLength(1);
    expect(fake.rows.scanEvents[0]).toMatchObject({ isbn13: ISBN, method: 'barcode', resolved: 1 });
  });
});

describe('GET /api/book/:isbn13 — cache miss', () => {
  it('corre la cascada, guarda y devuelve source:fresh', async () => {
    const fake = createFakeD1();
    vi.spyOn(cascade, 'resolveByIsbn').mockResolvedValue(RESUELTO);

    const res = await app.request(`/api/book/${ISBN}`, {}, env(fake));
    const body = (await res.json()) as { source: string; enrichment: null };

    expect(res.status).toBe(200);
    expect(body.source).toBe('fresh');
    // Con el kill switch apagado la ficha sale con metadata cruda.
    expect(body.enrichment).toBeNull();
    expect(fake.rows.books.has(ISBN)).toBe(true);
  });

  it('el guardado deja la caché lista para el próximo escaneo', async () => {
    const fake = createFakeD1();
    const spy = vi.spyOn(cascade, 'resolveByIsbn').mockResolvedValue({
      book: { isbn13: ISBN, title: 'Rayuela', authors: ['Julio Cortázar'], fetchedAt: 1 },
      provenance: { title: 'openlibrary' },
      descriptions: [],
      subjects: [],
      sourcesHit: ['openlibrary'],
    });

    await app.request(`/api/book/${ISBN}`, {}, env(fake));
    const segunda = await app.request(`/api/book/${ISBN}`, {}, env(fake));
    const body = (await segunda.json()) as { source: string; book: { title: string } };

    expect(body.source).toBe('cache');
    expect(body.book.title).toBe('Rayuela');
    // La cascada corrió una sola vez para los dos escaneos.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('incluye meta de diagnóstico de la cascada', async () => {
    const fake = createFakeD1();
    vi.spyOn(cascade, 'resolveByIsbn').mockResolvedValue({
      book: { isbn13: ISBN, title: 'X', authors: [], fetchedAt: 1 },
      provenance: { title: 'openlibrary', description: 'googlebooks' },
      descriptions: [{ source: 'googlebooks', text: '12345' }],
      subjects: ['a', 'b'],
      sourcesHit: ['openlibrary', 'googlebooks'],
    });

    const res = await app.request(`/api/book/${ISBN}`, {}, env(fake));
    const body = (await res.json()) as {
      meta: { sourcesHit: string[]; descriptions: { source: string; length: number }[] };
    };

    expect(body.meta.sourcesHit).toEqual(['openlibrary', 'googlebooks']);
    expect(body.meta.descriptions).toEqual([{ source: 'googlebooks', length: 5 }]);
  });
});

describe('GET /api/book/:isbn13 — enriquecimiento en cache miss', () => {
  it('enriquece y devuelve la ficha completa', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = createFakeD1();
    vi.spyOn(cascade, 'resolveByIsbn').mockResolvedValue(RESUELTO);

    const res = await app.request(`/api/book/${ISBN}`, {}, envConLlm(fake));
    const body = (await res.json()) as {
      enrichment: { summary: string; modelUsed: string } | null;
      meta: { enrichment: string };
    };

    expect(body.meta.enrichment).toBe('listo');
    expect(body.enrichment?.summary).toBeTruthy();
    // Un cache miss es cola por definición: nadie escaneó este libro todavía.
    expect(body.enrichment?.modelUsed).toBe('fixture:modelo-cola');
  });

  it('deja la ficha guardada para el próximo escaneo', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = createFakeD1();
    vi.spyOn(cascade, 'resolveByIsbn').mockResolvedValue(RESUELTO);

    await app.request(`/api/book/${ISBN}`, {}, envConLlm(fake));
    const segunda = await app.request(`/api/book/${ISBN}`, {}, envConLlm(fake));
    const body = (await segunda.json()) as { source: string; enrichment: { summary: string } };

    expect(body.source).toBe('cache');
    expect(body.enrichment.summary).toBeTruthy();
    // La segunda pasada no vuelve a enriquecer: una llamada por libro (regla 2).
    expect(fake.calls.saveEnrichment).toBe(1);
  });

  it('con el kill switch apagado informa apagado, no fallo', async () => {
    const fake = createFakeD1();
    vi.spyOn(cascade, 'resolveByIsbn').mockResolvedValue(RESUELTO);

    const res = await app.request(`/api/book/${ISBN}`, {}, env(fake));
    const body = (await res.json()) as { meta: { enrichment: string } };

    expect(body.meta.enrichment).toBe('apagado');
    expect(fake.calls.saveEnrichment).toBe(0);
  });

  it('NO reintenta un libro ya cacheado sin ficha: una llamada por libro', async () => {
    // Un libro sin descripciones nunca va a dar ficha. Reintentarlo en cada
    // escaneo gastaría una llamada por siempre — justo lo que la regla 2 prohíbe.
    const fake = createFakeD1({ books: new Map([[ISBN, bookRow(ISBN)]]) });

    const res = await app.request(`/api/book/${ISBN}`, {}, envConLlm(fake));
    const body = (await res.json()) as { meta: { enrichment: string } };

    expect(body.meta.enrichment).toBe('ausente');
    expect(fake.calls.saveEnrichment).toBe(0);
  });

  it('el latency_ms del evento no incluye la espera del modelo', async () => {
    // Es la métrica de cobertura de la Fase 1 llevada a producción: tiene que
    // seguir midiendo cuánto tarda RESOLVER un libro.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = createFakeD1();
    vi.spyOn(cascade, 'resolveByIsbn').mockResolvedValue(RESUELTO);

    await app.request(`/api/book/${ISBN}`, {}, envConLlm(fake));

    expect(fake.rows.scanEvents).toHaveLength(1);
    expect(fake.calls.saveEnrichment).toBe(1);
    // El evento se escribió antes del enriquecimiento.
    expect(fake.rows.scanEvents[0]!.latency_ms).toBeLessThan(1_000);
  });
});

describe('GET /api/book/:isbn13 — upgrade perezoso', () => {
  const COLA = 'fixture:modelo-cola';

  function conFicha(scanCount: number, overrides: Record<string, unknown> = {}) {
    return createFakeD1({
      books: new Map([[ISBN, bookRow(ISBN)]]),
      enrichments: new Map([
        [ISBN, enrichmentRow(ISBN, { model_used: COLA, scan_count: scanCount, ...overrides })],
      ]),
    });
  }

  it('encola al tercer escaneo', async () => {
    const fake = conFicha(2);

    await app.request(`/api/book/${ISBN}`, {}, envConLlm(fake));

    expect(fake.rows.upgrades.get(ISBN)).toMatchObject({
      isbn13: ISBN,
      reason: 'scan-count',
      from_model: COLA,
    });
  });

  it('no encola en el segundo', async () => {
    const fake = conFicha(1);

    await app.request(`/api/book/${ISBN}`, {}, envConLlm(fake));

    expect(fake.rows.upgrades.size).toBe(0);
  });

  it('no encola una ficha que ya es de la cabeza', async () => {
    const fake = conFicha(9, { model_used: 'modelo-cabeza' });

    await app.request(`/api/book/${ISBN}`, {}, envConLlm(fake));

    expect(fake.rows.upgrades.size).toBe(0);
  });

  it('encola una ficha marcada para revisión desde el primer escaneo', async () => {
    const fake = conFicha(0, { needs_review: 1 });

    await app.request(`/api/book/${ISBN}`, {}, envConLlm(fake));

    expect(fake.rows.upgrades.get(ISBN)).toMatchObject({ reason: 'needs-review' });
  });

  it('encolar no dispara ninguna llamada al modelo', async () => {
    // El drenaje es trabajo de enrich-batch: un cache hit responde en <100ms.
    const fake = conFicha(2);

    await app.request(`/api/book/${ISBN}`, {}, envConLlm(fake));

    expect(fake.calls.saveEnrichment).toBe(0);
  });
});

describe('GET /api/book/:isbn13 — no resuelve', () => {
  it('404 con un mensaje útil y el ISBN de vuelta', async () => {
    const fake = createFakeD1();
    vi.spyOn(cascade, 'resolveByIsbn').mockResolvedValue(null);

    const res = await app.request(`/api/book/${ISBN}`, {}, env(fake));
    const body = (await res.json()) as { error: string; message: string; isbn13: string };

    expect(res.status).toBe(404);
    expect(body.error).toBe('no-encontrado');
    expect(body.isbn13).toBe(ISBN);
    // Tiene que explicar POR QUÉ y qué hacer, no solo "not found".
    expect(body.message).toMatch(/editoriales chicas|título/i);
  });

  it('registra el escaneo como NO resuelto: es la métrica de cobertura real', async () => {
    const fake = createFakeD1();
    vi.spyOn(cascade, 'resolveByIsbn').mockResolvedValue(null);

    await app.request(`/api/book/${ISBN}`, {}, env(fake));

    expect(fake.rows.scanEvents[0]).toMatchObject({ isbn13: ISBN, resolved: 0 });
  });

  it('no guarda nada en books', async () => {
    const fake = createFakeD1();
    vi.spyOn(cascade, 'resolveByIsbn').mockResolvedValue(null);

    await app.request(`/api/book/${ISBN}`, {}, env(fake));

    expect(fake.rows.books.size).toBe(0);
  });
});
