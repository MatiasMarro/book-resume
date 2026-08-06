/**
 * La carrera contra el reloj del cache miss.
 *
 * Lo que hay que probar acá no es que el LLM funcione —eso ya lo cubre
 * `llm.enrich.test.ts`— sino las dos garantías de la plomería:
 *
 * 1. El guardado pasa **aunque el reloj gane**. Si esto se rompe, cada escaneo
 *    de un libro nuevo paga una llamada al modelo y la tira.
 * 2. Nada de esto puede tirar un 500. Config rota, modelo inexistente o base
 *    caída degradan a metadata cruda.
 *
 * El proveedor y el presupuesto se inyectan, así que ningún test espera 6
 * segundos ni pega contra nadie.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APPEAL_DIMENSIONS, type Book } from '@lector/shared';
import { enriquecerEnVivo } from '../src/lib/enriquecerEnVivo';
import { resetVerificaciones } from '../src/llm/providers/index';
import type { EnrichRaw, EnrichRequest, LlmProvider, VerificacionModelo } from '../src/llm/types';
import type { Bindings } from '../src/env';
import { createFakeD1 } from './helpers/fake-d1';

const ISBN = '9788420471839';

const LIBRO: Book = {
  isbn13: ISBN,
  title: 'Stoner',
  authors: ['John Williams'],
  pageCount: 288,
  fetchedAt: 1_700_000_000_000,
};

const DESCRIPCIONES = [{ source: 'googlebooks' as const, text: 'La contratapa del editor.' }];

function salida(overrides: Record<string, unknown> = {}) {
  return {
    summary: 'Un profesor de literatura vive una vida gris en una universidad del Medio Oeste.',
    hook: 'La vida entera de un hombre que nadie miró dos veces.',
    genres: ['novela'],
    appeal_vector: Object.fromEntries(APPEAL_DIMENSIONS.map((d) => [d, 0.4])),
    content_flags: [],
    comparables: [],
    confidence: 1,
    ...overrides,
  };
}

function bindings(overrides: Partial<Bindings> = {}): Bindings {
  return {
    DB: null as unknown as D1Database,
    LLM_ENABLED: 'true',
    LLM_PROVIDER: 'fixture',
    LLM_MODEL: 'modelo-cabeza',
    LLM_PROVIDER_TAIL: 'fixture',
    LLM_MODEL_TAIL: 'modelo-cola',
    ...overrides,
  };
}

/** Proveedor con la respuesta y el momento controlados desde el test. */
function proveedor(opciones: {
  data?: unknown;
  /** Si se pasa, `complete` no resuelve hasta que el test la resuelva. */
  diferido?: Promise<void>;
  verificacion?: VerificacionModelo;
  nombre?: string;
}): LlmProvider & { llamadas: number } {
  const estado = { llamadas: 0 };

  return {
    name: opciones.nombre ?? 'guionado',
    supportsStrictSchema: true,
    get llamadas() {
      return estado.llamadas;
    },
    async complete(_req: EnrichRequest): Promise<EnrichRaw> {
      estado.llamadas++;
      if (opciones.diferido) await opciones.diferido;
      return {
        data: opciones.data ?? salida(),
        modelUsed: 'modelo-de-prueba',
        promptTokens: 2500,
        outputTokens: 600,
      };
    },
    async verificarModelo(): Promise<VerificacionModelo> {
      return opciones.verificacion ?? { estado: 'ok' };
    },
  };
}

function deps(fake: ReturnType<typeof createFakeD1>, extra: Record<string, unknown> = {}) {
  return {
    db: fake.db,
    env: bindings(),
    book: LIBRO,
    descriptions: DESCRIPCIONES,
    subjects: ['fiction'],
    now: () => 1_754_400_000_000,
    ...extra,
  } as Parameters<typeof enriquecerEnVivo>[0];
}

// La verificación del modelo se memoiza por isolate: sin esto, el veredicto de
// un test se filtra al siguiente.
beforeEach(() => resetVerificaciones());
afterEach(() => vi.restoreAllMocks());

describe('enriquecerEnVivo — el modelo llega a tiempo', () => {
  it('devuelve la ficha con estado listo', async () => {
    const fake = createFakeD1();

    const res = await enriquecerEnVivo(
      deps(fake, { provider: proveedor({}), presupuestoMs: 5_000 })
    );

    expect(res.estado).toBe('listo');
    expect(res.enrichment?.summary).toMatch(/profesor de literatura/);
    expect(res.enSegundoPlano).toBeUndefined();
  });

  it('la guarda en la base con el ISBN del escaneo y los tokens', async () => {
    const fake = createFakeD1();

    await enriquecerEnVivo(deps(fake, { provider: proveedor({}), presupuestoMs: 5_000 }));

    expect(fake.rows.enrichments.get(ISBN)).toMatchObject({
      isbn13: ISBN,
      model_used: 'modelo-de-prueba',
      prompt_tokens: 2500,
      output_tokens: 600,
      scan_count: 0,
      created_at: 1_754_400_000_000,
    });
  });

  it('penaliza el confidence por ser cola: un cache miss nunca es cabeza', async () => {
    const fake = createFakeD1();

    const res = await enriquecerEnVivo(
      deps(fake, { provider: proveedor({}), presupuestoMs: 5_000 })
    );

    // 1 × 0.8 (PENALIZACION_COLA). Si esto diera 1, alguien enchufó la cabeza.
    expect(res.enrichment?.confidence).toBe(0.8);
  });
});

describe('enriquecerEnVivo — gana el reloj', () => {
  it('responde pendiente y devuelve la tarea para waitUntil', async () => {
    const fake = createFakeD1();
    let liberar!: () => void;
    const diferido = new Promise<void>((r) => {
      liberar = r;
    });

    const res = await enriquecerEnVivo(
      deps(fake, { provider: proveedor({ diferido }), presupuestoMs: 1 })
    );

    expect(res.estado).toBe('pendiente');
    expect(res.enrichment).toBeNull();
    expect(res.enSegundoPlano).toBeInstanceOf(Promise);

    liberar();
    await res.enSegundoPlano;
  });

  it('la tarea IGUAL guarda la ficha: el trabajo no se tira', async () => {
    // La garantía que justifica que el saveEnrichment viva adentro de la
    // promesa. Sin esto, el próximo escaneo vuelve a pagar la misma llamada.
    const fake = createFakeD1();
    let liberar!: () => void;
    const diferido = new Promise<void>((r) => {
      liberar = r;
    });

    const res = await enriquecerEnVivo(
      deps(fake, { provider: proveedor({ diferido }), presupuestoMs: 1 })
    );

    expect(fake.rows.enrichments.has(ISBN)).toBe(false);

    liberar();
    await res.enSegundoPlano;

    expect(fake.rows.enrichments.get(ISBN)).toMatchObject({ isbn13: ISBN });
  });

  it('llama al modelo una sola vez, no una por rama de la carrera', async () => {
    const fake = createFakeD1();
    let liberar!: () => void;
    const diferido = new Promise<void>((r) => {
      liberar = r;
    });
    const prov = proveedor({ diferido });

    const res = await enriquecerEnVivo(deps(fake, { provider: prov, presupuestoMs: 1 }));
    liberar();
    await res.enSegundoPlano;

    expect(prov.llamadas).toBe(1);
  });
});

describe('enriquecerEnVivo — modos degradados', () => {
  it('LLM_ENABLED=false devuelve apagado sin tocar la base', async () => {
    const fake = createFakeD1();

    const res = await enriquecerEnVivo(
      deps(fake, { env: bindings({ LLM_ENABLED: 'false' }), provider: undefined })
    );

    expect(res.estado).toBe('apagado');
    expect(res.enrichment).toBeNull();
    expect(fake.calls.saveEnrichment).toBe(0);
  });

  it('una configuración rota loguea y degrada, no tira 500', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = createFakeD1();

    const res = await enriquecerEnVivo(
      deps(fake, { env: bindings({ LLM_PROVIDER_TAIL: 'inventado' }), provider: undefined })
    );

    expect(res.estado).toBe('fallo');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('inventado'));
  });

  it('un modelo inexistente no llega a llamar al proveedor', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = createFakeD1();
    const prov = proveedor({
      verificacion: { estado: 'no-existe', motivo: 'lo borraron del catálogo' },
    });

    const res = await enriquecerEnVivo(deps(fake, { provider: prov, presupuestoMs: 5_000 }));

    expect(res.estado).toBe('fallo');
    expect(prov.llamadas).toBe(0);
    expect(fake.calls.saveEnrichment).toBe(0);
  });

  it("'no-verificable' deja seguir: es el caso de Workers AI", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = createFakeD1();
    const prov = proveedor({
      verificacion: { estado: 'no-verificable', motivo: 'el binding no lista modelos' },
    });

    const res = await enriquecerEnVivo(deps(fake, { provider: prov, presupuestoMs: 5_000 }));

    expect(res.estado).toBe('listo');
  });

  it('una salida que no valida devuelve fallo sin guardar nada', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = createFakeD1();

    const res = await enriquecerEnVivo(
      deps(fake, {
        provider: proveedor({ data: salida({ confidence: 'muy alto' }) }),
        presupuestoMs: 5_000,
      })
    );

    expect(res.estado).toBe('fallo');
    expect(fake.calls.saveEnrichment).toBe(0);
  });

  it('si la base se cae al guardar, degrada en vez de propagar', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const roto = {
      prepare() {
        throw new Error('D1 caída');
      },
    } as unknown as D1Database;

    const res = await enriquecerEnVivo({
      db: roto,
      env: bindings(),
      book: LIBRO,
      descriptions: DESCRIPCIONES,
      subjects: [],
      provider: proveedor({}),
      presupuestoMs: 5_000,
    });

    expect(res.estado).toBe('fallo');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('D1 caída'));
  });
});

describe('enriquecerEnVivo — siempre la cola', () => {
  it('usa LLM_PROVIDER_TAIL / LLM_MODEL_TAIL, no los de la cabeza', async () => {
    const fake = createFakeD1();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Si tomara el tramo de la cabeza, `openai` sin OPENAI_API_KEY haría lanzar
    // a la fábrica y el estado sería 'fallo'.
    const res = await enriquecerEnVivo(
      deps(fake, {
        env: bindings({ LLM_PROVIDER: 'openai', LLM_MODEL: 'gpt-5.6-luna' }),
        provider: undefined,
        presupuestoMs: 5_000,
      })
    );

    expect(res.estado).toBe('listo');
    expect(res.enrichment?.modelUsed).toBe('fixture:modelo-cola');
  });
});

describe('enriquecerEnVivo — marca de revisión', () => {
  it('propaga needsReview a la fila guardada', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = createFakeD1();

    // Un summary que spoilea las dos veces: el guard lo marca y se guarda igual.
    const res = await enriquecerEnVivo(
      deps(fake, {
        provider: proveedor({
          data: salida({ summary: 'Al final se revela que el profesor muere solo en su casa.' }),
        }),
        presupuestoMs: 5_000,
      })
    );

    expect(res.enrichment?.needsReview).toBe(true);
    expect(fake.rows.enrichments.get(ISBN)).toMatchObject({ needs_review: 1 });
  });
});
