/**
 * `saveEnrichment` y la vuelta completa por `getEnrichment`.
 *
 * Lo que se prueba de verdad es el ida y vuelta: que lo que se guarda en las
 * columnas JSON vuelva a salir con la misma forma, y que el UPSERT respete
 * `scan_count`.
 */
import { describe, expect, it } from 'vitest';
import { APPEAL_DIMENSIONS, type Enrichment } from '@lector/shared';
import { getEnrichment, saveEnrichment } from '../src/db/books';
import { createFakeD1, enrichmentRow } from './helpers/fake-d1';

const ISBN = '9788420471839';

function ficha(overrides: Partial<Enrichment> = {}): Enrichment {
  return {
    isbn13: ISBN,
    summary: 'Un profesor de literatura vive una vida gris en el Medio Oeste.',
    hook: 'La vida entera de un hombre que nadie miró dos veces.',
    genres: ['novela'],
    appealVector: Object.fromEntries(
      APPEAL_DIMENSIONS.map((d) => [d, 0.4])
    ) as Enrichment['appealVector'],
    contentFlags: ['adicciones'],
    comparables: ['Pedro Páramo'],
    confidence: 0.64,
    modelUsed: 'modelo-de-prueba',
    promptTokens: 2500,
    outputTokens: 600,
    needsReview: false,
    scanCount: 0,
    createdAt: 1_754_400_000_000,
    ...overrides,
  };
}

describe('saveEnrichment', () => {
  it('guarda y devuelve la misma ficha por getEnrichment', async () => {
    const fake = createFakeD1();

    await saveEnrichment(fake.db, ficha());

    await expect(getEnrichment(fake.db, ISBN)).resolves.toEqual(ficha());
  });

  it('serializa los campos JSON y el booleano de revisión', async () => {
    const fake = createFakeD1();

    await saveEnrichment(fake.db, ficha({ needsReview: true }));

    const fila = fake.rows.enrichments.get(ISBN)!;
    expect(fila.genres).toBe('["novela"]');
    expect(fila.content_flags).toBe('["adicciones"]');
    // SQLite no tiene booleanos.
    expect(fila.needs_review).toBe(1);
  });

  it('omite comparables ausente en vez de guardar "undefined"', async () => {
    const fake = createFakeD1();
    const { comparables, ...sinComparables } = ficha();

    await saveEnrichment(fake.db, sinComparables as Enrichment);

    expect(fake.rows.enrichments.get(ISBN)!.comparables).toBeNull();
    const leida = await getEnrichment(fake.db, ISBN);
    expect(leida).not.toHaveProperty('comparables');
  });

  it('el re-enriquecimiento NO resetea scan_count', async () => {
    // El upgrade perezoso re-enriquece justo los libros más escaneados: perder
    // esa cuenta haría que el más popular del catálogo parezca recién nacido.
    const fake = createFakeD1({
      enrichments: new Map([[ISBN, enrichmentRow(ISBN, { scan_count: 12 })]]),
    });

    await saveEnrichment(fake.db, ficha({ summary: 'Resumen nuevo, del modelo bueno.' }));

    const leida = await getEnrichment(fake.db, ISBN);
    expect(leida?.summary).toBe('Resumen nuevo, del modelo bueno.');
    expect(leida?.scanCount).toBe(12);
  });
});

describe('rowToEnrichment', () => {
  it('lee needs_review como booleano', async () => {
    const fake = createFakeD1({
      enrichments: new Map([[ISBN, enrichmentRow(ISBN, { needs_review: 1 })]]),
    });

    await expect(getEnrichment(fake.db, ISBN)).resolves.toMatchObject({ needsReview: true });
  });
});
