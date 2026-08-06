/**
 * Proveedor Cloudflare Workers AI — el default de la cola larga.
 *
 * Es la opción obvia para la cola: 10.000 neuronas por día gratis, binding
 * nativo (o sea sin API key, sin round trip a otro proveedor) y ya estamos
 * corriendo adentro de Workers. Lo que no da es garantía de forma.
 *
 * ## Por qué supportsStrictSchema es false
 *
 * Workers AI acepta `response_format` con JSON schema, pero la restricción es
 * best effort: según el modelo, la salida puede venir envuelta en ```json, con
 * texto antes, o con un campo de más. Por eso el pipeline mantiene el reintento
 * por JSON malformado para este proveedor (docs/LLM.md, "Salida estructurada").
 *
 * ## Por qué el catálogo no se puede verificar desde acá
 *
 * El binding `AI` corre inferencia pero no lista modelos: el catálogo vive en
 * `api.cloudflare.com/client/v4/accounts/{id}/ai/models/search` y pide un
 * account ID y un API token que el Worker no tiene por qué tener. Si están
 * configurados se verifica de verdad; si no, se devuelve `no-verificable` y el
 * chequeo duro queda para `scripts/check-models.ts`, que sí corre con las
 * credenciales de wrangler. Mentir con un `ok` acá sería peor que no verificar.
 */
import { NOMBRE_SCHEMA, jsonSchemaEnriquecimiento } from '../schema';
import { BLOQUE_SISTEMA, construirMensajeUsuario } from '../prompts';
import { LlmError, type EnrichRaw, type EnrichRequest, type LlmProvider, type VerificacionModelo } from '../types';
import { MAX_TOKENS_SALIDA } from './openai';

export type WorkersAiDeps = {
  /** El binding nativo. Se tipa laxo porque el model ID viene de env. */
  ai: { run: (model: string, inputs: unknown) => Promise<unknown> };
  model: string;
  /** Solo para `verificarModelo()`. Sin esto la verificación es indeterminada. */
  accountId?: string;
  apiToken?: string;
  fetchImpl?: typeof fetch;
};

type RespuestaWorkersAi = {
  response?: unknown;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

/**
 * Rescata el objeto JSON de una respuesta que puede venir de tres formas:
 * ya parseada, como string limpio, o como string dentro de un bloque ```json.
 *
 * Los modelos abiertos hacen las tres cosas según el día. Devuelve `undefined`
 * en vez de lanzar: el pipeline reintenta, que es más barato que fallar.
 */
export function extraerJson(response: unknown): unknown | undefined {
  if (response !== null && typeof response === 'object') return response;
  if (typeof response !== 'string') return undefined;

  const sinCerca = response.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');

  try {
    return JSON.parse(sinCerca);
  } catch {
    // Último intento: el objeto más externo que haya en el texto. Cubre el caso
    // del modelo que antepone "Acá está el JSON:".
    const inicio = sinCerca.indexOf('{');
    const fin = sinCerca.lastIndexOf('}');
    if (inicio === -1 || fin <= inicio) return undefined;

    try {
      return JSON.parse(sinCerca.slice(inicio, fin + 1));
    } catch {
      return undefined;
    }
  }
}

export function crearProveedorWorkersAi(deps: WorkersAiDeps): LlmProvider {
  return {
    name: 'workersai',
    supportsStrictSchema: false,

    async complete(req: EnrichRequest): Promise<EnrichRaw> {
      let cruda: unknown;
      try {
        cruda = await deps.ai.run(deps.model, {
          messages: [
            { role: 'system', content: BLOQUE_SISTEMA },
            { role: 'user', content: construirMensajeUsuario(req) },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: { name: NOMBRE_SCHEMA, schema: jsonSchemaEnriquecimiento() },
          },
          max_tokens: MAX_TOKENS_SALIDA,
        });
      } catch (error) {
        throw new LlmError(
          `Workers AI falló: ${error instanceof Error ? error.message : String(error)}`,
          'workersai',
          true
        );
      }

      const respuesta = (cruda ?? {}) as RespuestaWorkersAi;
      const data = extraerJson(respuesta.response);

      if (data === undefined) {
        // Reintentable a propósito: con un proveedor abierto, la misma request
        // sale bien seguido a la segunda.
        throw new LlmError('Workers AI devolvió algo que no es JSON', 'workersai', true);
      }

      return {
        data,
        modelUsed: deps.model,
        ...(respuesta.usage?.prompt_tokens !== undefined && {
          promptTokens: respuesta.usage.prompt_tokens,
        }),
        ...(respuesta.usage?.completion_tokens !== undefined && {
          outputTokens: respuesta.usage.completion_tokens,
        }),
        usage: respuesta.usage,
      };
    },

    async verificarModelo(): Promise<VerificacionModelo> {
      if (!deps.accountId || !deps.apiToken) {
        return {
          estado: 'no-verificable',
          motivo:
            'el binding AI no lista modelos y no hay CF_ACCOUNT_ID/CF_API_TOKEN: ' +
            'verificá el catálogo con `npm run check:models` antes de deployar',
        };
      }

      const fetchImpl = deps.fetchImpl ?? fetch;

      try {
        const res = await fetchImpl(
          `https://api.cloudflare.com/client/v4/accounts/${deps.accountId}/ai/models/search?per_page=200`,
          { headers: { Authorization: `Bearer ${deps.apiToken}` } }
        );

        if (!res.ok) {
          return {
            estado: 'no-verificable',
            motivo: `la API de Cloudflare respondió ${res.status} al listar modelos`,
          };
        }

        const body = (await res.json()) as { result?: { name?: string }[] };
        const nombres = (body.result ?? [])
          .map((m) => m.name)
          .filter((n): n is string => typeof n === 'string');

        if (nombres.includes(deps.model)) return { estado: 'ok' };

        return {
          estado: 'no-existe',
          motivo: `'${deps.model}' no está en el catálogo de Workers AI de la cuenta`,
          modelosDisponibles: nombres.filter((n) => n.includes('instruct')).slice(0, 20),
        };
      } catch (error) {
        return {
          estado: 'no-verificable',
          motivo: `no se pudo consultar el catálogo de Workers AI: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  };
}
