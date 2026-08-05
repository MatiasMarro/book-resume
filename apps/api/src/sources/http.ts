/**
 * Cliente HTTP de las fuentes. **Nunca lanza.**
 *
 * Una fuente caída no puede tumbar el escaneo: el usuario está parado en el
 * pasillo con el libro en la mano. Todo error (red, timeout, 404, JSON roto)
 * se traduce a `null` y el resolver sigue con la fuente siguiente.
 */

/**
 * Cortamos antes que el usuario se aburra. La cascada corre en paralelo, así
 * que este número es el techo de UNA fuente, no del escaneo entero.
 *
 * Medido: openlibrary.org tarda 0,8–1,5s por endpoint desde acá, y `/isbn/X`
 * se come un redirect. 4s dejaba afuera picos normales y perdíamos la edición
 * en silencio; 5s da margen sin comerse el presupuesto de 5s del producto,
 * porque el camino caliente es la caché de D1 y no esto.
 */
const DEFAULT_TIMEOUT_MS = 5000;

/** Open Library y Wikipedia piden un UA identificable en sus ToS. */
const USER_AGENT = 'Lector/0.1 (PWA de recomendación de libros; +https://github.com/lector)';

export type FetchJsonOptions = {
  timeoutMs?: number;
  /** Inyectable en tests. Por defecto el `fetch` global del Worker. */
  fetchImpl?: typeof fetch;
};

export async function fetchJson<T = unknown>(
  url: string,
  options: FetchJsonOptions = {}
): Promise<T | null> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = options;

  // AbortSignal.timeout existe en workerd y en Node ≥18; con el fallback
  // manual el módulo sigue siendo testeable con cualquier fetch mockeado.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });

    if (!res.ok) return null;

    return (await res.json()) as T;
  } catch {
    // Red caída, timeout, JSON inválido: todos son "esta fuente no contestó".
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Devuelve el primer string no vacío. Las fuentes mandan '' y '   ' seguido. */
export function firstNonEmpty(...values: (string | undefined | null)[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

/**
 * Extrae un año de los formatos sueltos que usan las fuentes:
 * '2007', 'March 21, 2007', '2007-05-25', '[2007]', 'c1998'.
 */
export function parseYear(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value !== 'string') return undefined;

  const match = value.match(/(1[0-9]{3}|20[0-9]{2})/);
  if (!match) return undefined;

  return Number.parseInt(match[1]!, 10);
}
