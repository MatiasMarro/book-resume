/**
 * Fábrica de proveedores y verificación del catálogo.
 *
 * Es el único lugar que traduce env → proveedor. El resto del código pide
 * `crearProvider('cola', env)` y no sabe si atrás hay OpenAI, Workers AI o un
 * JSON del repo.
 *
 * ## El split cabeza / cola
 *
 * `LLM_PROVIDER` + `LLM_MODEL` para la cabeza (top ~500 títulos, modelo pago) y
 * `LLM_PROVIDER_TAIL` + `LLM_MODEL_TAIL` para la cola (free tier). Un cache miss
 * en vivo es, por definición, un libro que nadie escaneó todavía: es cola.
 *
 * ## La verificación del modelo, y por qué no puede correr "al arrancar"
 *
 * `workerd` **prohíbe hacer fetch en el scope global** de un módulo, así que no
 * existe un hook de arranque con red donde consultar el catálogo. Lo más
 * parecido es esto: una verificación perezosa, memoizada por isolate, que corre
 * la primera vez que se usa el proveedor y no vuelve a correr.
 *
 * Y falla **ruidosa pero no fatal**: loguea en `error` y deja que el llamador
 * degrade a metadata cruda. Tirar un 500 sería la lectura literal de "fallá
 * ruidoso", pero del otro lado hay alguien parado en el pasillo con el libro en
 * la mano: la ficha sin resumen le sirve, el error 500 no. El fallo duro de
 * verdad —`exit 1`— vive en `scripts/check-models.ts`, que corre antes de
 * deployar, que es cuando todavía se puede arreglar.
 */
import type { Bindings } from '../../env';
import type { LlmProvider, Tramo, VerificacionModelo } from '../types';
import { crearProveedorOpenAi } from './openai';
import { crearProveedorWorkersAi } from './workersai';
import { crearProveedorFixture } from './fixture';

export type ConfiguracionTramo = {
  provider: string;
  model: string;
};

/** El kill switch de docs/LLM.md. En false se degrada a metadata cruda. */
export function llmHabilitado(env: Pick<Bindings, 'LLM_ENABLED'>): boolean {
  return env.LLM_ENABLED?.trim().toLowerCase() === 'true';
}

export function configuracionDe(env: Bindings, tramo: Tramo): ConfiguracionTramo {
  return tramo === 'cabeza'
    ? { provider: env.LLM_PROVIDER?.trim() ?? '', model: env.LLM_MODEL?.trim() ?? '' }
    : { provider: env.LLM_PROVIDER_TAIL?.trim() ?? '', model: env.LLM_MODEL_TAIL?.trim() ?? '' };
}

export class ConfiguracionLlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfiguracionLlmError';
  }
}

/**
 * Construye el proveedor de un tramo.
 *
 * Devuelve `null` solo por el kill switch. Una configuración rota —proveedor
 * desconocido, modelo vacío, API key faltante— **lanza**: es un error de deploy
 * que hay que ver, no un modo degradado que haya que tolerar en silencio.
 */
export function crearProvider(tramo: Tramo, env: Bindings): LlmProvider | null {
  if (!llmHabilitado(env)) return null;

  const { provider, model } = configuracionDe(env, tramo);

  if (provider.length === 0) {
    throw new ConfiguracionLlmError(
      `falta el proveedor del tramo '${tramo}' (LLM_PROVIDER${tramo === 'cola' ? '_TAIL' : ''})`
    );
  }

  // El model ID nunca se hardcodea, así que un env vacío no tiene default
  // posible: es configuración incompleta y hay que decirlo.
  if (model.length === 0) {
    throw new ConfiguracionLlmError(
      `falta el model ID del tramo '${tramo}' (LLM_MODEL${tramo === 'cola' ? '_TAIL' : ''}). ` +
        'Los model IDs van siempre por env, nunca hardcodeados.'
    );
  }

  switch (provider) {
    case 'openai': {
      const apiKey = env.OPENAI_API_KEY?.trim();
      if (!apiKey) {
        throw new ConfiguracionLlmError(
          `el tramo '${tramo}' usa openai pero falta OPENAI_API_KEY (wrangler secret put OPENAI_API_KEY)`
        );
      }
      return crearProveedorOpenAi({ apiKey, model });
    }

    case 'workersai': {
      if (!env.AI) {
        throw new ConfiguracionLlmError(
          `el tramo '${tramo}' usa workersai pero falta el binding AI en wrangler.toml ([ai] binding = "AI")`
        );
      }
      return crearProveedorWorkersAi({
        ai: env.AI as unknown as { run: (model: string, inputs: unknown) => Promise<unknown> },
        model,
        ...(env.CF_ACCOUNT_ID && { accountId: env.CF_ACCOUNT_ID }),
        ...(env.CF_API_TOKEN && { apiToken: env.CF_API_TOKEN }),
      });
    }

    case 'fixture':
      return crearProveedorFixture({ model });

    default:
      throw new ConfiguracionLlmError(
        `proveedor desconocido: '${provider}'. Válidos: openai, workersai, fixture.`
      );
  }
}

/**
 * Caché de verificaciones, por isolate.
 *
 * La clave incluye el model ID: cambiar `LLM_MODEL` y redeployar tiene que
 * volver a verificar, y un isolate reciclado no tiene por qué arrastrar el
 * veredicto del modelo anterior.
 */
const verificaciones = new Map<string, Promise<VerificacionModelo>>();

/** Solo para tests: vacía la memoria del isolate. */
export function resetVerificaciones(): void {
  verificaciones.clear();
}

/**
 * Verifica el modelo una vez por isolate y loguea ruidoso si no existe.
 *
 * Devuelve `true` si se puede seguir. `no-verificable` **deja seguir**: es el
 * caso de Workers AI y del proveedor fixture, y apagar el enriquecimiento por
 * no poder listar un catálogo sería peor que el problema que evita.
 */
export async function modeloUsable(provider: LlmProvider, model: string): Promise<boolean> {
  const clave = `${provider.name}:${model}`;

  let pendiente = verificaciones.get(clave);
  if (!pendiente) {
    pendiente = provider.verificarModelo();
    verificaciones.set(clave, pendiente);
  }

  const veredicto = await pendiente;

  if (veredicto.estado === 'no-existe') {
    console.error(
      `[llm] MODELO INEXISTENTE — ${clave}: ${veredicto.motivo}. ` +
        'Los catálogos gratuitos desaparecen sin aviso: revisá LLM_MODEL / LLM_MODEL_TAIL. ' +
        (veredicto.modelosDisponibles?.length
          ? `Parecidos disponibles: ${veredicto.modelosDisponibles.join(', ')}`
          : '')
    );
    return false;
  }

  if (veredicto.estado === 'no-verificable') {
    console.warn(`[llm] catálogo no verificado — ${clave}: ${veredicto.motivo}`);
  }

  return true;
}
