/**
 * Validación y normalización de ISBN-13.
 *
 * El escáner lee un EAN-13 de la contratapa (CLAUDE.md, regla 1), así que este
 * módulo es la primera línea de defensa: un dígito mal leído por la cámara tiene
 * ~90% de probabilidad de romper el checksum y lo cortamos acá, antes de gastar
 * una request contra las fuentes.
 */

/** Prefijos GS1 que identifican un EAN-13 como libro (Bookland). */
const BOOK_PREFIXES = ['978', '979'];

/**
 * Deja solo dígitos. Los códigos escaneados y los tipeados a mano vienen con
 * guiones y espacios ("978-84-204-7183-9").
 */
export function normalizeIsbn(input: string): string {
  return input.replace(/[\s-]/g, '');
}

/**
 * Dígito verificador de un ISBN-13: pesos alternados 1 y 3 sobre los primeros
 * 12 dígitos.
 */
export function isbn13CheckDigit(first12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    // El charAt siempre existe: el llamador ya validó el largo.
    const digit = first12.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  return (10 - (sum % 10)) % 10;
}

export type IsbnValidation =
  | { valid: true; isbn13: string }
  | { valid: false; reason: 'formato' | 'prefijo' | 'checksum' };

/**
 * Valida un ISBN-13 completo, checksum incluido.
 *
 * No acepta ISBN-10: el código de barras de un libro moderno siempre es EAN-13.
 * Si alguna vez hace falta, la conversión va acá y no en el endpoint.
 */
export function validateIsbn13(input: string): IsbnValidation {
  const isbn13 = normalizeIsbn(input);

  if (!/^\d{13}$/.test(isbn13)) return { valid: false, reason: 'formato' };

  const prefix = isbn13.slice(0, 3);
  if (!BOOK_PREFIXES.includes(prefix)) return { valid: false, reason: 'prefijo' };

  const expected = isbn13CheckDigit(isbn13.slice(0, 12));
  if (expected !== isbn13.charCodeAt(12) - 48) return { valid: false, reason: 'checksum' };

  return { valid: true, isbn13 };
}

/** Azúcar para los lugares donde solo importa el sí/no. */
export function isValidIsbn13(input: string): boolean {
  return validateIsbn13(input).valid;
}

/** Mensaje para el usuario, en rioplatense. Lo consume la respuesta 400. */
export function isbnErrorMessage(reason: 'formato' | 'prefijo' | 'checksum'): string {
  switch (reason) {
    case 'formato':
      return 'Un ISBN-13 son 13 dígitos. Revisá que no falte ninguno.';
    case 'prefijo':
      return 'Ese código de barras no es de un libro: tiene que empezar con 978 o 979.';
    case 'checksum':
      return 'El ISBN no cierra: algún dígito está mal. Probá escanear de nuevo o cargarlo a mano.';
  }
}
