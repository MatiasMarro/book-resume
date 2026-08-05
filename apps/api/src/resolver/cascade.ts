/**
 * Resolver en cascada.
 *
 * ## Por qué este orden
 *
 * Medido el 2026-08-05 sobre los 30 ISBN de `scripts/isbns.txt`
 * (10 bestsellers traducidos, 10 de catálogo español, 10 de independientes
 * argentinas):
 *
 * | Fuente        | Resuelve | Descripción >200 chars | Notas                      |
 * |---------------|----------|------------------------|----------------------------|
 * | Open Library  | 50%      | 47% del total          | 94% de sus hits traen desc |
 * | Google Books  | —        | —                      | 429 sin key: cupo anónimo 0|
 * | Wikipedia     | —        | 87% de los que ya      | precisión baja, ver guard  |
 * |               |          | tienen título          |                            |
 *
 * De ahí la cascada:
 *
 * 1. **Open Library y Google Books en paralelo.** Son las dos únicas que
 *    resuelven desde un ISBN pelado. En paralelo porque el usuario está parado
 *    en el pasillo: dos round trips secuenciales son un segundo perdido.
 *
 * 2. **Wikipedia después y condicionada.** Necesita un título — no sabe de
 *    ISBN — así que no puede ir en la primera tanda. Y solo corre si las dos
 *    primeras no dieron ninguna descripción: es cara (2 requests) y su
 *    precisión es la más baja de las tres.
 *
 * ⚠️ El número que importa para la Fase 1 (cobertura con al menos una
 * descripción >200 chars) dio **50%**, por debajo de la línea roja de 60% del
 * PLAN.md — pero está medido **sin Google Books**, que es justo la fuente con
 * mejor catálogo en español. No es un go/no-go válido todavía.
 */
import type { SourceRecord } from '../sources/types';
import { fetchOpenLibrary } from '../sources/openlibrary';
import { fetchGoogleBooks } from '../sources/googlebooks';
import { fetchWikipedia } from '../sources/wikipedia';
import { mergeRecords, type MergedBook } from './merge';
import type { FetchJsonOptions } from '../sources/http';

export type CascadeDeps = {
  googleBooksKey?: string;
  fetchOptions?: FetchJsonOptions;
  /** Inyectables para testear la cascada sin red. */
  sources?: {
    openlibrary?: typeof fetchOpenLibrary;
    googlebooks?: typeof fetchGoogleBooks;
    wikipedia?: typeof fetchWikipedia;
  };
};

export async function resolveByIsbn(
  isbn13: string,
  deps: CascadeDeps = {}
): Promise<MergedBook | null> {
  const openlibrary = deps.sources?.openlibrary ?? fetchOpenLibrary;
  const googlebooks = deps.sources?.googlebooks ?? fetchGoogleBooks;
  const wikipedia = deps.sources?.wikipedia ?? fetchWikipedia;
  const options = deps.fetchOptions ?? {};

  // Etapa 1 — las que entienden ISBN, en paralelo.
  const [olResult, gbResult] = await Promise.all([
    openlibrary(isbn13, options),
    googlebooks(isbn13, deps.googleBooksKey, options),
  ]);

  const records: SourceRecord[] = [olResult, gbResult].filter(
    (r): r is SourceRecord => r !== null
  );

  if (records.length === 0) return null;

  // Etapa 2 — Wikipedia solo si todavía no hay con qué enriquecer.
  const hasDescription = records.some((r) => r.descriptions.length > 0);
  if (!hasDescription) {
    const title = records.find((r) => r.title)?.title;
    const author = records.find((r) => r.authors?.length)?.authors?.[0];

    if (title) {
      const wikiResult = await wikipedia({ title, ...(author && { author }) }, options);
      if (wikiResult) records.push(wikiResult);
    }
  }

  return mergeRecords(isbn13, records);
}
