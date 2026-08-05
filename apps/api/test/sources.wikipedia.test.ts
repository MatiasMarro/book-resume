/**
 * Fixtures capturadas de es.wikipedia.org el 2026-08-05.
 *
 * Los tres casos son reales y salieron de buscar libros del spike. Los dos
 * "malos" no son hipotéticos: son lo que la API devolvió de verdad.
 */
import { describe, expect, it } from 'vitest';
import {
  firstParagraph,
  matchesBook,
  normalizeTitle,
  normalizeWikipedia,
  titleSimilarity,
} from '../src/sources/wikipedia';

import summaryCienAnios from './fixtures/sources/wikipedia-summary-cien-anios.json';
import summaryAutor from './fixtures/sources/wikipedia-summary-autor.json';
import summaryPelicula from './fixtures/sources/wikipedia-summary-pelicula.json';

describe('normalizeTitle', () => {
  it('saca acentos, mayúsculas y puntuación', () => {
    expect(normalizeTitle('Cien AÑOS de soledad')).toBe('cien anos de soledad');
    expect(normalizeTitle('¿Sueñan los androides?')).toBe('suenan los androides');
  });

  it('saca el calificador entre paréntesis', () => {
    // '1984 (novela)' y '1984' tienen que comparar igual.
    expect(normalizeTitle('1984 (novela)')).toBe('1984');
    expect(normalizeTitle('Rayuela (novela)')).toBe('rayuela');
  });
});

describe('titleSimilarity', () => {
  it('1 para el mismo título con y sin calificador', () => {
    expect(titleSimilarity('Rayuela (novela)', 'Rayuela')).toBe(1);
    expect(titleSimilarity('1984 (novela)', '1984')).toBe(1);
  });

  it('alto para acentos y mayúsculas distintas', () => {
    expect(titleSimilarity('Cien años de soledad', 'CIEN ANOS DE SOLEDAD')).toBe(1);
  });

  it('bajo entre un libro y su autor', () => {
    expect(titleSimilarity('Antoine de Saint-Exupéry', 'El Principito')).toBeLessThan(0.5);
  });

  it('0 contra vacío', () => {
    expect(titleSimilarity('', 'Rayuela')).toBe(0);
  });
});

describe('firstParagraph', () => {
  it('devuelve solo el lead (regla 3: nada de secciones)', () => {
    const extract = 'Primer párrafo.\n\nSegundo párrafo con el final.';
    expect(firstParagraph(extract)).toBe('Primer párrafo.');
  });

  it('devuelve todo si es un solo párrafo', () => {
    expect(firstParagraph('Único párrafo.')).toBe('Único párrafo.');
  });
});

describe('matchesBook — el guard', () => {
  it('acepta el artículo que SÍ es la novela', () => {
    expect(matchesBook(summaryCienAnios as never, 'Cien años de soledad')).toEqual({ ok: true });
  });

  it('rechaza la página del AUTOR', () => {
    // Real: buscar "El Principito" devuelve primero a Saint-Exupéry.
    // Sin este guard, el resumen del libro sería su biografía.
    expect(matchesBook(summaryAutor as never, 'El Principito')).toEqual({
      ok: false,
      reason: 'no-es-libro',
    });
  });

  it('rechaza la página de la PELÍCULA', () => {
    // Real: buscar "The Da Vinci Code" devuelve el film de 2006.
    expect(matchesBook(summaryPelicula as never, 'The Da Vinci Code')).toEqual({
      ok: false,
      reason: 'no-es-libro',
    });
  });

  it('rechaza desambiguación', () => {
    expect(
      matchesBook({ type: 'disambiguation', title: 'Rayuela', extract: 'x' }, 'Rayuela')
    ).toEqual({ ok: false, reason: 'disambiguation' });
  });

  it('rechaza sin extracto', () => {
    expect(matchesBook({ type: 'standard', title: 'Rayuela' }, 'Rayuela')).toEqual({
      ok: false,
      reason: 'sin-extracto',
    });
  });

  it('rechaza un título que no se parece, aunque sea un libro', () => {
    expect(
      matchesBook(
        { type: 'standard', title: 'Pedro Páramo', description: 'novela de Juan Rulfo', extract: 'x' },
        'Cien años de soledad'
      )
    ).toEqual({ ok: false, reason: 'titulo-distinto' });
  });

  it('acepta un libro sin campo description si el título coincide', () => {
    // `description` es opcional en la API; su ausencia no puede bloquear.
    expect(
      matchesBook({ type: 'standard', title: 'Rayuela (novela)', extract: 'x' }, 'Rayuela')
    ).toEqual({ ok: true });
  });
});

describe('normalizeWikipedia', () => {
  it('devuelve solo el primer párrafo del extract', () => {
    const record = normalizeWikipedia(summaryCienAnios as never, 'Cien años de soledad');
    expect(record).not.toBeNull();
    expect(record!.descriptions).toHaveLength(1);
    expect(record!.descriptions[0]!.source).toBe('wikipedia');
    expect(record!.descriptions[0]!.text).toBe(
      firstParagraph((summaryCienAnios as { extract: string }).extract)
    );
  });

  it('no aporta metadata estructurada, solo descripción', () => {
    // Wikipedia no da ISBN, páginas ni editorial confiables: no las inventamos.
    const record = normalizeWikipedia(summaryCienAnios as never, 'Cien años de soledad');
    expect(record!.pageCount).toBeUndefined();
    expect(record!.publisher).toBeUndefined();
    expect(record!.subjects).toEqual([]);
  });

  it('null cuando el guard rechaza', () => {
    expect(normalizeWikipedia(summaryAutor as never, 'El Principito')).toBeNull();
    expect(normalizeWikipedia(null, 'Cualquiera')).toBeNull();
  });
});
