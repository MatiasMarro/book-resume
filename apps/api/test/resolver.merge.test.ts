import { describe, expect, it } from 'vitest';
import { mergeRecords } from '../src/resolver/merge';
import { emptyRecord, type SourceRecord } from '../src/sources/types';

const ISBN = '9788420471839';
const NOW = 1_700_000_000_000;

function ol(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return { ...emptyRecord('openlibrary', { fuente: 'ol' }), title: 'Título OL', ...overrides };
}

function gb(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return { ...emptyRecord('googlebooks', { fuente: 'gb' }), title: 'Título GB', ...overrides };
}

function wiki(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return { ...emptyRecord('wikipedia', { fuente: 'wk' }), title: 'Título WK', ...overrides };
}

describe('mergeRecords — sin datos', () => {
  it('null con la lista vacía', () => {
    expect(mergeRecords(ISBN, [], NOW)).toBeNull();
  });

  it('null si ninguna fuente aportó título', () => {
    // Sin título no hay ficha que mostrar: el endpoint tiene que dar 404.
    const sinTitulo = { ...emptyRecord('openlibrary', {}), pageCount: 300 };
    expect(mergeRecords(ISBN, [sinTitulo], NOW)).toBeNull();
  });
});

describe('mergeRecords — clave de la caché', () => {
  it('usa el ISBN pedido, no el que devuelven las fuentes', () => {
    // Medido: Open Library devuelve identifiers.isbn_13 = 9788420471837 para
    // este libro, con checksum inválido. Cachear por ese valor rompería el
    // siguiente escaneo del mismo libro.
    const merged = mergeRecords(ISBN, [ol({ raw: { identifiers: { isbn_13: ['9788420471837'] } } })], NOW);
    expect(merged!.book.isbn13).toBe(ISBN);
  });

  it('sella fetchedAt con el reloj que se le pasa', () => {
    expect(mergeRecords(ISBN, [ol()], NOW)!.book.fetchedAt).toBe(NOW);
  });
});

describe('mergeRecords — prioridad por campo', () => {
  it('metadata estructurada: gana Open Library', () => {
    const merged = mergeRecords(
      ISBN,
      [
        gb({ pageCount: 496, publisher: 'Debolsillo', language: 'es' }),
        ol({ pageCount: 609, publisher: 'Alfaguara', language: 'es' }),
      ],
      NOW
    );

    // 609 es el conteo de la edición física; 496 el del ebook de Google.
    expect(merged!.book.pageCount).toBe(609);
    expect(merged!.book.publisher).toBe('Alfaguara');
    expect(merged!.provenance.pageCount).toBe('openlibrary');
  });

  it('descripción: gana Google Books aunque Open Library vaya primero', () => {
    // La inversión que justifica todo el módulo: la contratapa de la editorial
    // está escrita para vender sin spoilear; el texto de OL suele ser el lead
    // enciclopédico de Wikipedia copiado.
    const merged = mergeRecords(
      ISBN,
      [
        ol({ descriptions: [{ source: 'openlibrary', text: 'Texto enciclopédico.' }] }),
        gb({ descriptions: [{ source: 'googlebooks', text: 'Contratapa.' }] }),
      ],
      NOW
    );

    expect(merged!.descriptions[0]!.source).toBe('googlebooks');
    expect(merged!.provenance.description).toBe('googlebooks');
  });

  it('el orden del array no cambia el resultado', () => {
    const a = mergeRecords(ISBN, [ol({ pageCount: 609 }), gb({ pageCount: 496 })], NOW);
    const b = mergeRecords(ISBN, [gb({ pageCount: 496 }), ol({ pageCount: 609 })], NOW);

    expect(a!.book.pageCount).toBe(b!.book.pageCount);
    expect(a!.book.title).toBe(b!.book.title);
  });

  it('cae a la fuente siguiente cuando la preferida no tiene el campo', () => {
    const merged = mergeRecords(ISBN, [ol({ publisher: undefined }), gb({ publisher: 'Debolsillo' })], NOW);

    expect(merged!.book.publisher).toBe('Debolsillo');
    expect(merged!.provenance.publisher).toBe('googlebooks');
  });

  it('trata vacíos como ausentes: string vacío y array vacío no ganan', () => {
    const merged = mergeRecords(
      ISBN,
      [ol({ publisher: '   ', authors: [] }), gb({ publisher: 'Debolsillo', authors: ['García Márquez'] })],
      NOW
    );

    expect(merged!.book.publisher).toBe('Debolsillo');
    expect(merged!.book.authors).toEqual(['García Márquez']);
  });

  it('workKey solo puede venir de Open Library', () => {
    // Es un identificador propio de OL: ninguna otra fuente lo conoce.
    const merged = mergeRecords(ISBN, [gb({ workKey: '/works/INVENTADO' })], NOW);
    expect(merged!.book.workKey).toBeUndefined();
  });
});

describe('mergeRecords — descripciones', () => {
  it('las guarda separadas y ordenadas, sin concatenar', () => {
    // La regla 3 filtra distinto según la procedencia: Wikipedia solo el lead,
    // Google Books entero. Concatenar perdería esa distinción.
    const merged = mergeRecords(
      ISBN,
      [
        wiki({ descriptions: [{ source: 'wikipedia', text: 'Lead de wiki.' }] }),
        ol({ descriptions: [{ source: 'openlibrary', text: 'Texto de OL.' }] }),
        gb({ descriptions: [{ source: 'googlebooks', text: 'Contratapa.' }] }),
      ],
      NOW
    );

    expect(merged!.descriptions.map((d) => d.source)).toEqual([
      'googlebooks',
      'openlibrary',
      'wikipedia',
    ]);
  });

  it('lista vacía cuando ninguna fuente describió nada', () => {
    const merged = mergeRecords(ISBN, [ol()], NOW);
    expect(merged!.descriptions).toEqual([]);
    expect(merged!.provenance.description).toBeUndefined();
  });
});

describe('mergeRecords — subjects y crudo', () => {
  it('une subjects de todas las fuentes sin duplicar', () => {
    const merged = mergeRecords(
      ISBN,
      [ol({ subjects: ['Fiction', 'magic realism'] }), gb({ subjects: ['Fiction', 'Literary'] })],
      NOW
    );

    expect(merged!.subjects).toEqual(['Fiction', 'magic realism', 'Literary']);
  });

  it('guarda el crudo de cada fuente bajo su nombre', () => {
    const merged = mergeRecords(ISBN, [ol(), gb()], NOW);

    expect(merged!.book.rawSources).toEqual({
      openlibrary: { fuente: 'ol' },
      googlebooks: { fuente: 'gb' },
    });
  });

  it('reporta qué fuentes pegaron', () => {
    expect(mergeRecords(ISBN, [ol(), gb()], NOW)!.sourcesHit).toEqual([
      'openlibrary',
      'googlebooks',
    ]);
  });
});

describe('mergeRecords — una sola fuente', () => {
  it('funciona con solo Open Library (el caso del 50% medido)', () => {
    const merged = mergeRecords(
      ISBN,
      [ol({ authors: ['García Márquez'], pageCount: 609, descriptions: [{ source: 'openlibrary', text: 'x' }] })],
      NOW
    );

    expect(merged!.book.title).toBe('Título OL');
    expect(merged!.sourcesHit).toEqual(['openlibrary']);
  });

  it('funciona con solo Wikipedia', () => {
    const merged = mergeRecords(ISBN, [wiki({ descriptions: [{ source: 'wikipedia', text: 'x' }] })], NOW);

    expect(merged!.book.title).toBe('Título WK');
    expect(merged!.book.authors).toEqual([]);
  });
});
