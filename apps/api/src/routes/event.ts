/**
 * POST /api/event — registro anónimo de escaneo.
 *
 * Lo llama el cliente para los escaneos que el backend no ve: intentos que
 * nunca resolvieron a un ISBN (código ilegible, OCR fallido). Los que sí
 * resuelven ya quedan registrados desde GET /api/book/:isbn13.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { ScanEventSchema, recordScanEvent } from '../db/events';

export const event = new Hono<AppEnv>();

event.post('/api/event', async (c) => {
  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: 'json-invalido', message: 'El body tiene que ser JSON.' }, 400);
  }

  const parsed = ScanEventSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json(
      {
        error: 'evento-invalido',
        message: 'El evento no tiene la forma esperada.',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
      400
    );
  }

  const stored = await recordScanEvent(c.env.DB, parsed.data);

  // 202 y no 201: la telemetría es best-effort a propósito. Si D1 falla, el
  // cliente no tiene nada que reintentar ni que mostrarle al usuario.
  return c.json({ ok: stored }, 202);
});
