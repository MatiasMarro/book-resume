/**
 * Verificación de los model IDs configurados. **Corrélo antes de cada deploy.**
 *
 * ## Por qué esto existe además de la verificación del Worker
 *
 * El punto 1 de la Fase 3 pide fallar ruidoso si el modelo configurado no
 * existe. Adentro del Worker eso tiene dos límites duros:
 *
 * 1. `workerd` prohíbe hacer fetch en el scope global de un módulo, así que no
 *    hay ningún "al arrancar" con red donde consultar el catálogo. Lo más
 *    parecido es una verificación perezosa en la primera llamada.
 * 2. Aun corriendo, no puede tirar la request abajo: del otro lado hay alguien
 *    parado en el pasillo, y una ficha sin resumen le sirve más que un 500.
 *
 * Este script no tiene ninguno de los dos límites: corre en tu máquina, con las
 * credenciales completas, antes de que el deploy le llegue a nadie. Acá el fallo
 * duro es `exit 1`, que es lo que hace falta cuando todavía se puede arreglar.
 *
 * Motivo de fondo: el 31 de mayo de 2026 un proveedor borró en silencio la
 * mayoría de sus modelos gratis y las pipelines que los tenían hardcodeados
 * murieron sin aviso (docs/LLM.md).
 *
 * Uso:
 *   npm run check:models
 */
import { join } from 'node:path';

const RAIZ = process.cwd();

type Tramo = 'cabeza' | 'cola';

type Config = {
  tramo: Tramo;
  provider: string;
  model: string;
};

type Veredicto =
  | { estado: 'ok'; detalle: string }
  | { estado: 'no-existe'; detalle: string; parecidos: string[] }
  | { estado: 'no-verificable'; detalle: string };

function cargarEnv(): void {
  try {
    process.loadEnvFile(join(RAIZ, '.env'));
  } catch {
    // También sirve con las vars ya exportadas en el entorno.
  }
}

function leer(nombre: string): string {
  return (process.env[nombre] ?? '').trim();
}

async function verificarOpenAi(model: string): Promise<Veredicto> {
  const apiKey = leer('OPENAI_API_KEY');
  if (!apiKey) {
    return { estado: 'no-verificable', detalle: 'falta OPENAI_API_KEY en el .env de la raíz' };
  }

  const res = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    return {
      estado: 'no-verificable',
      detalle: `la API de OpenAI respondió ${res.status} al listar el catálogo`,
    };
  }

  const body = (await res.json()) as { data?: { id?: string }[] };
  const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => !!id);

  if (ids.includes(model)) {
    return { estado: 'ok', detalle: `${ids.length} modelos en el catálogo de la cuenta` };
  }

  const prefijo = model.split('-')[0] ?? '';
  return {
    estado: 'no-existe',
    detalle: `'${model}' no está en el catálogo de la cuenta`,
    parecidos: ids.filter((id) => id.startsWith(prefijo)).slice(0, 10),
  };
}

async function verificarWorkersAi(model: string): Promise<Veredicto> {
  const accountId = leer('CF_ACCOUNT_ID');
  const apiToken = leer('CF_API_TOKEN');

  if (!accountId || !apiToken) {
    return {
      estado: 'no-verificable',
      detalle:
        'faltan CF_ACCOUNT_ID / CF_API_TOKEN. El binding AI corre inferencia pero no ' +
        'lista modelos: el catálogo solo se consulta con la API de Cloudflare.',
    };
  }

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?per_page=200`,
    { headers: { Authorization: `Bearer ${apiToken}` } }
  );

  if (!res.ok) {
    return {
      estado: 'no-verificable',
      detalle: `la API de Cloudflare respondió ${res.status} al listar modelos`,
    };
  }

  const body = (await res.json()) as { result?: { name?: string }[] };
  const nombres = (body.result ?? []).map((m) => m.name).filter((n): n is string => !!n);

  if (nombres.includes(model)) {
    return { estado: 'ok', detalle: `${nombres.length} modelos en Workers AI` };
  }

  return {
    estado: 'no-existe',
    detalle: `'${model}' no está en el catálogo de Workers AI de la cuenta`,
    parecidos: nombres.filter((n) => n.includes('instruct')).slice(0, 10),
  };
}

async function verificar(config: Config): Promise<Veredicto> {
  if (config.model.length === 0) {
    return {
      estado: 'no-existe',
      detalle: 'el model ID está vacío. Va siempre por env, y no hay default posible.',
      parecidos: [],
    };
  }

  switch (config.provider) {
    case 'openai':
      return verificarOpenAi(config.model);
    case 'workersai':
      return verificarWorkersAi(config.model);
    case 'fixture':
      return {
        estado: 'no-verificable',
        detalle: "el proveedor 'fixture' no consulta ningún catálogo (es el default de desarrollo)",
      };
    default:
      return {
        estado: 'no-existe',
        detalle: `proveedor desconocido: '${config.provider}'. Válidos: openai, workersai, fixture.`,
        parecidos: [],
      };
  }
}

async function main(): Promise<void> {
  cargarEnv();

  if (leer('LLM_ENABLED').toLowerCase() !== 'true') {
    console.log('\nLLM_ENABLED no es "true": el enriquecimiento está apagado, nada que verificar.\n');
    return;
  }

  const configs: Config[] = [
    { tramo: 'cabeza', provider: leer('LLM_PROVIDER'), model: leer('LLM_MODEL') },
    { tramo: 'cola', provider: leer('LLM_PROVIDER_TAIL'), model: leer('LLM_MODEL_TAIL') },
  ];

  console.log('\nVerificando los model IDs configurados\n');

  let hayFaltantes = false;

  for (const config of configs) {
    const etiqueta = `${config.tramo.padEnd(7)} ${config.provider}/${config.model}`;

    let veredicto: Veredicto;
    try {
      veredicto = await verificar(config);
    } catch (error) {
      veredicto = {
        estado: 'no-verificable',
        detalle: `error de red: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (veredicto.estado === 'ok') {
      console.log(`  ✓ ${etiqueta}\n      ${veredicto.detalle}`);
    } else if (veredicto.estado === 'no-verificable') {
      console.log(`  ? ${etiqueta}\n      ${veredicto.detalle}`);
    } else {
      hayFaltantes = true;
      console.error(`  ✗ ${etiqueta}\n      ${veredicto.detalle}`);
      if (veredicto.parecidos.length > 0) {
        console.error(`      Parecidos disponibles: ${veredicto.parecidos.join(', ')}`);
      }
    }
  }

  if (hayFaltantes) {
    console.error(
      '\n🔴 Hay un model ID que no existe. NO deployes: el enriquecimiento se va a\n' +
        '   degradar en silencio a metadata cruda. Corregí LLM_MODEL / LLM_MODEL_TAIL.\n'
    );
    process.exit(1);
  }

  console.log('\n🟢 Todo lo verificable está en orden.\n');
}

main().catch((error) => {
  console.error('check-models murió:', error);
  process.exit(1);
});
