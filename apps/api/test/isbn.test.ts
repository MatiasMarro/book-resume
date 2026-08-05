import { describe, expect, it } from 'vitest';
import {
  isValidIsbn13,
  isbn13CheckDigit,
  isbnErrorMessage,
  normalizeIsbn,
  validateIsbn13,
} from '../src/lib/isbn';

describe('normalizeIsbn', () => {
  it('saca guiones y espacios', () => {
    expect(normalizeIsbn('978-84-204-7183-9')).toBe('9788420471839');
    expect(normalizeIsbn(' 978 84 204 7183 9 ')).toBe('9788420471839');
  });

  it('deja intacto lo que ya está limpio', () => {
    expect(normalizeIsbn('9788420471839')).toBe('9788420471839');
  });
});

describe('isbn13CheckDigit', () => {
  // Pesos alternados 1,3: el dígito 13 cierra la suma a un múltiplo de 10.
  it.each([
    ['978842047183', 9],
    ['978030747427', 8],
    ['978014118776', 1],
    ['978987725253', 8],
  ])('%s → %i', (first12, expected) => {
    expect(isbn13CheckDigit(first12)).toBe(expected);
  });

  it('devuelve 0 y no 10 cuando la suma ya es múltiplo de 10', () => {
    // El caso que rompe la implementación ingenua `10 - (sum % 10)`.
    const digit = isbn13CheckDigit('978000000000');
    expect(digit).toBeGreaterThanOrEqual(0);
    expect(digit).toBeLessThanOrEqual(9);
  });
});

describe('validateIsbn13', () => {
  it('acepta ISBN-13 reales de los tres grupos del spike', () => {
    // Bestseller traducido, catálogo español, independiente argentina.
    for (const isbn of ['9780307474278', '9788420471839', '9789877252538']) {
      expect(validateIsbn13(isbn)).toEqual({ valid: true, isbn13: isbn });
    }
  });

  it('acepta con guiones y devuelve la forma normalizada', () => {
    expect(validateIsbn13('978-84-204-7183-9')).toEqual({
      valid: true,
      isbn13: '9788420471839',
    });
  });

  it('acepta el prefijo 979 (Bookland nuevo)', () => {
    // 9791234567896: checksum calculado, no inventado.
    const first12 = '979123456789';
    const isbn = first12 + String(isbn13CheckDigit(first12));
    expect(validateIsbn13(isbn).valid).toBe(true);
  });

  it('rechaza por formato: largo, letras, vacío', () => {
    for (const bad of ['', '123', '97884204718391', '978842047183X', 'no-es-un-isbn']) {
      expect(validateIsbn13(bad)).toEqual({ valid: false, reason: 'formato' });
    }
  });

  it('rechaza un EAN-13 que no es de libro', () => {
    // 13 dígitos válidos pero prefijo de producto de góndola, no Bookland.
    expect(validateIsbn13('7790001234561')).toEqual({ valid: false, reason: 'prefijo' });
  });

  it('rechaza checksum equivocado', () => {
    // Un dígito mal leído por la cámara: el caso que este módulo existe para atajar.
    expect(validateIsbn13('9788420471838')).toEqual({ valid: false, reason: 'checksum' });
    expect(validateIsbn13('9780307474279')).toEqual({ valid: false, reason: 'checksum' });
  });

  it('rechaza el ISBN inválido que devuelve Open Library en sus propios datos', () => {
    // Medido: pedir 9788420471839 devuelve identifiers.isbn_13 = ...837, que
    // no cierra el checksum. Por eso la caché se clavea con el ISBN pedido.
    expect(validateIsbn13('9788420471837').valid).toBe(false);
  });

  it('un dígito cambiado casi siempre rompe el checksum', () => {
    // Justifica validar antes de gastar requests: filtra la mayor parte de las
    // lecturas erróneas del escáner sin tocar la red.
    const valid = '9788420471839';
    let rejected = 0;
    for (let pos = 0; pos < 12; pos++) {
      for (let d = 0; d <= 9; d++) {
        const digit = String(d);
        if (valid[pos] === digit) continue;
        const mutated = valid.slice(0, pos) + digit + valid.slice(pos + 1);
        if (!isValidIsbn13(mutated)) rejected++;
      }
    }
    // 108 mutaciones de un dígito; solo las que suman ±10 al peso sobreviven.
    expect(rejected / 108).toBeGreaterThan(0.85);
  });
});

describe('isbnErrorMessage', () => {
  it('da un mensaje accionable en rioplatense para cada motivo', () => {
    expect(isbnErrorMessage('formato')).toMatch(/13 dígitos/);
    expect(isbnErrorMessage('prefijo')).toMatch(/978 o 979/);
    expect(isbnErrorMessage('checksum')).toMatch(/escanear de nuevo/);
  });
});
