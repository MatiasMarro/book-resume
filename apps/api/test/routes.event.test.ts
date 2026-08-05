import { describe, expect, it } from 'vitest';
import app from '../src/index';
import { createFakeD1 } from './helpers/fake-d1';

const ISBN = '9788420471839';

function post(body: unknown, fake: ReturnType<typeof createFakeD1>) {
  return app.request(
    '/api/event',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    { DB: fake.db } as never
  );
}

describe('POST /api/event', () => {
  it('acepta un escaneo resuelto', async () => {
    const fake = createFakeD1();

    const res = await post({ isbn13: ISBN, method: 'barcode', resolved: true, latencyMs: 1800 }, fake);

    expect(res.status).toBe(202);
    expect(fake.rows.scanEvents[0]).toMatchObject({
      isbn13: ISBN,
      method: 'barcode',
      resolved: 1,
      latency_ms: 1800,
    });
  });

  it('acepta un intento sin ISBN: código ilegible', async () => {
    // El caso que justifica que exista este endpoint. GET /api/book no lo ve.
    const fake = createFakeD1();

    const res = await post({ method: 'ocr', resolved: false }, fake);

    expect(res.status).toBe(202);
    expect(fake.rows.scanEvents[0]).toMatchObject({ isbn13: null, method: 'ocr', resolved: 0 });
  });

  it('acepta los tres métodos', async () => {
    const fake = createFakeD1();

    for (const method of ['barcode', 'ocr', 'manual']) {
      expect((await post({ method, resolved: true }, fake)).status).toBe(202);
    }
    expect(fake.rows.scanEvents).toHaveLength(3);
  });

  it('rechaza un método inventado', async () => {
    const fake = createFakeD1();

    const res = await post({ method: 'telepatia', resolved: true }, fake);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'evento-invalido' });
    expect(fake.rows.scanEvents).toHaveLength(0);
  });

  it('rechaza un ISBN con forma inválida', async () => {
    const fake = createFakeD1();
    expect((await post({ isbn13: '123', method: 'barcode', resolved: true }, fake)).status).toBe(400);
  });

  it('rechaza body que no es JSON', async () => {
    const res = await post('esto no es json', createFakeD1());
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'json-invalido' });
  });

  it('rechaza campos faltantes y dice cuáles', async () => {
    const res = await post({ resolved: true }, createFakeD1());
    const body = (await res.json()) as { issues: { path: string }[] };

    expect(res.status).toBe(400);
    expect(body.issues.some((i) => i.path === 'method')).toBe(true);
  });

  it('no acepta PII: los campos de más se ignoran, no se guardan', async () => {
    // El servidor nunca ve el perfil del usuario (regla 2).
    const fake = createFakeD1();

    await post({ method: 'barcode', resolved: true, userId: 'matias', perfil: { ritmo: 0.8 } }, fake);

    expect(Object.keys(fake.rows.scanEvents[0]!)).toEqual([
      'isbn13',
      'method',
      'resolved',
      'latency_ms',
      'created_at',
    ]);
  });
});
