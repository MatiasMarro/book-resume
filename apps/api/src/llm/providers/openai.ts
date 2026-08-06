/**
 * Proveedor OpenAI — el de la cabeza (docs/LLM.md, "El split").
 *
 * Es el único con salida estructurada de verdad: `response_format` con
 * `json_schema` y `strict: true` restringe la **decodificación**, o sea que el
 * modelo no puede emitir un token que rompa el schema. Por eso
 * `supportsStrictSchema` es `true` y el pipeline se saltea el reintento por
 * JSON malformado.
 *
 * ## Tokens de razonamiento
 *
 * Los GPT-5.x emiten tokens de razonamiento que se facturan como output
 * ($1.20/M en Luna). Esta tarea es extracción y no los necesita, así que se pide
 * `reasoning_effort` al mínimo. No todos los modelos aceptan el parámetro: si el
 * API lo rechaza, se reintenta sin él una sola vez (ver `esParametroNoSoportado`).
 *
 * ## Model IDs
 *
 * Siempre por env. El catálogo se consulta en `verificarModelo()` porque los
 * modelos desaparecen sin aviso — CLAUDE.md lo prohíbe explícitamente y
 * docs/LLM.md cuenta el caso del 31 de mayo de 2026.
 */
import OpenAI from 'openai';
import { NOMBRE_SCHEMA, jsonSchemaEnriquecimiento } from '../schema';
import { BLOQUE_SISTEMA, construirMensajeUsuario } from '../prompts';
import { LlmError, type EnrichRaw, type EnrichRequest, type LlmProvider, type VerificacionModelo } from '../types';

/** Regla de gasto de docs/LLM.md: el techo de salida por libro. */
export const MAX_TOKENS_SALIDA = 700;

export type OpenAiDeps = {
  apiKey: string;
  model: string;
  /** Inyectable para testear sin red. */
  cliente?: OpenAI;
};

/**
 * El API contesta 400 cuando un modelo no conoce un parámetro. Es un error de
 * configuración recuperable, no una caída: se reintenta sin el parámetro.
 */
function esParametroNoSoportado(error: unknown, parametro: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const mensaje = String((error as { message?: unknown }).message ?? '');
  return /unsupported|unrecognized|not supported|unknown parameter/i.test(mensaje) &&
    mensaje.includes(parametro);
}

export function crearProveedorOpenAi(deps: OpenAiDeps): LlmProvider {
  const cliente = deps.cliente ?? new OpenAI({ apiKey: deps.apiKey });

  async function pedir(req: EnrichRequest, conRazonamiento: boolean) {
    return cliente.chat.completions.create({
      model: deps.model,
      messages: [
        // El bloque de sistema va primero y sin variaciones: es lo que cachea
        // OpenAI al 10% del input (docs/LLM.md, "Caché de prompt").
        { role: 'system', content: BLOQUE_SISTEMA },
        { role: 'user', content: construirMensajeUsuario(req) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: NOMBRE_SCHEMA,
          strict: true,
          schema: jsonSchemaEnriquecimiento(),
        },
      },
      max_completion_tokens: MAX_TOKENS_SALIDA,
      ...(conRazonamiento && { reasoning_effort: 'minimal' as const }),
    });
  }

  return {
    name: 'openai',
    supportsStrictSchema: true,

    async complete(req: EnrichRequest): Promise<EnrichRaw> {
      let respuesta;
      try {
        respuesta = await pedir(req, true);
      } catch (error) {
        if (!esParametroNoSoportado(error, 'reasoning_effort')) {
          throw new LlmError(
            `OpenAI falló: ${error instanceof Error ? error.message : String(error)}`,
            'openai',
            true
          );
        }
        // Este modelo no razona: no hay tokens ocultos que apagar y sale más
        // barato de lo estimado. Se sigue sin el parámetro.
        respuesta = await pedir(req, false);
      }

      const contenido = respuesta.choices[0]?.message?.content;
      if (!contenido) {
        // Con strict:true esto solo pasa si la respuesta se cortó por
        // max_completion_tokens, que es un problema de presupuesto, no de forma.
        throw new LlmError(
          `OpenAI devolvió una respuesta vacía (finish_reason: ${respuesta.choices[0]?.finish_reason ?? '?'})`,
          'openai',
          true
        );
      }

      let data: unknown;
      try {
        data = JSON.parse(contenido);
      } catch {
        throw new LlmError('OpenAI devolvió JSON no parseable pese a strict:true', 'openai', true);
      }

      return {
        data,
        modelUsed: respuesta.model,
        ...(respuesta.usage?.prompt_tokens !== undefined && {
          promptTokens: respuesta.usage.prompt_tokens,
        }),
        ...(respuesta.usage?.completion_tokens !== undefined && {
          outputTokens: respuesta.usage.completion_tokens,
        }),
        // El `usage` entero, para comparar `completion_tokens` contra el largo
        // real del texto: una brecha grande son tokens de razonamiento.
        usage: respuesta.usage,
      };
    },

    async verificarModelo(): Promise<VerificacionModelo> {
      try {
        const catalogo = await cliente.models.list();
        const ids = catalogo.data.map((m) => m.id);

        if (ids.includes(deps.model)) return { estado: 'ok' };

        return {
          estado: 'no-existe',
          motivo: `el modelo '${deps.model}' no está en el catálogo de la cuenta`,
          // Solo los que se parecen: la lista entera son cientos y el log se
          // vuelve ilegible justo cuando hace falta leerlo.
          modelosDisponibles: ids.filter((id) => id.startsWith(deps.model.split('-')[0] ?? '')),
        };
      } catch (error) {
        return {
          estado: 'no-verificable',
          motivo: `no se pudo listar el catálogo de OpenAI: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  };
}
