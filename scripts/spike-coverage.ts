/**
 * Spike de cobertura — la medición del go/no-go de la Fase 1.
 *
 * Responde una sola pregunta: **¿qué porcentaje del catálogo real llega con al
 * menos una descripción usable (>200 caracteres)?** Debajo de 60% el producto
 * tiene que cambiar de forma, porque enriquecer con LLM un libro sin fuente no
 * arregla la cobertura: la empeora, el modelo inventa (PLAN.md, Fase 1).
 *
 * ## Por qué reusa los normalizadores de apps/api/src/sources/
 *
 * La alternativa era pegarle crudo a las APIs desde acá. Se descartó: mediría
 * lo que la API *tiene*, no lo que el producto *extrae*. Un campo que existe en
 * el JSON pero que el normalizador descarta —el guard de Wikipedia rechazando
 * al autor, el footer que `stripOlFooter` corta— no es cobertura real. Además
 * una segunda copia de la lógica se desincroniza en la primera semana.
 *
 * ## Diferencia deliberada con la cascada de producción
 *
 * `resolver/cascade.ts` llama a Wikipedia **solo** si las otras dos no dieron
 * descripción, porque es cara y poco precisa. Acá se la llama **siempre** que
 * haya título: el spike mide cobertura POR FUENTE, y para eso necesita saber
 * qué aporta Wikipedia incluso cuando la cascada no la habría consultado.
 * Por eso el total del spike es un techo, no la cobertura del endpoint.
 *
 * Uso:
 *   npm run spike
 *
 * Lee `scripts/isbns.txt` (un ISBN-13 por línea) y escribe
 * `scripts/spike-results.json`. No usa LLM, ni base, ni backend.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { fetchOpenLibrary } from '../apps/api/src/sources/openlibrary';
import { fetchGoogleBooks } from '../apps/api/src/sources/googlebooks';
import { fetchWikipedia } from '../apps/api/src/sources/wikipedia';
import type { SourceRecord } from '../apps/api/src/sources/types';

/** La línea roja del PLAN: debajo de esto el producto cambia de forma. */
const UMBRAL_DESCRIPCION = 200;

/** Cortesía con APIs que no cobran. Open Library y Wikipedia lo piden en sus ToS. */
const PAUSA_MS = 250;

/**
 * Las rutas se resuelven contra la raíz del repo y no contra `import.meta.url`:
 * el script se bundlea a `scripts/.build/` antes de correr, así que la ruta del
 * módulo apunta al bundle y no al fuente. `npm run` siempre deja el cwd en el
 * directorio del package.json, o sea la raíz. Correlo con `npm run spike`.
 */
const RAIZ = process.cwd();
const DIR_SCRIPTS = join(RAIZ, 'scripts');

type MedicionFuente = {
  resuelto: boolean;
  /** Largo de la descripción más larga que aportó la fuente. 0 si no aportó. */
  descripcionChars: number;
  subjects: number;
  tapa: boolean;
  /** Idioma del libro según la fuente, no del texto. */
  idioma?: string;
};

type MedicionIsbn = {
  isbn13: string;
  titulo?: string;
  autor?: string;
  openlibrary: MedicionFuente;
  googlebooks: MedicionFuente;
  wikipedia: MedicionFuente;
  /** La métrica que decide el go/no-go. */
  tieneDescripcionUsable: boolean;
  mejorDescripcionChars: number;
};

const SIN_DATOS: MedicionFuente = {
  resuelto: false,
  descripcionChars: 0,
  subjects: 0,
  tapa: false,
};

function dormir(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Traduce un SourceRecord a las cuatro cosas que el spike mide. */
function medir(record: SourceRecord | null): MedicionFuente {
  if (!record) return { ...SIN_DATOS };

  const descripcionChars = record.descriptions.reduce(
    (max, d) => Math.max(max, d.text.trim().length),
    0
  );

  return {
    resuelto: true,
    descripcionChars,
    subjects: record.subjects.length,
    tapa: record.coverUrl !== undefined,
    ...(record.language && { idioma: record.language }),
  };
}

/**
 * Las fuentes ya fallan suave (devuelven null), pero un bug de normalización sí
 * lanzaría. Un ISBN roto no puede cortar una corrida de 30 que tarda minutos.
 */
async function seguro<T>(etiqueta: string, fn: () => Promise<T | null>): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    console.error(`  ⚠ ${etiqueta} lanzó:`, error instanceof Error ? error.message : error);
    return null;
  }
}

async function medirIsbn(isbn13: string, googleBooksKey?: string): Promise<MedicionIsbn> {
  const ol = await seguro('openlibrary', () => fetchOpenLibrary(isbn13));
  await dormir(PAUSA_MS);

  const gb = await seguro('googlebooks', () => fetchGoogleBooks(isbn13, googleBooksKey));
  await dormir(PAUSA_MS);

  // Wikipedia no entiende de ISBN: sin título de otra fuente no hay consulta.
  const titulo = ol?.title ?? gb?.title;
  const autor = ol?.authors?.[0] ?? gb?.authors?.[0];

  let wiki: SourceRecord | null = null;
  if (titulo) {
    wiki = await seguro('wikipedia', () =>
      fetchWikipedia({ title: titulo, ...(autor && { author: autor }) })
    );
    await dormir(PAUSA_MS);
  }

  const openlibrary = medir(ol);
  const googlebooks = medir(gb);
  const wikipedia = medir(wiki);

  const mejorDescripcionChars = Math.max(
    openlibrary.descripcionChars,
    googlebooks.descripcionChars,
    wikipedia.descripcionChars
  );

  return {
    isbn13,
    ...(titulo && { titulo }),
    ...(autor && { autor }),
    openlibrary,
    googlebooks,
    wikipedia,
    tieneDescripcionUsable: mejorDescripcionChars > UMBRAL_DESCRIPCION,
    mejorDescripcionChars,
  };
}

/**
 * El `.env` de la raíz es el de los scripts de Node — wrangler lee
 * `apps/api/.dev.vars` y nunca este archivo (CLAUDE.md, "Áreas de atención").
 * Si falta se sigue igual: el resumen avisa fuerte cuando no hay key.
 */
function cargarEnv(): void {
  try {
    process.loadEnvFile(join(RAIZ, '.env'));
  } catch {
    // También se puede correr con las vars ya exportadas en el entorno.
  }
}

function porcentaje(parte: number, total: number): number {
  return total === 0 ? 0 : Math.round((parte / total) * 1000) / 10;
}

/**
 * El veredicto de la tabla del PLAN.md. Se imprime en vez de dejarlo a
 * interpretación: el punto de la fase es tomar una decisión, no juntar datos.
 */
function veredicto(pct: number): string {
  if (pct > 75) return '🟢 VERDE — seguí con el plan tal cual.';
  if (pct >= 60) return '🟡 AMARILLO — seguí, pero diseñá bien el estado "info limitada".';
  return '🔴 ROJO — PARÁ. El producto tiene que cambiar de forma (ver PLAN.md, Fase 1).';
}

async function main(): Promise<void> {
  cargarEnv();
  const googleBooksKey = process.env['GOOGLE_BOOKS_KEY']?.trim() || undefined;

  const archivo = join(DIR_SCRIPTS, 'isbns.txt');
  const isbns = (await readFile(archivo, 'utf8'))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

  console.log(`\nSpike de cobertura — ${isbns.length} ISBN\n`);

  if (!googleBooksKey) {
    // No es un detalle: es la fuente con mejor catálogo en español y su cupo
    // anónimo es cero. Sin ella el número que sale NO cierra el go/no-go.
    console.warn(
      '⚠️  GOOGLE_BOOKS_KEY no está cargada. Google Books se saltea entero y el\n' +
        '    resultado NO es válido para el go/no-go de la Fase 1.\n'
    );
  }

  const resultados: MedicionIsbn[] = [];

  for (const [i, isbn13] of isbns.entries()) {
    process.stdout.write(`[${String(i + 1).padStart(2)}/${isbns.length}] ${isbn13} … `);
    const medicion = await medirIsbn(isbn13, googleBooksKey);
    resultados.push(medicion);

    const marca = medicion.tieneDescripcionUsable ? '✓' : '✗';
    const titulo = medicion.titulo ?? '(no resuelto)';
    console.log(`${marca} ${medicion.mejorDescripcionChars} chars · ${titulo.slice(0, 45)}`);
  }

  // --- Tabla ---------------------------------------------------------------
  console.log('\n');
  console.table(
    resultados.map((r) => ({
      ISBN: r.isbn13,
      OL: r.openlibrary.resuelto ? r.openlibrary.descripcionChars : '—',
      GB: r.googlebooks.resuelto ? r.googlebooks.descripcionChars : '—',
      Wiki: r.wikipedia.resuelto ? r.wikipedia.descripcionChars : '—',
      Subjects:
        r.openlibrary.subjects + r.googlebooks.subjects + r.wikipedia.subjects,
      Tapa: r.openlibrary.tapa || r.googlebooks.tapa ? 'sí' : 'no',
      Idioma: r.openlibrary.idioma ?? r.googlebooks.idioma ?? '—',
      Usable: r.tieneDescripcionUsable ? 'SÍ' : 'no',
    }))
  );

  // --- Resumen -------------------------------------------------------------
  const total = resultados.length;
  const conDescripcion = resultados.filter((r) => r.tieneDescripcionUsable).length;
  const pctDescripcion = porcentaje(conDescripcion, total);

  const fallaronTodo = resultados.filter(
    (r) => !r.openlibrary.resuelto && !r.googlebooks.resuelto && !r.wikipedia.resuelto
  );

  const resumen = {
    fecha: new Date().toISOString(),
    total,
    googleBooksHabilitada: googleBooksKey !== undefined,
    /** LA MÉTRICA: % con al menos una descripción de más de 200 chars. */
    pctConDescripcionUsable: pctDescripcion,
    pctResueltoPorFuente: {
      openlibrary: porcentaje(resultados.filter((r) => r.openlibrary.resuelto).length, total),
      googlebooks: porcentaje(resultados.filter((r) => r.googlebooks.resuelto).length, total),
      wikipedia: porcentaje(resultados.filter((r) => r.wikipedia.resuelto).length, total),
    },
    pctConDescripcionPorFuente: {
      openlibrary: porcentaje(
        resultados.filter((r) => r.openlibrary.descripcionChars > UMBRAL_DESCRIPCION).length,
        total
      ),
      googlebooks: porcentaje(
        resultados.filter((r) => r.googlebooks.descripcionChars > UMBRAL_DESCRIPCION).length,
        total
      ),
      wikipedia: porcentaje(
        resultados.filter((r) => r.wikipedia.descripcionChars > UMBRAL_DESCRIPCION).length,
        total
      ),
    },
    isbnsSinResolver: fallaronTodo.map((r) => r.isbn13),
  };

  console.log('\n─── Resumen ───────────────────────────────────────────────\n');
  console.log(`  Con descripción usable (>${UMBRAL_DESCRIPCION} chars):`);
  console.log(`    ${conDescripcion}/${total} = ${pctDescripcion}%   ← LA MÉTRICA\n`);
  console.log('  Resuelto por fuente:');
  for (const [fuente, pct] of Object.entries(resumen.pctResueltoPorFuente)) {
    const conDesc = resumen.pctConDescripcionPorFuente[
      fuente as keyof typeof resumen.pctConDescripcionPorFuente
    ];
    console.log(`    ${fuente.padEnd(12)} ${String(pct).padStart(5)}%   (con descripción: ${conDesc}%)`);
  }

  if (fallaronTodo.length > 0) {
    console.log(`\n  No resolvieron en NINGUNA fuente (${fallaronTodo.length}):`);
    for (const r of fallaronTodo) console.log(`    ${r.isbn13}`);
  }

  console.log(`\n  ${veredicto(pctDescripcion)}`);

  if (!googleBooksKey) {
    console.log('\n  ⚠️  Sin GOOGLE_BOOKS_KEY: este número NO cierra el go/no-go.');
  } else if (resumen.pctResueltoPorFuente.googlebooks === 0) {
    // Tener la key cargada no alcanza: la Books API se habilita aparte en el
    // proyecto de Google Cloud, y sin habilitar devuelve 403 a todo. Como
    // `fetchJson` traduce cualquier error a null, la diferencia entre "no
    // habilitada" y "no conoce ninguno de estos libros" es invisible desde acá.
    // Un 0% con key cargada es siempre sospechoso: son 30 ISBN de catálogo real.
    console.log(
      '\n  ⚠️  GOOGLE_BOOKS_KEY está cargada pero Google Books resolvió 0/30.\n' +
        '      Casi seguro la Books API no está habilitada en el proyecto, o la key\n' +
        '      tiene restricción por API. Verificalo con:\n' +
        '        curl "https://books.googleapis.com/books/v1/volumes?q=isbn:9788433920423&key=TU_KEY"\n' +
        '      Hasta resolverlo este número NO cierra el go/no-go.'
    );
  }
  console.log('');

  const salida = join(DIR_SCRIPTS, 'spike-results.json');
  await writeFile(salida, JSON.stringify({ resumen, resultados }, null, 2), 'utf8');
  console.log(`Detalle en ${salida}\n`);
}

main().catch((error) => {
  console.error('El spike murió:', error);
  process.exit(1);
});
