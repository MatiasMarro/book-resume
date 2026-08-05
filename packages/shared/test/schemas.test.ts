import { describe, expect, it } from 'vitest';
import {
  APPEAL_DIMENSIONS,
  AppealVectorSchema,
  BookSchema,
  CONTENT_FLAGS,
  ContentFlagSchema,
  EnrichmentSchema,
} from '../src/index';

const vector = Object.fromEntries(APPEAL_DIMENSIONS.map((d) => [d, 0.5]));

describe('AppealVectorSchema', () => {
  it('tiene las 14 dimensiones', () => {
    expect(APPEAL_DIMENSIONS).toHaveLength(14);
  });

  it('acepta un vector completo en rango', () => {
    expect(AppealVectorSchema.parse(vector)).toEqual(vector);
  });

  it('rechaza valores fuera de 0–1', () => {
    expect(AppealVectorSchema.safeParse({ ...vector, ritmo: 1.5 }).success).toBe(false);
  });

  it('rechaza un vector incompleto', () => {
    const { ritmo, ...sinRitmo } = vector;
    expect(AppealVectorSchema.safeParse(sinRitmo).success).toBe(false);
  });
});

describe('ContentFlagSchema', () => {
  it('acepta los 8 valores permitidos', () => {
    for (const flag of CONTENT_FLAGS) {
      expect(ContentFlagSchema.parse(flag)).toBe(flag);
    }
  });

  it('rechaza cualquier otro', () => {
    expect(ContentFlagSchema.safeParse('spoilers').success).toBe(false);
  });
});

describe('BookSchema', () => {
  const book = {
    isbn13: '9788420471839',
    title: 'Ficciones',
    authors: ['Jorge Luis Borges'],
    fetchedAt: 1_754_400_000_000,
  };

  it('acepta lo mínimo indispensable', () => {
    expect(BookSchema.parse(book).title).toBe('Ficciones');
  });

  it('rechaza un ISBN que no es de 13 dígitos', () => {
    expect(BookSchema.safeParse({ ...book, isbn13: '8420471836' }).success).toBe(false);
  });
});

describe('EnrichmentSchema', () => {
  const enrichment = {
    isbn13: '9788420471839',
    summary: 'Cuentos que arman laberintos de bibliotecas infinitas y libros imposibles.',
    hook: 'La realidad como una biblioteca que no termina.',
    genres: ['cuento', 'fantástico'],
    appealVector: vector,
    contentFlags: [],
    confidence: 0.9,
    modelUsed: 'gpt-5.6-luna',
    createdAt: 1_754_400_000_000,
  };

  it('defaultea scanCount a 0', () => {
    expect(EnrichmentSchema.parse(enrichment).scanCount).toBe(0);
  });

  it('rechaza content flags fuera del vocabulario', () => {
    const invalido = { ...enrichment, contentFlags: ['inventado'] };
    expect(EnrichmentSchema.safeParse(invalido).success).toBe(false);
  });

  it('rechaza confidence fuera de 0–1', () => {
    expect(EnrichmentSchema.safeParse({ ...enrichment, confidence: 2 }).success).toBe(false);
  });
});
