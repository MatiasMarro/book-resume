import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { bookRow, createFakeD1, enrichmentRow } from './helpers/fake-d1';
import * as cascade from '../src/resolver/cascade';

const ISBN = '9788420471839';

afterEach(() => vi.restoreAllMocks());

function env(fake: ReturnType<typeof createFakeD1>) {
  return { DB: fake.db, LLM_ENABLED: 'false' } as never;
}

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
  it('corre la cascada, guarda y devuelve source:fresh con enrichment null', async () => {
    const fake = createFakeD1();
    vi.spyOn(cascade, 'resolveByIsbn').mockResolvedValue({
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
    });

    const res = await app.request(`/api/book/${ISBN}`, {}, env(fake));
    const body = (await res.json()) as { source: string; enrichment: null };

    expect(res.status).toBe(200);
    expect(body.source).toBe('fresh');
    // La Fase 2 no llama al LLM: la ficha sale con metadata cruda.
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
