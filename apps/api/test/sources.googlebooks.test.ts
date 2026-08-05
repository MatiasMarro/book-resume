/**
 * ⚠️ Estos fixtures están **reconstruidos**, no capturados: books.googleapis.com
 * da 429 a toda request sin key (cupo anónimo = 0). Ver el README de fixtures.
 * Recapturá y volvé a correr esto cuando cargues GOOGLE_BOOKS_KEY.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  fetchGoogleBooks,
  normalizeGoogleBooks,
  upgradeThumbnail,
} from '../src/sources/googlebooks';

import volumeCienAnios from './fixtures/sources/googlebooks-cien-anios.json';
import volumeVacio from './fixtures/sources/googlebooks-vacio.json';

describe('upgradeThumbnail', () => {
  it('pasa a https: un Worker en https no puede embeber http', () => {
    expect(upgradeThumbnail('http://books.google.com/books/content?id=x')).toBe(
      'https://books.google.com/books/content?id=x'
    );
  });

  it('saca el recorte de página curvada', () => {
    expect(upgradeThumbnail('https://x/y?id=1&edge=curl&zoom=1')).toBe('https://x/y?id=1&zoom=1');
  });
});

describe('normalizeGoogleBooks', () => {
  const record = normalizeGoogleBooks(volumeCienAnios as never);

  it('resuelve el primer volumen', () => {
    expect(record).not.toBeNull();
    expect(record!.source).toBe('googlebooks');
  });

  it('saca metadata básica', () => {
    expect(record!.title).toBe('Cien años de soledad');
    expect(record!.authors).toEqual(['Gabriel García Márquez']);
    expect(record!.publisher).toBe('Debolsillo');
    expect(record!.pageCount).toBe(496);
    expect(record!.language).toBe('es');
  });

  it('saca el año de un publishedDate completo', () => {
    expect(record!.publishedYear).toBe(2017);
  });

  it('marca la descripción con el idioma, porque es la contratapa de la editorial', () => {
    // A diferencia de Open Library, acá el idioma del texto sí coincide con el
    // del volumen: es la contratapa que cargó la editorial de esa edición.
    expect(record!.descriptions[0]!.source).toBe('googlebooks');
    expect(record!.descriptions[0]!.language).toBe('es');
  });

  it('usa categories como subjects', () => {
    expect(record!.subjects).toContain('Fiction / Literary');
  });

  it('pega el subtítulo al título', () => {
    const conSubtitulo = normalizeGoogleBooks({
      items: [{ volumeInfo: { title: 'Sapiens', subtitle: 'De animales a dioses' } }],
    } as never);
    expect(conSubtitulo!.title).toBe('Sapiens: De animales a dioses');
  });

  it('null cuando no hay resultados', () => {
    expect(normalizeGoogleBooks(volumeVacio as never)).toBeNull();
    expect(normalizeGoogleBooks(null)).toBeNull();
  });

  it('null si el volumen no tiene título', () => {
    expect(normalizeGoogleBooks({ items: [{ volumeInfo: {} }] } as never)).toBeNull();
  });
});

describe('fetchGoogleBooks', () => {
  it('ni intenta la request si no hay key: el cupo anónimo es cero', async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(fetchGoogleBooks('9788420471839', undefined, { fetchImpl })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('manda la key cuando existe', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(volumeCienAnios))
    );

    const record = await fetchGoogleBooks('9788420471839', 'KEY-DE-PRUEBA', { fetchImpl });

    expect(record!.title).toBe('Cien años de soledad');
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('key=KEY-DE-PRUEBA');
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('q=isbn:9788420471839');
  });

  it('devuelve null ante 429 en vez de lanzar', async () => {
    // El caso real medido: sin key la API contesta 429 siempre.
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{}', { status: 429 }));

    await expect(
      fetchGoogleBooks('9788420471839', 'KEY', { fetchImpl })
    ).resolves.toBeNull();
  });
});
