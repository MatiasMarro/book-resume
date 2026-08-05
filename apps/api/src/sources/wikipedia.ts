/**
 * Wikipedia ES.
 *
 * Fuente de **último recurso** y la más peligrosa de las tres, por dos motivos
 * medidos contra la API real:
 *
 * 1. **Precisión baja.** La búsqueda devuelve seguido el artículo equivocado:
 *    "El Principito" → *Antoine de Saint-Exupéry* (el autor),
 *    "The Da Vinci Code" → *El código Da Vinci (película)*.
 *    Resumir la biografía del autor como si fuera el libro es peor que no tener
 *    descripción. Por eso hay un guard y no se acepta el primer resultado.
 *
 * 2. **Spoilers.** Los artículos tienen sección "Argumento". Acá tomamos solo
 *    el primer párrafo del extract del endpoint `summary` — que es el lead —
 *    tal como manda la regla 3 de CLAUDE.md.
 */
import { emptyRecord, type SourceRecord, type TitleAuthorQuery } from './types';
import { fetchJson, firstNonEmpty, type FetchJsonOptions } from './http';

const SEARCH = 'https://es.wikipedia.org/w/rest.php/v1/search/page';
const SUMMARY = 'https://es.wikipedia.org/api/rest_v1/page/summary';

/** Cuántos candidatos mirar antes de rendirse. */
const MAX_CANDIDATES = 3;

/** Umbral de similitud de título. Calibrado contra los fixtures capturados. */
const MIN_TITLE_SIMILARITY = 0.5;

/**
 * `description` de artículos que NO son la obra. Medido: la búsqueda cae en el
 * autor o en la adaptación mucho más seguido de lo esperable.
 */
const NOT_A_BOOK =
  /^(escritor|escritora|novelista|poeta|poetisa|autor|autora|ensayista|dramaturgo|dramaturga|filósofo|filósofa|periodista|película|film|largometraje|serie|serie de televisión|álbum|banda|grupo musical|videojuego|obra de teatro|ópera|cantante|músico|actor|actriz|director)/i;

type WikiSearchResponse = {
  pages?: { key?: string; title?: string }[];
};

type WikiSummary = {
  type?: string;
  title?: string;
  description?: string;
  extract?: string;
  lang?: string;
  content_urls?: { desktop?: { page?: string } };
};

/** Minúsculas, sin acentos, sin puntuación: para comparar títulos. */
export function normalizeTitle(text: string): string {
  return text
    .normalize('NFD')
    // Escapes explícitos: los combining marks literales son invisibles en el
    // editor y cualquier reformateo los come sin que nadie lo note.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ') // "1984 (novela)" → "1984"
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Coeficiente de Dice sobre conjuntos de palabras.
 *
 * Elegido sobre Levenshtein a propósito: los títulos difieren por traducción y
 * subtítulo ("Cien años de soledad" vs "Cien años de soledad (novela)"), no por
 * errores de tipeo.
 */
export function titleSimilarity(a: string, b: string): number {
  const wordsA = new Set(normalizeTitle(a).split(' ').filter(Boolean));
  const wordsB = new Set(normalizeTitle(b).split(' ').filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let shared = 0;
  for (const word of wordsA) if (wordsB.has(word)) shared++;

  return (2 * shared) / (wordsA.size + wordsB.size);
}

/** Solo el lead: el primer párrafo del extract (regla 3). */
export function firstParagraph(extract: string): string {
  return extract.split(/\n\s*\n/)[0]!.trim();
}

export type MatchRejection = 'disambiguation' | 'sin-extracto' | 'no-es-libro' | 'titulo-distinto';

export type MatchVerdict = { ok: true } | { ok: false; reason: MatchRejection };

/**
 * Decide si un artículo es realmente el libro que buscamos.
 *
 * Es deliberadamente estricto: un falso negativo cuesta una descripción, un
 * falso positivo mete la biografía del autor en el resumen del libro.
 */
export function matchesBook(summary: WikiSummary, expectedTitle: string): MatchVerdict {
  if (summary.type === 'disambiguation') return { ok: false, reason: 'disambiguation' };

  const extract = firstNonEmpty(summary.extract);
  if (!extract) return { ok: false, reason: 'sin-extracto' };

  const description = summary.description ?? '';
  if (NOT_A_BOOK.test(description.trim())) return { ok: false, reason: 'no-es-libro' };

  const pageTitle = firstNonEmpty(summary.title);
  if (!pageTitle) return { ok: false, reason: 'titulo-distinto' };

  if (titleSimilarity(pageTitle, expectedTitle) < MIN_TITLE_SIMILARITY) {
    return { ok: false, reason: 'titulo-distinto' };
  }

  return { ok: true };
}

export function normalizeWikipedia(
  summary: WikiSummary | null,
  expectedTitle: string
): SourceRecord | null {
  if (!summary) return null;
  if (!matchesBook(summary, expectedTitle).ok) return null;

  const record = emptyRecord('wikipedia', summary);
  record.title = firstNonEmpty(summary.title);
  record.descriptions.push({
    source: 'wikipedia',
    text: firstParagraph(summary.extract!),
    language: summary.lang ?? 'es',
  });

  return record;
}

/**
 * Busca el artículo del libro. Devuelve null si ningún candidato pasa el guard
 * — que es el caso correcto y frecuente, no un error.
 */
export async function fetchWikipedia(
  query: TitleAuthorQuery,
  options: FetchJsonOptions = {}
): Promise<SourceRecord | null> {
  const terms = query.author ? `${query.title} ${query.author}` : query.title;

  // Ojo: `search/page` (full text). `search/title` es autocompletado por
  // prefijo y devuelve vacío para casi toda consulta "título autor".
  const search = await fetchJson<WikiSearchResponse>(
    `${SEARCH}?q=${encodeURIComponent(terms)}&limit=${MAX_CANDIDATES}`,
    options
  );

  const pages = (search?.pages ?? []).slice(0, MAX_CANDIDATES);

  for (const page of pages) {
    if (!page.key) continue;

    const summary = await fetchJson<WikiSummary>(
      `${SUMMARY}/${encodeURIComponent(page.key)}`,
      options
    );
    if (!summary) continue;

    const record = normalizeWikipedia(summary, query.title);
    if (record) return record;
  }

  return null;
}
