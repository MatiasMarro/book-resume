/**
 * Open Library.
 *
 * Fuente **primaria** de metadata estructurada: es la única que da `work_key`
 * (agrupa ediciones), subjects y tapa en la misma pasada, y no pide API key.
 *
 * Hacen falta tres endpoints porque ninguno solo alcanza:
 *   /api/books  → título, autores, editorial, páginas, subjects, tapa
 *   /isbn/X     → idioma y el work key (la Books API no los trae)
 *   /works/Y    → la descripción, que vive a nivel obra y no de edición
 *
 * Los dos primeros van en paralelo; el tercero depende del work key.
 */
import { emptyRecord, type SourceRecord } from './types';
import { fetchJson, firstNonEmpty, parseYear, type FetchJsonOptions } from './http';

const BASE = 'https://openlibrary.org';

/** ISO 639-2 → 639-1 para los idiomas que aparecen en un catálogo hispano. */
const LANG_MAP: Record<string, string> = {
  spa: 'es',
  eng: 'en',
  por: 'pt',
  fre: 'fr',
  fra: 'fr',
  ger: 'de',
  deu: 'de',
  ita: 'it',
  cat: 'ca',
  lat: 'la',
};

type OlBooksEntry = {
  /** '/books/OL37016764M' — permite pedir la edición sin pasar por el redirect. */
  key?: string;
  title?: string;
  authors?: { name?: string }[];
  publishers?: { name?: string }[];
  publish_date?: string;
  number_of_pages?: number;
  subjects?: { name?: string }[];
  cover?: { small?: string; medium?: string; large?: string };
};

type OlEdition = {
  languages?: { key?: string }[];
  works?: { key?: string }[];
  number_of_pages?: number;
  publish_date?: string;
  title?: string;
};

type OlWork = {
  description?: string | { value?: string };
  subjects?: string[];
};

/** La descripción de un work viene como string plano o como {type,value}. */
export function readWorkDescription(description: OlWork['description']): string | undefined {
  if (typeof description === 'string') return firstNonEmpty(description);
  if (description && typeof description === 'object') return firstNonEmpty(description.value);
  return undefined;
}

/**
 * Open Library pega la fuente al final de muchas descripciones:
 *   "...texto real.\r\n\r\n----------\n\n[source][1]\n\n  [1]: https://..."
 * Es ruido para el LLM y gasta tokens.
 */
export function stripOlFooter(text: string): string {
  return text
    .split(/\r?\n\s*-{3,}\s*\r?\n/)[0]!
    .replace(/\r?\n\s*\[\d+\]:\s*https?:\/\/\S+/g, '')
    .replace(/\[([^\]]+)\]\[\d+\]/g, '$1')
    .trim();
}

export function normalizeLanguage(key: string | undefined): string | undefined {
  if (!key) return undefined;
  const code = key.replace('/languages/', '').trim().toLowerCase();
  return LANG_MAP[code] ?? (code.length > 0 ? code : undefined);
}

/**
 * Normaliza los tres payloads a un SourceRecord.
 *
 * Exportada aparte del fetch para poder testearla con fixtures reales sin red.
 * `booksResponse` es el objeto completo `{ "ISBN:x": {...} }`, tal como llega.
 */
export function normalizeOpenLibrary(
  isbn13: string,
  booksResponse: Record<string, OlBooksEntry> | null,
  edition: OlEdition | null,
  work: OlWork | null
): SourceRecord | null {
  const entry = booksResponse?.[`ISBN:${isbn13}`];

  // Sin título no hay libro: la Books API devuelve {} para lo que no conoce.
  const title = firstNonEmpty(entry?.title, edition?.title);
  if (!title) return null;

  const record = emptyRecord('openlibrary', { books: entry ?? null, edition, work });
  record.title = title;

  const authors = (entry?.authors ?? [])
    .map((a) => a.name?.trim())
    .filter((n): n is string => !!n && n.length > 0);
  if (authors.length > 0) record.authors = authors;

  const publisher = firstNonEmpty(...(entry?.publishers ?? []).map((p) => p.name));
  if (publisher) record.publisher = publisher;

  const year = parseYear(entry?.publish_date ?? edition?.publish_date);
  if (year !== undefined) record.publishedYear = year;

  const pageCount = entry?.number_of_pages ?? edition?.number_of_pages;
  if (typeof pageCount === 'number' && pageCount > 0) record.pageCount = pageCount;

  const language = normalizeLanguage(edition?.languages?.[0]?.key);
  if (language) record.language = language;

  // -L es ~500px de ancho: alcanza para la ficha y no infla la carga en 3G.
  const coverUrl = firstNonEmpty(entry?.cover?.large, entry?.cover?.medium, entry?.cover?.small);
  if (coverUrl) record.coverUrl = coverUrl;

  const workKey = firstNonEmpty(edition?.works?.[0]?.key);
  if (workKey) record.workKey = workKey;

  const description = readWorkDescription(work?.description);
  if (description) {
    const text = stripOlFooter(description);
    // Ojo: Open Library sirve descripciones en el idioma del que la cargó, no
    // en el de la edición. Marcamos el idioma del LIBRO como pista y que la
    // Fase 3 decida; no asumimos que coinciden.
    if (text.length > 0) record.descriptions.push({ source: 'openlibrary', text });
  }

  const subjects = [
    ...(entry?.subjects ?? []).map((s) => s.name).filter((s): s is string => !!s),
    ...(work?.subjects ?? []),
  ];
  record.subjects = [...new Set(subjects.map((s) => s.trim()).filter((s) => s.length > 0))];

  return record;
}

/** Falla suave: cualquier problema devuelve null y la cascada sigue. */
export async function fetchOpenLibrary(
  isbn13: string,
  options: FetchJsonOptions = {}
): Promise<SourceRecord | null> {
  const [booksResponse, editionByIsbn] = await Promise.all([
    fetchJson<Record<string, OlBooksEntry>>(
      `${BASE}/api/books?bibkeys=ISBN:${isbn13}&format=json&jscmd=data`,
      options
    ),
    // Ojo: /isbn/X.json responde 302 hacia /books/OLxxxM.json. El redirect se
    // sigue solo, pero suma un salto y es el eslabón que más se cae.
    fetchJson<OlEdition>(`${BASE}/isbn/${isbn13}.json`, options),
  ]);

  const entry = booksResponse?.[`ISBN:${isbn13}`];

  // Reintento por el camino directo cuando el redirect no contestó. Sin esto,
  // un timeout en /isbn/ nos deja sin idioma y sin work key —y por lo tanto
  // sin descripción— aunque la Books API haya respondido perfecto.
  const edition =
    editionByIsbn ??
    (entry?.key ? await fetchJson<OlEdition>(`${BASE}${entry.key}.json`, options) : null);

  const workKey = edition?.works?.[0]?.key;
  const work = workKey ? await fetchJson<OlWork>(`${BASE}${workKey}.json`, options) : null;

  return normalizeOpenLibrary(isbn13, booksResponse, edition, work);
}
