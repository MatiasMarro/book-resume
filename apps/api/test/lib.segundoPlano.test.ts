/**
 * El wrapper de `waitUntil`. Dos ramas, y la que importa es la del catch: si
 * `c.executionCtx` lanza y nadie lo agarra, una tarea de fondo opcional se
 * convierte en un 500 para alguien parado en el pasillo.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { AppEnv } from '../src/env';
import { enSegundoPlano } from '../src/lib/segundoPlano';

describe('enSegundoPlano', () => {
  it('registra la tarea cuando hay ExecutionContext', () => {
    const waitUntil = vi.fn();
    const c = { executionCtx: { waitUntil } } as unknown as Context<AppEnv>;
    const tarea = Promise.resolve('lista');

    enSegundoPlano(c, tarea);

    expect(waitUntil).toHaveBeenCalledWith(tarea);
  });

  it('no lanza cuando el contexto no lo expone', async () => {
    const c = {
      get executionCtx(): never {
        throw new Error('This context has no ExecutionContext');
      },
    } as unknown as Context<AppEnv>;

    const tarea = Promise.resolve('lista');

    expect(() => enSegundoPlano(c, tarea)).not.toThrow();
    // La promesa sigue su curso igual.
    await expect(tarea).resolves.toBe('lista');
  });
});
