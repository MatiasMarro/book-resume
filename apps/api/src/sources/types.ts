/**
 * Tipo normalizado que devuelve toda fuente.
 *
 * Cada fuente traduce su payload a esta forma; el resolver no sabe nada de
 * Open Library ni de Google Books. Agregar una fuente nueva = un archivo nuevo
 * que devuelva un SourceRecord.
 */

export const SOURCE_NAMES = ['openlibrary', 'googlebooks', 'wikipedia'] as const;

export type SourceName = (typeof SOURCE_NAMES)[number];

/**
 * Un texto descriptivo con su procedencia.
 *
 * La procedencia importa: la regla 3 de CLAUDE.md permite la contratapa de
 * Google Books entera, pero solo el primer párrafo de Wikipedia. `sanitize.ts`
 * (Fase 3) filtra según este campo, así que **no fusiones descripciones de
 * distintas fuentes en un solo string**.
 */
export type DescriptionCandidate = {
  source: SourceName;
  text: string;
  /** Idioma del texto, no del libro. Open Library mezcla idiomas seguido. */
  language?: string;
};

export type SourceRecord = {
  source: SourceName;

  title?: string;
  authors?: string[];
  publisher?: string;
  publishedYear?: number;
  pageCount?: number;
  /** Código ISO del idioma del libro, ej. 'es'. */
  language?: string;
  coverUrl?: string;
  /** Work de Open Library ('/works/OL274505W'): agrupa ediciones. */
  workKey?: string;

  descriptions: DescriptionCandidate[];
  /** Subjects / BISAC / categories, sin normalizar entre fuentes. */
  subjects: string[];

  /** Payload crudo tal cual, para re-enriquecer sin volver a fetchear. */
  raw: unknown;
};

/** Lo que necesita una fuente para buscar sin ISBN (Google Books, Wikipedia). */
export type TitleAuthorQuery = {
  title: string;
  author?: string;
};

/** Base vacía, para que los normalizadores solo seteen lo que encontraron. */
export function emptyRecord(source: SourceName, raw: unknown): SourceRecord {
  return { source, descriptions: [], subjects: [], raw };
}
