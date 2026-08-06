/**
 * Guard de salida: la última barrera antes de que un spoiler llegue al lector.
 *
 * `sanitize.ts` controla qué **entra** al modelo; esto revisa qué **sale**. Son
 * capas distintas y las dos hacen falta: una contratapa perfectamente legítima
 * puede insinuar el desenlace, y un modelo chico completa la insinuación con
 * total naturalidad.
 *
 * Detecta construcciones de revelación, no temas. No le importa que un libro
 * sea triste; le importa que el resumen diga **qué pasa**.
 *
 * ## Qué pasa cuando salta
 *
 * Un reintento con instrucción reforzada. Si vuelve a saltar, el
 * enriquecimiento se guarda igual pero con el confidence penalizado y marcado
 * para revisión: tirar la ficha entera dejaría al libro sin nada, y una ficha
 * sospechosa con confidence bajo es mejor que una pantalla vacía para alguien
 * que está parado en el pasillo.
 */

export type PatronSpoiler = {
  nombre: string;
  patron: RegExp;
};

/**
 * Las construcciones que delatan una revelación.
 *
 * Todas describen la **forma** de contar algo que pasa después del planteo. Por
 * eso funcionan igual de bien en un policial que en un ensayo: el problema
 * nunca fue el tema.
 */
export const PATRONES_SPOILER: PatronSpoiler[] = [
  { nombre: 'al-final', patron: /\bal final\b/i },
  { nombre: 'hacia-el-final', patron: /\bhacia el (final|desenlace)\b/i },
  { nombre: 'resulta-que', patron: /\bresulta(?:rá|ría)? (que|ser)\b/i },
  { nombre: 'se-revela', patron: /\b(se revela|revelará|revelándose|se descubre) que\b/i },
  { nombre: 'descubre-que', patron: /\bdescubr(e|irá|iendo) que (en realidad|es|era|su|el|la)\b/i },
  { nombre: 'termina-con', patron: /\btermina (con|siendo|por|en)\b/i },
  { nombre: 'acaba-con', patron: /\bacaba (con|siendo|por)\b/i },
  { nombre: 'termina-gerundio', patron: /\btermin(a|ará)n? \w+ando\b/i },
  { nombre: 'desenlace', patron: /\b(el desenlace|el clímax|la última página|las últimas páginas)\b/i },
  { nombre: 'en-realidad', patron: /\ben realidad (es|era|fue|se trata)\b/i },
  /**
   * El **verbo**, no el sustantivo. "Muere" en un resumen de 80 palabras es casi
   * siempre un evento de la trama que se está contando. "La muerte de su padre"
   * es, en cambio, la premisa de un tercio de las novelas que existen: marcarla
   * haría saltar el guard sobre medio catálogo y la penalización dejaría de
   * significar algo.
   */
  { nombre: 'muere', patron: /\bmuere[n]?\b/i },
  { nombre: 'termina-muriendo', patron: /\b(morirá|acabará muriendo|termina muriendo)\b/i },
  { nombre: 'se-suicida', patron: /\bse suicida\b/i },
  { nombre: 'asesina-a', patron: /\b(asesina|mata) a (su|el|la|los|las)\b/i },
  { nombre: 'traiciona', patron: /\b(traiciona|traicionará) a\b/i },
  { nombre: 'spoiler-explicito', patron: /\bspoiler\b/i },
];

export type Hallazgo = {
  nombre: string;
  /** El fragmento exacto que matcheó, para poder leer el log y entenderlo. */
  fragmento: string;
  /** En qué campo apareció. */
  campo: 'summary' | 'hook';
};

export type VeredictoSpoiler =
  | { limpio: true }
  | { limpio: false; hallazgos: Hallazgo[] };

/** Cuánto contexto se guarda alrededor del match para el log. */
const CONTEXTO = 40;

function buscarEn(texto: string, campo: Hallazgo['campo']): Hallazgo[] {
  const hallazgos: Hallazgo[] = [];

  for (const { nombre, patron } of PATRONES_SPOILER) {
    const match = texto.match(patron);
    if (match?.index === undefined) continue;

    const desde = Math.max(0, match.index - CONTEXTO);
    const hasta = Math.min(texto.length, match.index + match[0].length + CONTEXTO);

    hallazgos.push({ nombre, campo, fragmento: texto.slice(desde, hasta).trim() });
  }

  return hallazgos;
}

/**
 * Revisa el texto que ve el lector.
 *
 * Solo `summary` y `hook`: son los dos campos en prosa. `genres` y
 * `comparables` son etiquetas y `content_flags` es vocabulario cerrado —
 * marcar `final-tragico` es información que el lector pidió, no un spoiler.
 */
export function revisarSpoilers(salida: { summary: string; hook: string }): VeredictoSpoiler {
  const hallazgos = [...buscarEn(salida.summary, 'summary'), ...buscarEn(salida.hook, 'hook')];

  return hallazgos.length === 0 ? { limpio: true } : { limpio: false, hallazgos };
}

/**
 * Factor que se le aplica al confidence cuando el guard saltó dos veces.
 *
 * Es más agresivo que el ×0.8 de la cola larga a propósito: un modelo económico
 * que calibra flojo sigue siendo útil, pero un resumen que probablemente
 * spoilea es exactamente lo que el producto promete no hacer.
 */
export const PENALIZACION_REVISION = 0.5;

export function penalizarConfidence(confidence: number): number {
  return Math.max(0, Math.min(1, confidence * PENALIZACION_REVISION));
}

/** Resumen de una línea de los hallazgos, para el log del Worker. */
export function describirHallazgos(hallazgos: Hallazgo[]): string {
  return hallazgos.map((h) => `${h.campo}/${h.nombre}: "${h.fragmento}"`).join(' · ');
}
