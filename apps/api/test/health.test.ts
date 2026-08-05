import { describe, expect, it } from 'vitest';
import app from '../src/index';

describe('GET /health', () => {
  it('devuelve 200 y { ok: true }', async () => {
    const res = await app.request('/health');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it('404 en una ruta que no existe', async () => {
    const res = await app.request('/no-existe');

    expect(res.status).toBe(404);
  });
});
