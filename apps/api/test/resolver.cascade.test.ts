import { describe, expect, it, vi } from 'vitest';
import { resolveByIsbn } from '../src/resolver/cascade';
import { emptyRecord, type SourceRecord } from '../src/sources/types';

const ISBN = '9788420471839';

function record(
  source: SourceRecord['source'],
  overrides: Partial<SourceRecord> = {}
): SourceRecord {
  return { ...emptyRecord(source, {}), title: `Título ${source}`, ...overrides };
}

/** Fuentes mockeadas; por defecto ninguna resuelve. */
function deps(over: {
  ol?: SourceRecord | null;
  gb?: SourceRecord | null;
  wiki?: SourceRecord | null;
}) {
  const openlibrary = vi.fn(async () => over.ol ?? null);
  const googlebooks = vi.fn(async () => over.gb ?? null);
  const wikipedia = vi.fn(async () => over.wiki ?? null);

  return {
    spies: { openlibrary, googlebooks, wikipedia },
    deps: { sources: { openlibrary, googlebooks, wikipedia } as never },
  };
}

describe('resolveByIsbn — etapa 1', () => {
  it('consulta Open Library y Google Books en paralelo', async () => {
    const { spies, deps: d } = deps({ ol: record('openlibrary') });

    await resolveByIsbn(ISBN, d);

    expect(spies.openlibrary).toHaveBeenCalledWith(ISBN, {});
    expect(spies.googlebooks).toHaveBeenCalledWith(ISBN, undefined, {});
  });

  it('pasa la key de Google Books cuando está', async () => {
    const { spies, deps: d } = deps({ ol: record('openlibrary') });

    await resolveByIsbn(ISBN, { ...d, googleBooksKey: 'KEY' });

    expect(spies.googlebooks).toHaveBeenCalledWith(ISBN, 'KEY', {});
  });

  it('null cuando ninguna resuelve y ni siquiera intenta Wikipedia', async () => {
    // Sin título no hay con qué buscar en Wikipedia: gastar 2 requests sería
    // latencia pura. Es el caso de los 15 ISBN de independientes argentinas.
    const { spies, deps: d } = deps({});

    await expect(resolveByIsbn(ISBN, d)).resolves.toBeNull();
    expect(spies.wikipedia).not.toHaveBeenCalled();
  });

  it('sobrevive a que una de las dos falle', async () => {
    const { deps: d } = deps({ ol: record('openlibrary'), gb: null });

    const merged = await resolveByIsbn(ISBN, d);

    expect(merged!.sourcesHit).toEqual(['openlibrary']);
  });
});

describe('resolveByIsbn — etapa 2, Wikipedia condicionada', () => {
  it('NO consulta Wikipedia si la etapa 1 ya trajo descripción', async () => {
    // Wikipedia es la fuente menos precisa y cuesta 2 requests: solo se usa
    // cuando no hay nada mejor.
    const { spies, deps: d } = deps({
      ol: record('openlibrary', { descriptions: [{ source: 'openlibrary', text: 'ya hay' }] }),
    });

    await resolveByIsbn(ISBN, d);

    expect(spies.wikipedia).not.toHaveBeenCalled();
  });

  it('consulta Wikipedia si hay título pero ninguna descripción', async () => {
    const { spies, deps: d } = deps({
      ol: record('openlibrary', { title: 'Rayuela', authors: ['Julio Cortázar'] }),
      wiki: record('wikipedia', { descriptions: [{ source: 'wikipedia', text: 'lead' }] }),
    });

    const merged = await resolveByIsbn(ISBN, d);

    expect(spies.wikipedia).toHaveBeenCalledWith({ title: 'Rayuela', author: 'Julio Cortázar' }, {});
    expect(merged!.descriptions[0]!.source).toBe('wikipedia');
    expect(merged!.sourcesHit).toContain('wikipedia');
  });

  it('busca sin autor cuando no hay autor', async () => {
    const { spies, deps: d } = deps({ ol: record('openlibrary', { title: 'Rayuela' }) });

    await resolveByIsbn(ISBN, d);

    expect(spies.wikipedia).toHaveBeenCalledWith({ title: 'Rayuela' }, {});
  });

  it('devuelve el libro igual si Wikipedia rechaza por el guard', async () => {
    // El guard devolviendo null es lo esperado y frecuente, no un error: el
    // libro sale con metadata y sin descripción.
    const { deps: d } = deps({ ol: record('openlibrary', { title: 'Rayuela' }), wiki: null });

    const merged = await resolveByIsbn(ISBN, d);

    expect(merged!.book.title).toBe('Rayuela');
    expect(merged!.descriptions).toEqual([]);
    expect(merged!.sourcesHit).toEqual(['openlibrary']);
  });
});
