/**
 * Fusión de los SourceRecord que devolvió la cascada.
 *
 * El merge NO es "la primera fuente gana todo". Cada campo tiene su propio
 * orden de preferencia, porque cada fuente es buena en cosas distintas — ver
 * FIELD_PRIORITY abajo.
 */
import type { Book } from '@lector/shared';
import type { DescriptionCandidate, SourceName, SourceRecord } from '../sources/types';

/**
 * Prioridad **por campo**, no global.
 *
 * `description` es el caso que justifica todo este módulo: Google Books trae la
 * contratapa que escribió la editorial (texto de venta, ya sin spoilers), y
 * Open Library trae seguido el lead de Wikipedia copiado, que es enciclopédico
 * y a veces cuenta el argumento. Para la regla 3 conviene la contratapa.
 *
 * Para metadata estructurada el orden se invierte: Open Library tiene work key,
 * subjects reales y number_of_pages de la edición física.
 */
export const FIELD_PRIORITY = {
  title: ['openlibrary', 'googlebooks', 'wikipedia'],
  authors: ['openlibrary', 'googlebooks'],
  publisher: ['openlibrary', 'googlebooks'],
  publishedYear: ['openlibrary', 'googlebooks'],
  pageCount: ['openlibrary', 'googlebooks'],
  language: ['openlibrary', 'googlebooks'],
  coverUrl: ['openlibrary', 'googlebooks'],
  workKey: ['openlibrary'],
  description: ['googlebooks', 'openlibrary', 'wikipedia'],
} as const satisfies Record<string, readonly SourceName[]>;

export type MergedBook = {
  book: Book;
  /** Qué fuente ganó cada campo. Va a la respuesta y sirve para debuggear. */
  provenance: Partial<Record<keyof typeof FIELD_PRIORITY, SourceName>>;
  /** Ordenadas por FIELD_PRIORITY.description. La Fase 3 elige y sanitiza. */
  descriptions: DescriptionCandidate[];
  subjects: string[];
  sourcesHit: SourceName[];
};

/** Primer record — en orden de prioridad — que tenga el campo cargado. */
function pick<K extends keyof SourceRecord>(
  records: SourceRecord[],
  field: K,
  priority: readonly SourceName[]
): { value: NonNullable<SourceRecord[K]>; source: SourceName } | undefined {
  for (const name of priority) {
    const record = records.find((r) => r.source === name);
    if (!record) continue;

    const value = record[field];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === 'string' && value.trim().length === 0) continue;

    return { value: value as NonNullable<SourceRecord[K]>, source: name };
  }
  return undefined;
}

/**
 * Fusiona los records en un Book.
 *
 * Devuelve null si ninguna fuente aportó título — sin título no hay ficha que
 * mostrar y el endpoint tiene que dar 404.
 *
 * `isbn13` es el que pidió el usuario y **no** el que devuelven las fuentes:
 * medido contra Open Library, `identifiers.isbn_13` a veces trae un checksum
 * inválido (9788420471839 → responde 9788420471837). La clave de la caché
 * tiene que ser lo que el escáner leyó.
 */
export function mergeRecords(
  isbn13: string,
  records: SourceRecord[],
  now: number = Date.now()
): MergedBook | null {
  const hits = records.filter((r): r is SourceRecord => r !== null);
  if (hits.length === 0) return null;

  const title = pick(hits, 'title', FIELD_PRIORITY.title);
  if (!title) return null;

  const provenance: MergedBook['provenance'] = { title: title.source };

  const authors = pick(hits, 'authors', FIELD_PRIORITY.authors);
  const publisher = pick(hits, 'publisher', FIELD_PRIORITY.publisher);
  const publishedYear = pick(hits, 'publishedYear', FIELD_PRIORITY.publishedYear);
  const pageCount = pick(hits, 'pageCount', FIELD_PRIORITY.pageCount);
  const language = pick(hits, 'language', FIELD_PRIORITY.language);
  const coverUrl = pick(hits, 'coverUrl', FIELD_PRIORITY.coverUrl);
  const workKey = pick(hits, 'workKey', FIELD_PRIORITY.workKey);

  if (authors) provenance.authors = authors.source;
  if (publisher) provenance.publisher = publisher.source;
  if (publishedYear) provenance.publishedYear = publishedYear.source;
  if (pageCount) provenance.pageCount = pageCount.source;
  if (language) provenance.language = language.source;
  if (coverUrl) provenance.coverUrl = coverUrl.source;
  if (workKey) provenance.workKey = workKey.source;

  // Las descripciones NO se concatenan: se guardan separadas y ordenadas, con
  // su procedencia, porque la regla 3 filtra distinto según de dónde vengan.
  const descriptions = FIELD_PRIORITY.description.flatMap(
    (name) => hits.find((r) => r.source === name)?.descriptions ?? []
  );
  if (descriptions[0]) provenance.description = descriptions[0].source;

  const subjects = [...new Set(hits.flatMap((r) => r.subjects))];

  const book: Book = {
    isbn13,
    title: title.value as string,
    authors: (authors?.value as string[]) ?? [],
    fetchedAt: now,
    ...(publisher && { publisher: publisher.value as string }),
    ...(publishedYear && { publishedYear: publishedYear.value as number }),
    ...(pageCount && { pageCount: pageCount.value as number }),
    ...(language && { language: language.value as string }),
    ...(coverUrl && { coverUrl: coverUrl.value as string }),
    ...(workKey && { workKey: workKey.value as string }),
    // Crudo de cada fuente que respondió: permite re-enriquecer en la Fase 3
    // sin volver a pegarle a las APIs.
    rawSources: Object.fromEntries(hits.map((r) => [r.source, r.raw])),
  };

  return {
    book,
    provenance,
    descriptions,
    subjects,
    sourcesHit: hits.map((r) => r.source),
  };
}
