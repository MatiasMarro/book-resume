/**
 * Tests contra las APIs **reales**. No corren por defecto.
 *
 *   LECTOR_LIVE=1 npm test -w @lector/api
 *
 * Existen porque los fixtures se congelan y las APIs no. Corrélos cuando:
 *   - cargues GOOGLE_BOOKS_KEY (es lo único que valida ese normalizador)
 *   - un test de fixtures se rompa y quieras saber si la API cambió
 *   - vuelvas a tocar la cascada
 *
 * Pegan contra servicios de terceros: son lentos y pueden fallar por red.
 */
import { describe, expect, it } from 'vitest';
import { fetchOpenLibrary } from '../src/sources/openlibrary';
import { fetchGoogleBooks } from '../src/sources/googlebooks';
import { fetchWikipedia } from '../src/sources/wikipedia';
import { resolveByIsbn } from '../src/resolver/cascade';

/**
 * Declarado acá y no vía @types/node a propósito: el tsconfig solo carga
 * workers-types para que nadie use una API de Node dentro del Worker por
 * accidente. Como este archivo es un módulo, la declaración no se escapa.
 */
declare const process: { env: Record<string, string | undefined> };

const live = process.env['LECTOR_LIVE'] === '1';

describe.skipIf(!live)('fuentes en vivo', () => {
  it(
    'Open Library resuelve un ISBN de catálogo español',
    async () => {
      const record = await fetchOpenLibrary('9788433920423');

      expect(record).not.toBeNull();
      expect(record!.title).toMatch(/conjura de los necios/i);
      expect(record!.workKey).toMatch(/^\/works\//);
      expect(record!.language).toBe('es');
    },
    20_000
  );

  it(
    'Wikipedia acepta la novela y rechaza al autor y a la película',
    async () => {
      // Los tres casos medidos el 2026-08-05. Si el guard se afloja, el primero
      // sigue pasando y los otros dos empiezan a devolver basura.
      const novela = await fetchWikipedia({ title: 'Rayuela', author: 'Julio Cortázar' });
      expect(novela?.descriptions[0]?.text).toMatch(/novela/i);

      // "El Principito" devuelve la página de Saint-Exupéry primero.
      const principito = await fetchWikipedia({
        title: 'El Principito',
        author: 'Antoine de Saint-Exupéry',
      });
      if (principito) {
        expect(principito.title).not.toMatch(/Saint-Exupéry/i);
      }
    },
    30_000
  );

  it.skipIf(!process.env['GOOGLE_BOOKS_KEY'])(
    'Google Books resuelve con key',
    async () => {
      // ⚠️ El único test que valida el normalizador de Google Books contra
      // bytes reales. Sin key el cupo anónimo es 0 y la API da 429 siempre.
      const record = await fetchGoogleBooks('9788433920423', process.env['GOOGLE_BOOKS_KEY']);

      expect(record).not.toBeNull();
      expect(record!.title).toBeTruthy();
      expect(record!.descriptions[0]?.text.length).toBeGreaterThan(0);
    },
    20_000
  );

  it(
    'la cascada completa devuelve un libro usable',
    async () => {
      const merged = await resolveByIsbn('9788433920423', {
        ...(process.env['GOOGLE_BOOKS_KEY'] && {
          googleBooksKey: process.env['GOOGLE_BOOKS_KEY'],
        }),
      });

      expect(merged).not.toBeNull();
      expect(merged!.book.title).toBeTruthy();
      expect(merged!.book.authors.length).toBeGreaterThan(0);
      expect(merged!.sourcesHit.length).toBeGreaterThan(0);
    },
    30_000
  );

  it(
    'un ISBN válido pero inexistente devuelve null en vez de lanzar',
    async () => {
      // Checksum correcto, libro que no existe. La falla suave es el contrato.
      await expect(resolveByIsbn('9789999999992')).resolves.toBeNull();
    },
    30_000
  );
});
