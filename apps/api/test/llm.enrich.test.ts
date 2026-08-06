/**
 * El orquestador: los dos reintentos, las penalizaciones y el modo degradado.
 *
 * El proveedor se inyecta entero, así que se puede guionar exactamente la
 * secuencia de respuestas que interesa —"la primera spoilea, la segunda no"—
 * sin mockear módulos globales.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APPEAL_DIMENSIONS } from '@lector/shared';
import type { Book } from '@lector/shared';
import { PENALIZACION_COLA, construirEnrichRequest, enriquecer } from '../src/llm/enrich';
import { PENALIZACION_REVISION } from '../src/llm/spoilerGuard';
import type { EnrichRaw, EnrichRequest, LlmProvider } from '../src/llm/types';

afterEach(() => vi.restoreAllMocks());

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

/**
 * Proveedor guionado: devuelve una respuesta por llamada, en orden. Si se le
 * piden más, repite la última.
 */
function proveedorGuionado(
  respuestas: (unknown | Error)[],
  opciones: { supportsStrictSchema?: boolean } = {}
): LlmProvider & { pedidos: EnrichRequest[] } {
  const pedidos: EnrichRequest[] = [];
  let i = 0;

  return {
    name: 'guionado',
    supportsStrictSchema: opciones.supportsStrictSchema ?? true,
    pedidos,
    async complete(req: EnrichRequest): Promise<EnrichRaw> {
      pedidos.push(req);
      const respuesta = respuestas[Math.min(i++, respuestas.length - 1)];
      if (respuesta instanceof Error) throw respuesta;
      return { data: respuesta, modelUsed: 'modelo-de-prueba', promptTokens: 2500, outputTokens: 600 };
    },
    async verificarModelo() {
      return { estado: 'ok' };
    },
  };
}

const PEDIDO: EnrichRequest = {
  isbn13: '9788420471839',
  title: 'Stoner',
  authors: ['John Williams'],
  subjects: [],
  descripciones: [{ source: 'googlebooks', text: 'La contratapa.' }],
};

describe('construirEnrichRequest — el único camino de las fuentes al prompt', () => {
  const libro: Book = {
    isbn13: '9788420471839',
    title: 'Stoner',
    authors: ['John Williams'],
    pageCount: 288,
    publisher: 'Fiordo',
    fetchedAt: 1,
  };

  it('sanitiza las descripciones antes de armar el pedido', () => {
    const { req, descartes } = construirEnrichRequest(
      libro,
      [{ source: 'openlibrary', text: 'Lead.\n\n== Argumento ==\nEl protagonista muere.' }],
      ['campus novel']
    );

    expect(req.descripciones[0]!.text).toBe('Lead.');
    expect(descartes.map((d) => d.motivo)).toContain('seccion-prohibida');
  });

  it('pasa la metadata del libro sin inventar campos ausentes', () => {
    const { req } = construirEnrichRequest(libro, [], []);

    expect(req.pageCount).toBe(288);
    expect(req.publisher).toBe('Fiordo');
    expect(req.language).toBeUndefined();
    expect('language' in req).toBe(false);
  });

  it('un libro sin descripciones llega con la lista vacía, no con basura', () => {
    const { req } = construirEnrichRequest(libro, [], []);
    expect(req.descripciones).toEqual([]);
  });
});

describe('enriquecer — camino feliz', () => {
  it('devuelve la ficha validada con el modelo y los tokens', async () => {
    const provider = proveedorGuionado([salida()]);
    const { enrichment, diagnostico } = await enriquecer(provider, PEDIDO, { tramo: 'cabeza' });

    expect(enrichment).not.toBeNull();
    expect(enrichment!.modelUsed).toBe('modelo-de-prueba');
    expect(enrichment!.promptTokens).toBe(2500);
    expect(enrichment!.outputTokens).toBe(600);
    expect(enrichment!.needsReview).toBe(false);
    expect(diagnostico.llamadas).toBe(1);
  });

  it('la cabeza NO penaliza el confidence', async () => {
    const provider = proveedorGuionado([salida({ confidence: 0.9 })]);
    const { enrichment } = await enriquecer(provider, PEDIDO, { tramo: 'cabeza' });

    expect(enrichment!.confidence).toBe(0.9);
  });

  it('la cola penaliza ×0.8 por modelo económico', async () => {
    const provider = proveedorGuionado([salida({ confidence: 0.9 })]);
    const { enrichment } = await enriquecer(provider, PEDIDO, { tramo: 'cola' });

    expect(enrichment!.confidence).toBeCloseTo(0.9 * PENALIZACION_COLA, 3);
  });
});

describe('reintento por forma — solo si el proveedor no la garantiza', () => {
  it('reintenta cuando supportsStrictSchema es false', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = proveedorGuionado(['no soy json', salida()], {
      supportsStrictSchema: false,
    });

    const { enrichment, diagnostico } = await enriquecer(provider, PEDIDO, { tramo: 'cola' });

    expect(diagnostico.llamadas).toBe(2);
    expect(enrichment).not.toBeNull();
  });

  it('NO reintenta con un proveedor estricto: sería pagar dos veces', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const provider = proveedorGuionado(['no soy json', salida()], {
      supportsStrictSchema: true,
    });

    const { enrichment, diagnostico } = await enriquecer(provider, PEDIDO, { tramo: 'cabeza' });

    expect(diagnostico.llamadas).toBe(1);
    expect(enrichment).toBeNull();
  });

  it('se rinde después de dos intentos y devuelve null, no lanza', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const provider = proveedorGuionado(['basura'], { supportsStrictSchema: false });

    const { enrichment, diagnostico } = await enriquecer(provider, PEDIDO, { tramo: 'cola' });

    expect(enrichment).toBeNull();
    expect(diagnostico.llamadas).toBe(2);
    expect(diagnostico.motivoFalla).toBeTruthy();
    expect(error).toHaveBeenCalled();
  });

  it('un proveedor que lanza no tumba el enriquecimiento', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const provider = proveedorGuionado([new Error('red caída')]);

    const { enrichment } = await enriquecer(provider, PEDIDO, { tramo: 'cabeza' });

    expect(enrichment).toBeNull();
  });
});

describe('reintento por spoiler', () => {
  const conSpoiler = salida({
    summary: 'Un profesor da clases y al final muere solo en su casa.',
  });

  it('reintenta con la instrucción reforzada y se queda con la limpia', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = proveedorGuionado([conSpoiler, salida()]);

    const { enrichment, diagnostico } = await enriquecer(provider, PEDIDO, { tramo: 'cabeza' });

    expect(diagnostico.llamadas).toBe(2);
    expect(enrichment!.needsReview).toBe(false);
    expect(enrichment!.summary).not.toContain('muere');
  });

  it('el refuerzo viaja en el segundo pedido, no en el primero', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = proveedorGuionado([conSpoiler, salida()]);

    await enriquecer(provider, PEDIDO, { tramo: 'cabeza' });

    expect(provider.pedidos[0]!.refuerzoAntiSpoiler).toBeUndefined();
    expect(provider.pedidos[1]!.refuerzoAntiSpoiler).toContain('RECHAZADO');
  });

  it('si vuelve a spoilear, guarda igual pero marcado y penalizado', async () => {
    // Tirar la ficha dejaría al libro sin nada. Alguien parado en el pasillo
    // prefiere una ficha dudosa con confidence bajo a una pantalla vacía.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const provider = proveedorGuionado([conSpoiler]);

    const { enrichment, diagnostico } = await enriquecer(provider, PEDIDO, { tramo: 'cabeza' });

    expect(enrichment).not.toBeNull();
    expect(enrichment!.needsReview).toBe(true);
    expect(enrichment!.confidence).toBeCloseTo(1 * PENALIZACION_REVISION, 3);
    expect(diagnostico.hallazgosSpoiler.length).toBeGreaterThan(0);
  });

  it('las penalizaciones se componen: cola + revisión', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const provider = proveedorGuionado([conSpoiler]);

    const { enrichment } = await enriquecer(provider, PEDIDO, { tramo: 'cola' });

    expect(enrichment!.confidence).toBeCloseTo(1 * PENALIZACION_COLA * PENALIZACION_REVISION, 3);
  });

  it('si el reintento falla por otra causa, se queda con la primera marcada', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const provider = proveedorGuionado([conSpoiler, new Error('rate limit')]);

    const { enrichment } = await enriquecer(provider, PEDIDO, { tramo: 'cabeza' });

    expect(enrichment).not.toBeNull();
    expect(enrichment!.needsReview).toBe(true);
    expect(enrichment!.summary).toContain('muere');
  });

  it('no reintenta si la primera salió limpia', async () => {
    const provider = proveedorGuionado([salida()]);
    const { diagnostico } = await enriquecer(provider, PEDIDO, { tramo: 'cabeza' });

    expect(diagnostico.llamadas).toBe(1);
    expect(diagnostico.hallazgosSpoiler).toEqual([]);
  });
});

describe('el confidence nunca se sale de rango', () => {
  it('redondea a tres decimales y se queda entre 0 y 1', async () => {
    const provider = proveedorGuionado([salida({ confidence: 0.777 })]);
    const { enrichment } = await enriquecer(provider, PEDIDO, { tramo: 'cola' });

    expect(enrichment!.confidence).toBeGreaterThanOrEqual(0);
    expect(enrichment!.confidence).toBeLessThanOrEqual(1);
    expect(String(enrichment!.confidence).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(3);
  });
});
