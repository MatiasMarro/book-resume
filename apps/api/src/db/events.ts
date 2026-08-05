/**
 * `scan_events` — telemetría anónima de escaneos.
 *
 * Sirve para dos cosas concretas: medir la tasa real de resolución (la métrica
 * de la Fase 1, pero en producción) y ver si el objetivo de <5s se cumple.
 *
 * **Sin PII.** No hay ID de usuario ni de dispositivo, a propósito: el perfil
 * vive en localStorage y el servidor no lo ve nunca.
 */
import { z } from 'zod';

export const SCAN_METHODS = ['barcode', 'ocr', 'manual'] as const;

export type ScanMethod = (typeof SCAN_METHODS)[number];

export const ScanEventSchema = z.object({
  /** Ausente cuando el escaneo no resolvió a ningún ISBN. */
  isbn13: z
    .string()
    .regex(/^\d{13}$/, 'ISBN-13 son 13 dígitos')
    .optional(),
  method: z.enum(SCAN_METHODS),
  resolved: z.boolean(),
  /** Milisegundos desde que se abrió la cámara hasta ver la ficha. */
  latencyMs: z.number().int().nonnegative().max(600_000).optional(),
});

export type ScanEvent = z.infer<typeof ScanEventSchema>;

/**
 * Inserta un evento. **Nunca lanza**: la telemetría no puede romper un escaneo.
 * Devuelve si se pudo guardar, para poder loguearlo sin cortar la respuesta.
 */
export async function recordScanEvent(
  db: D1Database,
  event: ScanEvent,
  now: number = Date.now()
): Promise<boolean> {
  try {
    await db
      .prepare(
        `INSERT INTO scan_events (isbn13, method, resolved, latency_ms, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(
        event.isbn13 ?? null,
        event.method,
        event.resolved ? 1 : 0,
        event.latencyMs ?? null,
        now
      )
      .run();

    return true;
  } catch {
    return false;
  }
}
