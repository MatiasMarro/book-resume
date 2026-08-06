/**
 * Los proveedores y la fábrica.
 *
 * Ningún test pega a la red: el cliente de OpenAI, el binding de Workers AI y
 * el `fetch` del catálogo se inyectan, como el resto del repo (CLAUDE.md,
 * "Dependencias inyectables para testear sin red").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APPEAL_DIMENSIONS } from '@lector/shared';
import type OpenAI from 'openai';
import { crearProveedorOpenAi } from '../src/llm/providers/openai';
import { crearProveedorWorkersAi, extraerJson } from '../src/llm/providers/workersai';
import { MARCA_SINTETICA, crearProveedorFixture, vectorSintetico } from '../src/llm/providers/fixture';
import {
  ConfiguracionLlmError,
  crearProvider,
  llmHabilitado,
  modeloUsable,
  resetVerificaciones,
} from '../src/llm/providers/index';
import type { Bindings } from '../src/env';
import type { EnrichRequest } from '../src/llm/types';

const PEDIDO: EnrichRequest = {
  isbn13: '9788420471839',
  title: 'Cien años de soledad',
  authors: ['Gabriel García Márquez'],
  subjects: [],
  descripciones: [{ source: 'googlebooks', text: 'La contratapa.' }],
};

function salidaModelo() {
  return {
    summary: 'Un resumen del planteo.',
    hook: 'Un gancho.',
    genres: ['novela'],
    appeal_vector: Object.fromEntries(APPEAL_DIMENSIONS.map((d) => [d, 0.5])),
    content_flags: [],
    comparables: [],
    confidence: 0.8,
  };
}

beforeEach(() => resetVerificaciones());
afterEach(() => vi.restoreAllMocks());

// ─── OpenAI ────────────────────────────────────────────────────────────────

type LlamadaOpenAi = Record<string, unknown>;

function clienteOpenAiFalso(opciones: {
  respuesta?: unknown;
  error?: unknown;
  modelos?: string[];
  registro?: LlamadaOpenAi[];
}) {
  let primeraLlamada = true;

  return {
    chat: {
      completions: {
        create: async (args: LlamadaOpenAi) => {
          opciones.registro?.push(args);
          if (opciones.error && primeraLlamada) {
            primeraLlamada = false;
            throw opciones.error;
          }
          return (
            opciones.respuesta ?? {
              model: 'gpt-5.6-luna-2026-01-01',
              choices: [{ message: { content: JSON.stringify(salidaModelo()) }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 2500, completion_tokens: 600 },
            }
          );
        },
      },
    },
    models: {
      list: async () => ({ data: (opciones.modelos ?? ['gpt-5.6-luna']).map((id) => ({ id })) }),
    },
  } as unknown as OpenAI;
}

describe('proveedor openai', () => {
  it('declara que garantiza la forma: no hace falta reintento por JSON', () => {
    const provider = crearProveedorOpenAi({
      apiKey: 'k',
      model: 'gpt-5.6-luna',
      cliente: clienteOpenAiFalso({}),
    });
    expect(provider.supportsStrictSchema).toBe(true);
  });

  it('manda json_schema con strict:true y el techo de 700 tokens', async () => {
    const registro: LlamadaOpenAi[] = [];
    const provider = crearProveedorOpenAi({
      apiKey: 'k',
      model: 'gpt-5.6-luna',
      cliente: clienteOpenAiFalso({ registro }),
    });

    await provider.complete(PEDIDO);

    const args = registro[0] as any;
    expect(args.model).toBe('gpt-5.6-luna');
    expect(args.response_format.type).toBe('json_schema');
    expect(args.response_format.json_schema.strict).toBe(true);
    expect(args.max_completion_tokens).toBe(700);
  });

  it('pide reasoning_effort mínimo: los tokens de razonamiento se facturan', () => {
    const registro: LlamadaOpenAi[] = [];
    const provider = crearProveedorOpenAi({
      apiKey: 'k',
      model: 'gpt-5.6-luna',
      cliente: clienteOpenAiFalso({ registro }),
    });

    return provider.complete(PEDIDO).then(() => {
      expect((registro[0] as any).reasoning_effort).toBe('minimal');
    });
  });

  it('el bloque de sistema va primero y sin el ISBN adentro', async () => {
    const registro: LlamadaOpenAi[] = [];
    const provider = crearProveedorOpenAi({
      apiKey: 'k',
      model: 'gpt-5.6-luna',
      cliente: clienteOpenAiFalso({ registro }),
    });

    await provider.complete(PEDIDO);

    const mensajes = (registro[0] as any).messages;
    expect(mensajes[0].role).toBe('system');
    expect(mensajes[0].content).not.toContain('9788420471839');
    expect(mensajes[1].role).toBe('user');
  });

  it('reintenta sin reasoning_effort si el modelo no lo soporta', async () => {
    const registro: LlamadaOpenAi[] = [];
    const provider = crearProveedorOpenAi({
      apiKey: 'k',
      model: 'modelo-sin-razonamiento',
      cliente: clienteOpenAiFalso({
        registro,
        error: new Error("Unsupported parameter: 'reasoning_effort' is not supported"),
      }),
    });

    const raw = await provider.complete(PEDIDO);

    expect(registro).toHaveLength(2);
    expect((registro[0] as any).reasoning_effort).toBe('minimal');
    expect((registro[1] as any).reasoning_effort).toBeUndefined();
    expect(raw.data).toMatchObject({ hook: 'Un gancho.' });
  });

  it('NO reintenta si el error es otro: sería pagar dos veces al pedo', async () => {
    const registro: LlamadaOpenAi[] = [];
    const provider = crearProveedorOpenAi({
      apiKey: 'k',
      model: 'gpt-5.6-luna',
      cliente: clienteOpenAiFalso({ registro, error: new Error('rate limit exceeded') }),
    });

    await expect(provider.complete(PEDIDO)).rejects.toThrow(/rate limit/);
    expect(registro).toHaveLength(1);
  });

  it('devuelve el usage completo para auditar tokens de razonamiento', async () => {
    const provider = crearProveedorOpenAi({
      apiKey: 'k',
      model: 'gpt-5.6-luna',
      cliente: clienteOpenAiFalso({}),
    });

    const raw = await provider.complete(PEDIDO);

    expect(raw.promptTokens).toBe(2500);
    expect(raw.outputTokens).toBe(600);
    // El model ID que respondió, no el que pedimos: el API resuelve alias.
    expect(raw.modelUsed).toBe('gpt-5.6-luna-2026-01-01');
  });

  it('lanza si la respuesta viene vacía por corte de tokens', async () => {
    const provider = crearProveedorOpenAi({
      apiKey: 'k',
      model: 'gpt-5.6-luna',
      cliente: clienteOpenAiFalso({
        respuesta: { model: 'x', choices: [{ message: {}, finish_reason: 'length' }] },
      }),
    });

    await expect(provider.complete(PEDIDO)).rejects.toThrow(/length/);
  });

  it('verificarModelo confirma el modelo contra el catálogo', async () => {
    const provider = crearProveedorOpenAi({
      apiKey: 'k',
      model: 'gpt-5.6-luna',
      cliente: clienteOpenAiFalso({ modelos: ['gpt-5.6-luna', 'gpt-5.6-terra'] }),
    });

    expect(await provider.verificarModelo()).toEqual({ estado: 'ok' });
  });

  it('verificarModelo avisa cuando el modelo desapareció del catálogo', async () => {
    // El caso del 31 de mayo de 2026: un proveedor borró sus modelos gratis y
    // las pipelines con el ID hardcodeado murieron en silencio.
    const provider = crearProveedorOpenAi({
      apiKey: 'k',
      model: 'gpt-5.6-luna',
      cliente: clienteOpenAiFalso({ modelos: ['gpt-5.7-luna'] }),
    });

    const veredicto = await provider.verificarModelo();

    expect(veredicto.estado).toBe('no-existe');
    if (veredicto.estado !== 'no-existe') return;
    expect(veredicto.motivo).toContain('gpt-5.6-luna');
    expect(veredicto.modelosDisponibles).toContain('gpt-5.7-luna');
  });
});

// ─── Workers AI ────────────────────────────────────────────────────────────

describe('extraerJson — los modelos abiertos contestan de tres formas', () => {
  it('acepta un objeto ya parseado', () => {
    expect(extraerJson({ a: 1 })).toEqual({ a: 1 });
  });

  it('acepta un string JSON limpio', () => {
    expect(extraerJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('acepta un bloque de código markdown', () => {
    expect(extraerJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('rescata el objeto de un texto con prólogo', () => {
    expect(extraerJson('Acá está el JSON que pediste: {"a":1} ¡Saludos!')).toEqual({ a: 1 });
  });

  it('devuelve undefined si no hay nada rescatable, en vez de lanzar', () => {
    expect(extraerJson('no hay json acá')).toBeUndefined();
    expect(extraerJson(undefined)).toBeUndefined();
    expect(extraerJson(42)).toBeUndefined();
  });
});

describe('proveedor workersai', () => {
  it('declara que NO garantiza la forma: activa el reintento por JSON', () => {
    const provider = crearProveedorWorkersAi({ ai: { run: async () => ({}) }, model: 'm' });
    expect(provider.supportsStrictSchema).toBe(false);
  });

  it('llama al binding con el model ID de env', async () => {
    const llamadas: { model: string; inputs: any }[] = [];
    const provider = crearProveedorWorkersAi({
      ai: {
        run: async (model, inputs) => {
          llamadas.push({ model, inputs });
          return { response: salidaModelo(), usage: { prompt_tokens: 900, completion_tokens: 400 } };
        },
      },
      model: '@cf/meta/llama-x-instruct',
    });

    const raw = await provider.complete(PEDIDO);

    expect(llamadas[0]!.model).toBe('@cf/meta/llama-x-instruct');
    expect(llamadas[0]!.inputs.max_tokens).toBe(700);
    expect(raw.modelUsed).toBe('@cf/meta/llama-x-instruct');
    expect(raw.promptTokens).toBe(900);
  });

  it('lanza reintentable cuando la respuesta no tiene JSON adentro', async () => {
    const provider = crearProveedorWorkersAi({
      ai: { run: async () => ({ response: 'Perdón, no puedo ayudarte con eso.' }) },
      model: 'm',
    });

    await expect(provider.complete(PEDIDO)).rejects.toThrow(/no es JSON/);
  });

  it('verificarModelo queda indeterminado sin credenciales de Cloudflare', async () => {
    // El binding AI corre inferencia pero no lista modelos. Decir 'ok' acá
    // sería mentir sobre lo único que esta verificación existe para detectar.
    const provider = crearProveedorWorkersAi({ ai: { run: async () => ({}) }, model: 'm' });
    const veredicto = await provider.verificarModelo();

    expect(veredicto.estado).toBe('no-verificable');
    if (veredicto.estado !== 'no-verificable') return;
    expect(veredicto.motivo).toContain('check:models');
  });

  it('verificarModelo consulta el catálogo cuando hay credenciales', async () => {
    const provider = crearProveedorWorkersAi({
      ai: { run: async () => ({}) },
      model: '@cf/meta/llama-x-instruct',
      accountId: 'cuenta',
      apiToken: 'token',
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ result: [{ name: '@cf/meta/llama-x-instruct' }] }),
          { status: 200 }
        )) as unknown as typeof fetch,
    });

    expect(await provider.verificarModelo()).toEqual({ estado: 'ok' });
  });

  it('verificarModelo detecta el modelo que no está en el catálogo', async () => {
    const provider = crearProveedorWorkersAi({
      ai: { run: async () => ({}) },
      model: '@cf/borrado',
      accountId: 'cuenta',
      apiToken: 'token',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ result: [{ name: '@cf/otro-instruct' }] }), {
          status: 200,
        })) as unknown as typeof fetch,
    });

    expect((await provider.verificarModelo()).estado).toBe('no-existe');
  });
});

// ─── Fixture ───────────────────────────────────────────────────────────────

describe('proveedor fixture', () => {
  it('devuelve el fixture guardado para un ISBN conocido', async () => {
    const provider = crearProveedorFixture({ model: 'gpt-5.6-luna' });
    const raw = await provider.complete(PEDIDO);

    expect((raw.data as any).summary).toContain('Macondo');
    expect(raw.modelUsed).toBe('fixture:gpt-5.6-luna');
  });

  it('inventa una ficha determinística para un ISBN sin fixture', async () => {
    const provider = crearProveedorFixture({ model: 'm' });
    const otro = { ...PEDIDO, isbn13: '9789871622991', title: 'Un libro sin fixture' };

    const uno = await provider.complete(otro);
    const dos = await provider.complete(otro);

    expect(uno.data).toEqual(dos.data);
    expect((uno.data as any).summary).toContain(MARCA_SINTETICA);
    expect(uno.modelUsed).toBe('fixture:sintetico');
  });

  it('la ficha sintética se declara mentira y trae confidence bajo', async () => {
    // Si un fixture sintético se cuela en la base, el producto tiene que
    // mostrarlo como "info limitada", no como dato bueno.
    const provider = crearProveedorFixture({ model: 'm' });
    const raw = await provider.complete({ ...PEDIDO, isbn13: '9789871622991' });

    expect((raw.data as any).confidence).toBeLessThanOrEqual(0.2);
    expect((raw.data as any).hook).toContain(MARCA_SINTETICA);
  });

  it('el vector sintético usa TODO el rango, no se amontona en 0.5', () => {
    // Un relleno cómodo alrededor de 0.5 se vería igual que el colapso del
    // vector que la Puerta 2 tiene que detectar.
    const valores = Object.values(vectorSintetico('9789871622991'));

    expect(valores).toHaveLength(14);
    expect(Math.min(...valores)).toBeLessThan(0.3);
    expect(Math.max(...valores)).toBeGreaterThan(0.7);
  });

  it('dos ISBN distintos dan vectores distintos', () => {
    expect(vectorSintetico('9788420471839')).not.toEqual(vectorSintetico('9789871622991'));
  });
});

// ─── Fábrica ───────────────────────────────────────────────────────────────

function env(overrides: Partial<Bindings> = {}): Bindings {
  return {
    DB: {} as D1Database,
    LLM_ENABLED: 'true',
    LLM_PROVIDER: 'fixture',
    LLM_MODEL: 'gpt-5.6-luna',
    LLM_PROVIDER_TAIL: 'fixture',
    LLM_MODEL_TAIL: 'modelo-cola',
    ...overrides,
  };
}

describe('crearProvider — el kill switch y la configuración', () => {
  it('LLM_ENABLED=false devuelve null: se degrada a metadata cruda', () => {
    expect(crearProvider('cabeza', env({ LLM_ENABLED: 'false' }))).toBeNull();
    expect(crearProvider('cola', env({ LLM_ENABLED: 'false' }))).toBeNull();
  });

  it('llmHabilitado solo acepta el string "true"', () => {
    expect(llmHabilitado({ LLM_ENABLED: 'true' })).toBe(true);
    expect(llmHabilitado({ LLM_ENABLED: 'TRUE' })).toBe(true);
    expect(llmHabilitado({ LLM_ENABLED: '1' })).toBe(false);
    expect(llmHabilitado({ LLM_ENABLED: '' })).toBe(false);
  });

  it('elige el tramo correcto: la cabeza y la cola son configs distintas', () => {
    const bindings = env({ LLM_PROVIDER: 'fixture', LLM_PROVIDER_TAIL: 'workersai', AI: { run: async () => ({}) } as never });

    expect(crearProvider('cabeza', bindings)!.name).toBe('fixture');
    expect(crearProvider('cola', bindings)!.name).toBe('workersai');
  });

  it('LANZA si falta el model ID: no hay default posible', () => {
    // Los model IDs van siempre por env. Un default hardcodeado es justo lo que
    // CLAUDE.md prohíbe.
    expect(() => crearProvider('cola', env({ LLM_MODEL_TAIL: '' }))).toThrow(
      ConfiguracionLlmError
    );
    expect(() => crearProvider('cola', env({ LLM_MODEL_TAIL: '' }))).toThrow(/LLM_MODEL_TAIL/);
  });

  it('LANZA con un proveedor desconocido', () => {
    expect(() => crearProvider('cabeza', env({ LLM_PROVIDER: 'ollama' }))).toThrow(/ollama/);
  });

  it('LANZA si openai no tiene API key', () => {
    expect(() => crearProvider('cabeza', env({ LLM_PROVIDER: 'openai' }))).toThrow(
      /OPENAI_API_KEY/
    );
  });

  it('LANZA si workersai no tiene el binding AI', () => {
    expect(() => crearProvider('cola', env({ LLM_PROVIDER_TAIL: 'workersai' }))).toThrow(
      /binding AI/
    );
  });
});

describe('modeloUsable — verificación perezosa y memoizada', () => {
  it('verifica una sola vez por isolate', async () => {
    const verificar = vi.fn(async () => ({ estado: 'ok' as const }));
    const provider = { name: 'p', supportsStrictSchema: true, complete: vi.fn(), verificarModelo: verificar };

    await modeloUsable(provider as never, 'm');
    await modeloUsable(provider as never, 'm');
    await modeloUsable(provider as never, 'm');

    expect(verificar).toHaveBeenCalledTimes(1);
  });

  it('cambiar de modelo vuelve a verificar', async () => {
    const verificar = vi.fn(async () => ({ estado: 'ok' as const }));
    const provider = { name: 'p', supportsStrictSchema: true, complete: vi.fn(), verificarModelo: verificar };

    await modeloUsable(provider as never, 'modelo-viejo');
    await modeloUsable(provider as never, 'modelo-nuevo');

    expect(verificar).toHaveBeenCalledTimes(2);
  });

  it('con un modelo inexistente devuelve false y loguea ruidoso', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const provider = {
      name: 'p',
      supportsStrictSchema: true,
      complete: vi.fn(),
      verificarModelo: async () => ({ estado: 'no-existe' as const, motivo: 'no está' }),
    };

    expect(await modeloUsable(provider as never, 'm')).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('MODELO INEXISTENTE'));
  });

  it('no-verificable deja seguir, pero avisa', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = {
      name: 'p',
      supportsStrictSchema: true,
      complete: vi.fn(),
      verificarModelo: async () => ({ estado: 'no-verificable' as const, motivo: 'sin token' }),
    };

    expect(await modeloUsable(provider as never, 'm')).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});
