/**
 * La cola del upgrade perezoso: la política (pura) y el INSERT (idempotente).
 *
 * `decidirUpgrade` decide qué libros merecen el modelo pago, así que un error
 * acá se paga en dólares o en calidad. Va cubierta caso por caso.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  UMBRAL_UPGRADE,
  decidirUpgrade,
  encolarUpgrade,
} from '../src/db/upgrades';
import { createFakeD1 } from './helpers/fake-d1';

const ISBN = '9788420471839';
const CABEZA = 'gpt-5.6-luna';
const COLA = '@cf/meta/llama-3.1-8b-instruct';

describe('decidirUpgrade', () => {
  it('encola por escaneos al llegar al umbral', () => {
    const motivo = decidirUpgrade({
      modelUsed: COLA,
      scanCount: UMBRAL_UPGRADE,
      needsReview: false,
      modeloCabeza: CABEZA,
    });

    expect(motivo).toBe('scan-count');
  });

  it('no encola antes del umbral', () => {
    const motivo = decidirUpgrade({
      modelUsed: COLA,
      scanCount: UMBRAL_UPGRADE - 1,
      needsReview: false,
      modeloCabeza: CABEZA,
    });

    expect(motivo).toBeNull();
  });

  it('sigue encolando pasado el umbral: el INSERT OR IGNORE hace el resto', () => {
    const motivo = decidirUpgrade({
      modelUsed: COLA,
      scanCount: 47,
      needsReview: false,
      modeloCabeza: CABEZA,
    });

    expect(motivo).toBe('scan-count');
  });

  it('encola una ficha marcada para revisión sin esperar los 3 escaneos', () => {
    // El guard saltó dos veces: el resumen puede estar spoileando. No hay que
    // esperar a que sea popular para arreglarlo.
    const motivo = decidirUpgrade({
      modelUsed: COLA,
      scanCount: 1,
      needsReview: true,
      modeloCabeza: CABEZA,
    });

    expect(motivo).toBe('needs-review');
  });

  it('nunca encola lo que ya se hizo con el modelo de la cabeza', () => {
    // No hay a dónde subir, y re-enriquecerlo sería gastar dos veces por lo mismo.
    for (const [scanCount, needsReview] of [
      [100, false],
      [1, true],
    ] as const) {
      expect(
        decidirUpgrade({ modelUsed: CABEZA, scanCount, needsReview, modeloCabeza: CABEZA })
      ).toBeNull();
    }
  });

  it('trata un model ID decorado por el proveedor como cola', () => {
    // `fixture:gpt-5.6-luna` no es `gpt-5.6-luna`: una ficha de fixture tiene
    // que poder subir al modelo real.
    const motivo = decidirUpgrade({
      modelUsed: `fixture:${CABEZA}`,
      scanCount: UMBRAL_UPGRADE,
      needsReview: false,
      modeloCabeza: CABEZA,
    });

    expect(motivo).toBe('scan-count');
  });

  it('con LLM_MODEL sin configurar no rompe: todo es candidato', () => {
    const motivo = decidirUpgrade({
      modelUsed: COLA,
      scanCount: UMBRAL_UPGRADE,
      needsReview: false,
      modeloCabeza: '',
    });

    expect(motivo).toBe('scan-count');
  });
});

describe('encolarUpgrade', () => {
  it('guarda el pedido con el modelo de origen y la fecha', async () => {
    const fake = createFakeD1();

    const ok = await encolarUpgrade(
      fake.db,
      { isbn13: ISBN, motivo: 'scan-count', fromModel: COLA },
      1_754_400_000_000
    );

    expect(ok).toBe(true);
    expect(fake.rows.upgrades.get(ISBN)).toMatchObject({
      isbn13: ISBN,
      reason: 'scan-count',
      from_model: COLA,
      queued_at: 1_754_400_000_000,
      done_at: null,
    });
  });

  it('es idempotente: el segundo pedido no pisa al primero', async () => {
    const fake = createFakeD1();

    await encolarUpgrade(fake.db, { isbn13: ISBN, motivo: 'needs-review', fromModel: COLA }, 1);
    await encolarUpgrade(fake.db, { isbn13: ISBN, motivo: 'scan-count', fromModel: 'otro' }, 2);

    expect(fake.rows.upgrades.size).toBe(1);
    expect(fake.rows.upgrades.get(ISBN)).toMatchObject({ reason: 'needs-review', queued_at: 1 });
  });

  it('no lanza si la base falla: perder un upgrade no puede romper un escaneo', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const roto = {
      prepare() {
        throw new Error('D1 caída');
      },
    } as unknown as D1Database;

    await expect(
      encolarUpgrade(roto, { isbn13: ISBN, motivo: 'scan-count', fromModel: COLA })
    ).resolves.toBe(false);
  });
});
