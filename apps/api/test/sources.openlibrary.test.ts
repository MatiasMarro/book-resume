/**
 * Fixtures capturadas de openlibrary.org el 2026-08-05. Si un test de acá se
 * rompe, primero verificá si la API cambió de forma — no ajustes el esperado.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  fetchOpenLibrary,
  normalizeLanguage,
  normalizeOpenLibrary,
  readWorkDescription,
  stripOlFooter,
} from '../src/sources/openlibrary';

import booksCienAnios from './fixtures/sources/openlibrary-books-cien-anios.json';
import editionCienAnios from './fixtures/sources/openlibrary-edition-cien-anios.json';
import workCienAnios from './fixtures/sources/openlibrary-work-cien-anios.json';
import booksPrincipito from './fixtures/sources/openlibrary-books-principito.json';
import editionPrincipito from './fixtures/sources/openlibrary-edition-principito.json';
import workPrincipito from './fixtures/sources/openlibrary-work-principito.json';
import booksVacio from './fixtures/sources/openlibrary-books-vacio.json';

const CIEN_ANIOS = '9788420471839';
const PRINCIPITO = '9788498381498';

describe('readWorkDescription', () => {
  it('lee la variante string plano', () => {
    expect(readWorkDescription('texto directo')).toBe('texto directo');
  });

  it('lee la variante { type, value }', () => {
    // Open Library sirve las dos formas para el mismo campo, sin avisar.
    expect(readWorkDescription({ value: 'texto envuelto' })).toBe('texto envuelto');
  });

  it('devuelve undefined para vacío, ausente o forma rara', () => {
    expect(readWorkDescription(undefined)).toBeUndefined();
    expect(readWorkDescription('')).toBeUndefined();
    expect(readWorkDescription('   ')).toBeUndefined();
    expect(readWorkDescription({})).toBeUndefined();
  });
});

describe('stripOlFooter', () => {
  it('corta el bloque de fuente que Open Library pega al final', () => {
    const raw =
      'La novela real.\r\n\r\n----------\n\n[source][1]\n\n  [1]: https://es.wikipedia.org/wiki/X';
    expect(stripOlFooter(raw)).toBe('La novela real.');
  });

  it('deja el texto intacto cuando no hay footer', () => {
    expect(stripOlFooter('Solo el texto.')).toBe('Solo el texto.');
  });

  it('desarma links de referencia sueltos sin comerse la palabra', () => {
    expect(stripOlFooter('Ver [Wikipedia][2] para más.')).toBe('Ver Wikipedia para más.');
  });
});

describe('normalizeLanguage', () => {
  it('mapea ISO 639-2 a 639-1', () => {
    expect(normalizeLanguage('/languages/spa')).toBe('es');
    expect(normalizeLanguage('/languages/eng')).toBe('en');
    expect(normalizeLanguage('/languages/fre')).toBe('fr');
  });

  it('deja pasar un código desconocido en vez de perderlo', () => {
    expect(normalizeLanguage('/languages/que')).toBe('que');
  });

  it('undefined cuando no hay idioma', () => {
    expect(normalizeLanguage(undefined)).toBeUndefined();
    expect(normalizeLanguage('/languages/')).toBeUndefined();
  });
});

describe('normalizeOpenLibrary — Cien años de soledad (fixture real)', () => {
  const record = normalizeOpenLibrary(
    CIEN_ANIOS,
    booksCienAnios as never,
    editionCienAnios as never,
    workCienAnios as never
  );

  it('resuelve', () => {
    expect(record).not.toBeNull();
  });

  it('saca título y autor', () => {
    expect(record!.title).toBe('Cien años de soledad');
    expect(record!.authors).toEqual(['Gabriel García Márquez']);
  });

  it('saca editorial, año y páginas', () => {
    expect(record!.publisher).toBe('Alfaguara');
    expect(record!.publishedYear).toBe(2007);
    expect(record!.pageCount).toBe(609);
  });

  it('saca el idioma de la edición, no de la Books API', () => {
    // La Books API no trae idioma; sale de /isbn/X.json → languages[0].key.
    expect(record!.language).toBe('es');
  });

  it('prefiere la tapa grande', () => {
    expect(record!.coverUrl).toContain('-L.jpg');
  });

  it('saca el work key, que es lo que agrupa ediciones', () => {
    expect(record!.workKey).toBe('/works/OL274505W');
  });

  it('saca la descripción del work con procedencia', () => {
    expect(record!.descriptions).toHaveLength(1);
    expect(record!.descriptions[0]!.source).toBe('openlibrary');
    expect(record!.descriptions[0]!.text.length).toBeGreaterThan(200);
  });

  it('junta subjects de la edición y del work, sin duplicados', () => {
    expect(record!.subjects).toContain('magic realism');
    expect(new Set(record!.subjects).size).toBe(record!.subjects.length);
  });

  it('conserva el crudo de las tres llamadas para re-enriquecer sin re-fetch', () => {
    expect(record!.raw).toHaveProperty('books');
    expect(record!.raw).toHaveProperty('edition');
    expect(record!.raw).toHaveProperty('work');
  });
});

describe('normalizeOpenLibrary — El Principito (description como objeto)', () => {
  const record = normalizeOpenLibrary(
    PRINCIPITO,
    booksPrincipito as never,
    editionPrincipito as never,
    workPrincipito as never
  );

  it('lee la description envuelta en { type, value }', () => {
    expect(record!.descriptions[0]!.text.length).toBeGreaterThan(200);
  });

  it('NO afirma que la descripción esté en el idioma del libro', () => {
    // Caso real: edición en español, descripción cargada en francés. Marcar
    // `language: 'es'` acá haría que la Fase 3 arme el prompt con un supuesto
    // falso, así que el campo queda sin setear.
    expect(record!.descriptions[0]!.language).toBeUndefined();
  });
});

describe('normalizeOpenLibrary — sin datos', () => {
  it('devuelve null cuando la Books API responde {}', () => {
    // Lo que pasó con los 15 ISBN de editoriales independientes argentinas.
    expect(normalizeOpenLibrary('9789877383195', booksVacio as never, null, null)).toBeNull();
  });

  it('devuelve null si todo viene null', () => {
    expect(normalizeOpenLibrary(CIEN_ANIOS, null, null, null)).toBeNull();
  });

  it('resuelve con solo la edición, si tiene título', () => {
    const record = normalizeOpenLibrary(CIEN_ANIOS, null, editionCienAnios as never, null);
    expect(record?.title).toBeTruthy();
    expect(record?.descriptions).toHaveLength(0);
  });
});

describe('fetchOpenLibrary — resiliencia del camino de la edición', () => {
  /** Respuestas por URL; lo que no esté listado falla como si fuera timeout. */
  function fakeFetch(byUrl: Record<string, unknown>) {
    return vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      const match = Object.keys(byUrl).find((k) => url.includes(k));
      if (!match) return new Response('nope', { status: 500 });
      return new Response(JSON.stringify(byUrl[match]));
    });
  }

  it('cae al key de la Books API cuando /isbn/ no contesta', async () => {
    // Caso observado en vivo: /isbn/X.json se pasa del timeout (se come un
    // redirect 302). Sin este fallback perdemos idioma Y work key, y sin work
    // key no hay descripción — con la Books API respondiendo perfecto.
    const fetchImpl = fakeFetch({
      '/api/books': { [`ISBN:${CIEN_ANIOS}`]: booksCienAnios[`ISBN:${CIEN_ANIOS}`] },
      '/books/OL17228124M.json': editionCienAnios,
      '/works/OL274505W.json': workCienAnios,
    });

    const record = await fetchOpenLibrary(CIEN_ANIOS, { fetchImpl });

    expect(record!.language).toBe('es');
    expect(record!.workKey).toBe('/works/OL274505W');
    expect(record!.descriptions).toHaveLength(1);
    // El orden importa: primero el redirect, y recién ahí el camino directo.
    expect(String(fetchImpl.mock.calls[1]![0])).toContain('/isbn/');
    expect(fetchImpl.mock.calls.some((c) => String(c[0]).includes('/books/OL17228124M'))).toBe(true);
  });

  it('no gasta el request extra si /isbn/ ya contestó', async () => {
    const fetchImpl = fakeFetch({
      '/api/books': { [`ISBN:${CIEN_ANIOS}`]: booksCienAnios[`ISBN:${CIEN_ANIOS}`] },
      [`/isbn/${CIEN_ANIOS}.json`]: editionCienAnios,
      '/works/OL274505W.json': workCienAnios,
    });

    await fetchOpenLibrary(CIEN_ANIOS, { fetchImpl });

    expect(fetchImpl.mock.calls.some((c) => String(c[0]).includes('/books/OL17228124M'))).toBe(
      false
    );
  });

  it('devuelve null si se cae todo', async () => {
    const fetchImpl = fakeFetch({});
    await expect(fetchOpenLibrary(CIEN_ANIOS, { fetchImpl })).resolves.toBeNull();
  });
});
