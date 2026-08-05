/**
 * Google Books.
 *
 * Fuente **preferida para la descripción**: el campo `description` es la
 * contratapa que cargó la editorial, o sea texto ya escrito para vender el
 * libro sin spoilearlo (CLAUDE.md, regla 3). Por eso gana sobre Open Library
 * en ese campo aunque Open Library gane en metadata estructurada.
 *
 * ⚠️ Requiere API key. El cupo anónimo de books.googleapis.com es **cero**:
 * sin `GOOGLE_BOOKS_KEY` toda request vuelve 429. Sin key esta fuente se
 * saltea en silencio y la cascada sigue.
 */
import { emptyRecord, type SourceRecord, type TitleAuthorQuery } from './types';
import { fetchJson, firstNonEmpty, parseYear, type FetchJsonOptions } from './http';

const BASE = 'https://www.googleapis.com/books/v1/volumes';

type GbVolumeInfo = {
  title?: string;
  subtitle?: string;
  authors?: string[];
  publisher?: string;
  publishedDate?: string;
  description?: string;
  pageCount?: number;
  categories?: string[];
  language?: string;
  imageLinks?: { thumbnail?: string; smallThumbnail?: string };
};

type GbResponse = {
  totalItems?: number;
  items?: { volumeInfo?: GbVolumeInfo }[];
};

/**
 * Las miniaturas vienen en http y con `zoom=1` (~128px). Las servimos en https
 * — un Worker en https no puede embeber http sin mixed content — y sin el
 * recorte de bordes.
 */
export function upgradeThumbnail(url: string): string {
  return url.replace(/^http:\/\//, 'https://').replace(/&edge=curl/g, '');
}

export function normalizeGoogleBooks(response: GbResponse | null): SourceRecord | null {
  const info = response?.items?.[0]?.volumeInfo;
  if (!info) return null;

  const title = firstNonEmpty(info.title);
  if (!title) return null;

  const record = emptyRecord('googlebooks', response);

  // El subtítulo va aparte; para la ficha el título completo es más útil.
  const subtitle = firstNonEmpty(info.subtitle);
  record.title = subtitle ? `${title}: ${subtitle}` : title;

  const authors = (info.authors ?? []).map((a) => a.trim()).filter((a) => a.length > 0);
  if (authors.length > 0) record.authors = authors;

  const publisher = firstNonEmpty(info.publisher);
  if (publisher) record.publisher = publisher;

  const year = parseYear(info.publishedDate);
  if (year !== undefined) record.publishedYear = year;

  if (typeof info.pageCount === 'number' && info.pageCount > 0) record.pageCount = info.pageCount;

  const language = firstNonEmpty(info.language);
  if (language) record.language = language;

  const thumbnail = firstNonEmpty(info.imageLinks?.thumbnail, info.imageLinks?.smallThumbnail);
  if (thumbnail) record.coverUrl = upgradeThumbnail(thumbnail);

  const description = firstNonEmpty(info.description);
  if (description) {
    record.descriptions.push({
      source: 'googlebooks',
      text: description,
      language: record.language,
    });
  }

  record.subjects = [
    ...new Set((info.categories ?? []).map((c) => c.trim()).filter((c) => c.length > 0)),
  ];

  return record;
}

function withKey(url: string, apiKey: string | undefined): string {
  return apiKey ? `${url}&key=${encodeURIComponent(apiKey)}` : url;
}

export async function fetchGoogleBooks(
  isbn13: string,
  apiKey: string | undefined,
  options: FetchJsonOptions = {}
): Promise<SourceRecord | null> {
  // Sin key el cupo es 0: ahorramos el round trip que sabemos que da 429.
  if (!apiKey) return null;

  const response = await fetchJson<GbResponse>(
    withKey(`${BASE}?q=isbn:${isbn13}`, apiKey),
    options
  );

  return normalizeGoogleBooks(response);
}

/**
 * Búsqueda por título+autor. La usa el resolver cuando el ISBN no resuelve en
 * ninguna fuente pero ya tenemos un título (y, en Fase 6, POST /api/identify).
 */
export async function searchGoogleBooks(
  query: TitleAuthorQuery,
  apiKey: string | undefined,
  options: FetchJsonOptions = {}
): Promise<SourceRecord | null> {
  if (!apiKey) return null;

  const terms = [`intitle:${query.title}`];
  if (query.author) terms.push(`inauthor:${query.author}`);

  const response = await fetchJson<GbResponse>(
    withKey(`${BASE}?q=${encodeURIComponent(terms.join('+'))}&maxResults=1`, apiKey),
    options
  );

  return normalizeGoogleBooks(response);
}
