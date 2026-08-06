/**
 * `waitUntil` sin que el runtime decida si el código compila.
 *
 * En Workers, devolver la respuesta mata el request salvo que el trabajo
 * pendiente esté registrado con `waitUntil`. Pero `c.executionCtx` **lanza** si
 * el contexto no existe, y no existe en dos lugares donde igual queremos correr:
 * los tests (`app.request(path, init, env)` no pasa ninguno) y cualquier runtime
 * que no lo exponga.
 *
 * Envolverlo acá evita que cada llamador repita el try/catch y —más importante—
 * que alguien lo omita y tire un 500 en producción por una tarea de fondo que
 * era opcional.
 */
import type { Context } from 'hono';
import type { AppEnv } from '../env';

/**
 * Registra una tarea para que el runtime la termine después de responder.
 *
 * La tarea **tiene que manejar sus propios errores**: acá no hay a quién
 * reportarle una falla, el request ya se fue.
 */
export function enSegundoPlano(c: Context<AppEnv>, tarea: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(tarea);
  } catch {
    // Sin ExecutionContext la promesa sigue corriendo igual mientras el isolate
    // viva. No es una garantía, pero es exactamente lo que necesitan los tests,
    // y en producción esta rama no se toca.
    void tarea;
  }
}
