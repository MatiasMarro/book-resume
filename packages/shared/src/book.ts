import { z } from 'zod';

/**
 * Metadata objetiva de un libro, tal como la devuelven las fuentes públicas
 * (Open Library / Google Books / Wikidata). Espeja la tabla `books`.
 *
 * Las columnas NULL de D1 se mapean a campos ausentes, no a `null`.
 */
export const BookSchema = z.object({
  isbn13: z.string().regex(/^\d{13}$/, 'ISBN-13 son 13 dígitos'),
  title: z.string().min(1),
  authors: z.array(z.string().min(1)),
  publisher: z.string().optional(),
  publishedYear: z.number().int().optional(),
  pageCount: z.number().int().positive().optional(),
  /** Código de idioma, ej. 'es', 'en'. */
  language: z.string().optional(),
  coverUrl: z.string().url().optional(),
  /** Work de Open Library: agrupa todas las ediciones de la misma obra. */
  workKey: z.string().optional(),
  /** Payload crudo de las fuentes, para re-enriquecer sin volver a fetchear. */
  rawSources: z.unknown().optional(),
  /** Epoch en milisegundos. */
  fetchedAt: z.number().int(),
});

export type Book = z.infer<typeof BookSchema>;
