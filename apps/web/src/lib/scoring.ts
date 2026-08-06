/**
 * El corazón del producto: qué tan compatible es un libro con un lector.
 *
 * Matemática pura y determinística, en el cliente. No pega a la red, no toca
 * `localStorage`, no importa nada más que tipos y las 14 dimensiones canónicas.
 * Cuesta $0 por escaneo y se puede explicar renglón por renglón, que es
 * exactamente lo que la regla 5 pide y lo que un LLM no puede dar.
 *
 * ## Por qué el coseno va CENTRADO en 0
 *
 * El coseno mide dirección, no posición. Sobre vectores que viven en [0,1] —o
 * sea, todos positivos— eso lo rompe: un libro extremo en las 14 dimensiones y
 * uno mínimo en las 14 son colineales, y el coseno crudo los declara idénticos.
 *
 *     libro  = [0.9 × 14]
 *     perfil = [0.1 × 14]
 *     coseno crudo    = 1.0   → 100% de compatibilidad, que es absurdo
 *     coseno centrado = -1.0  → 0%, que es la respuesta
 *
 * Restarle `CENTRO` a cada componente antes de multiplicar mueve el origen al
 * medio de la escala, y ahí el signo vuelve a significar algo: por encima del
 * centro es un polo, por debajo es el otro. Sin esto el rango útil se comprime
 * entre 0.75 y 0.99 y todos los libros puntúan parecido — el mismo "colapso"
 * que las anclas del prompt existen para evitar, pero producido por la métrica
 * en lugar de por el modelo.
 *
 * ## Por qué un libro bloqueado conserva su puntaje
 *
 * `band: 'bloqueado'` es la respuesta, pero el número sigue calculado. Un libro
 * que da 88% y está bloqueado por un flag no es lo mismo que uno que da 31% y
 * está bloqueado por el mismo flag, y el lector es el único que puede decidir
 * qué hacer con esa diferencia. Tirar el número le sacaría información sin
 * ahorrarle nada.
 *
 * ## Por qué las razones no salen del LLM
 *
 * Salen de comparar dimensiones de a una (regla 5). Son verificables: cada
 * razón apunta a la dimensión que la generó, así que si una suena mal se sabe
 * qué número la produjo. Un párrafo generado sería más lindo y no se podría
 * auditar.
 */
import { APPEAL_DIMENSIONS } from '@lector/shared';
import type { AppealDimension, ContentFlag, Enrichment } from '@lector/shared';
import { PESO_NEUTRO, type UserProfile } from './perfil';

// --- Constantes de calibración ---------------------------------------------

/** El medio de la escala 0–1. Origen del coseno centrado. */
const CENTRO = 0.5;

/** Puntaje cuando no hay nada que comparar. Ni bien ni mal: no sabemos. */
const PUNTAJE_NEUTRO = 50;

/** Distancia máxima entre libro y perfil para que una dimensión sea un match. */
const UMBRAL_MATCH = 0.15;

/** Cuánto tiene que alejarse del centro una dimensión para valer como razón. */
const UMBRAL_NOTABLE = 0.2;

/** Distancia mínima para que una dimensión valga una advertencia. */
const UMBRAL_WARNING = 0.4;

const MAX_MATCHES = 3;
const MAX_WARNINGS = 2;

/** Piso de cada banda. Por encima de 75 es alta; de 50 a 74, media. */
const PISO_ALTA = 75;
const PISO_MEDIA = 50;

// --- Tipos ------------------------------------------------------------------

export type Banda = 'alta' | 'media' | 'baja' | 'bloqueado';

/**
 * Una razón siempre apunta a lo que la generó: los `match` y los `warning` a una
 * dimensión del vector, los `blocker` a la advertencia de contenido que disparó
 * el filtro duro. Por eso es una unión y no un `dimension: string`.
 */
export type Reason =
  | { kind: 'match'; dimension: AppealDimension; text: string }
  | { kind: 'warning'; dimension: AppealDimension; text: string }
  | { kind: 'blocker'; dimension: ContentFlag; text: string };

export type ScoreResult = {
  /** 0–100, entero. */
  score: number;
  band: Banda;
  /** Nunca vacío si hubo algo que comparar (regla 5). */
  reasons: Reason[];
  /**
   * Cuántas dimensiones tenían valor en los dos lados. Bajo = perfil a medio
   * armar y puntaje poco confiable; en 0 el puntaje es puro `PUNTAJE_NEUTRO` y
   * la ficha tiene que decir "completá tu perfil" en vez de mostrar un número.
   */
  dimensionesComparadas: number;
};

/**
 * Lo que el score necesita del libro.
 *
 * Es un subconjunto estructural de `Enrichment` más el largo, así que una ficha
 * completa entra sin adaptador. El `AppealVector` pelado que sugería el PLAN no
 * alcanza: los filtros duros necesitan las advertencias de contenido, y esas
 * viven en el enrichment, no en el vector.
 */
export type LibroPuntuable = Pick<Enrichment, 'appealVector' | 'contentFlags'> & {
  /** De `Book`. Si está, la razón sobre `extension` dice páginas en vez de vaguedades. */
  pageCount?: number;
};

/** Una dimensión que los dos lados tenían, ya limpia y lista para comparar. */
type Comparada = {
  dim: AppealDimension;
  libro: number;
  perfil: number;
  peso: number;
};

// --- Textos -----------------------------------------------------------------

type TextosPolo = {
  /** El libro está en este polo y el lector lo busca. */
  match: string;
  /** El libro está en este polo y el lector va para el otro lado. */
  warning: string;
};

/**
 * Una frase por polo y por tipo de razón.
 *
 * Está escrito a mano y no generado desde `POLOS` a propósito: "0 = distante,
 * 1 = devastador" le sirve al modelo, pero al lector parado en el pasillo hay
 * que decirle "pega fuerte emocionalmente, como los que te marcan". El PLAN pide
 * concreto y nunca genérico, y eso no sale de una plantilla.
 *
 * El `Record<AppealDimension, …>` es deliberado, igual que en las anclas del
 * prompt: agregar una dimensión al vector compartido **no compila** hasta que
 * alguien le escriba sus frases. Una dimensión sin texto es una dimensión que
 * nunca va a poder explicar su puntaje.
 */
const TEXTOS: Record<AppealDimension, { bajo: TextosPolo; alto: TextosPolo }> = {
  ritmo: {
    bajo: {
      match: 'Ritmo pausado, de los que te gusta tomarte con calma',
      warning: 'Ritmo bastante más lento de lo que solés elegir',
    },
    alto: {
      match: 'Ritmo trepidante, de los que no se sueltan',
      warning: 'Ritmo bastante más acelerado de lo que solés elegir',
    },
  },
  densidadPersonajes: {
    bajo: {
      match: 'Foco en pocos personajes, sin dispersarse',
      warning: 'Sostiene casi todo con un personaje solo',
    },
    alto: {
      match: 'Elenco coral, con muchas voces en juego',
      warning: 'Más personajes de los que solés querer seguir',
    },
  },
  introspeccion: {
    bajo: {
      match: 'Pasa por la acción más que por la cabeza de los personajes',
      warning: 'Casi todo pasa afuera, y vos buscás vida interior',
    },
    alto: {
      match: 'Mucha vida interior, de los que se quedan pensando',
      warning: 'Muy metido para adentro para lo que solés leer',
    },
  },
  linealidad: {
    bajo: {
      match: 'Estructura fragmentaria, de las que hay que ir armando',
      warning: 'Estructura rota, y vos venís eligiendo que se cuente derecho',
    },
    alto: {
      match: 'Se cuenta derecho, de principio a fin',
      warning: 'Muy lineal, y vos venís eligiendo estructuras más rotas',
    },
  },
  cierre: {
    bajo: {
      match: 'Final abierto, de los que te dejan dando vueltas',
      warning: 'Deja bastante sin cerrar para lo que solés bancar',
    },
    alto: {
      match: 'Cierra todo, sin puntas sueltas',
      warning: 'Cierra demasiado prolijo para lo que solés buscar',
    },
  },
  worldbuilding: {
    bajo: {
      match: 'Transcurre en un mundo cotidiano, sin mitología propia',
      warning: 'Mundo cotidiano, y vos venís eligiendo mundos construidos',
    },
    alto: {
      match: 'Mundo construido en detalle, con reglas propias',
      warning: 'Mucho mundo inventado para lo que solés leer',
    },
  },
  anclajeHistorico: {
    bajo: {
      match: 'Sin época definida, podría pasar en cualquier momento',
      warning: 'Atemporal, y vos venís eligiendo períodos concretos',
    },
    alto: {
      match: 'Bien anclado en su período histórico',
      warning: 'Muy pegado a una época para lo que solés buscar',
    },
  },
  luminosidad: {
    bajo: {
      match: 'Tono oscuro, sin consuelo fácil',
      warning: 'Bastante más oscuro de lo que solés bancar',
    },
    alto: {
      match: 'Tono luminoso, deja con algo de esperanza',
      warning: 'Bastante más luminoso de lo que solés elegir',
    },
  },
  humor: {
    bajo: {
      match: 'Va en serio todo el tiempo, sin alivio cómico',
      warning: 'No tiene nada de humor, y en tu perfil pesa',
    },
    alto: {
      match: 'El humor es central, no un condimento',
      warning: 'Muy apoyado en el humor para lo que solés buscar',
    },
  },
  densidadProsa: {
    bajo: {
      match: 'Prosa transparente, no se interpone',
      warning: 'Prosa más llana de la que solés buscar',
    },
    alto: {
      match: 'Prosa densa, de las que se releen',
      warning: 'Prosa bastante más densa de la que venís leyendo',
    },
  },
  exigencia: {
    bajo: {
      match: 'Se lee fácil, no pide concentración especial',
      warning: 'Se lee más fácil de lo que solés buscar',
    },
    alto: {
      match: 'Pide esfuerzo, y vos se lo ponés',
      warning: 'Pide bastante más esfuerzo del que solés poner',
    },
  },
  cargaEmocional: {
    bajo: {
      match: 'Mira de lejos, sin buscar el golpe emocional',
      warning: 'Emocionalmente distante, y vos buscás que te pegue',
    },
    alto: {
      match: 'Pega fuerte emocionalmente, como los que te marcan',
      warning: 'Emocionalmente más duro de lo que solés bancar',
    },
  },
  romance: {
    bajo: {
      match: 'El romance no aparece',
      warning: 'No tiene romance, y en tu perfil pesa',
    },
    alto: {
      match: 'El romance es el eje del libro',
      warning: 'El romance ocupa mucho más lugar del que solés buscar',
    },
  },
  extension: {
    bajo: {
      match: 'Corto, se termina en pocas sentadas',
      warning: 'Más corto de lo que solés elegir',
    },
    alto: {
      match: 'Largo, de los que duran',
      warning: 'Bastante más largo de lo que solés elegir',
    },
  },
};

/** Cómo se nombra cada advertencia de contenido en la razón que bloquea. */
const ETIQUETA_FLAG: Record<ContentFlag, string> = {
  'violencia-grafica': 'violencia gráfica',
  'violencia-sexual': 'violencia sexual',
  'maltrato-animal': 'maltrato animal',
  'muerte-infantil': 'muerte de chicos',
  suicidio: 'suicidio',
  adicciones: 'adicciones',
  'final-tragico': 'final trágico',
  'contenido-sexual-explicito': 'contenido sexual explícito',
};

/**
 * Última red para que ningún puntaje salga pelado (regla 5).
 *
 * Solo se usa cuando el libro es parejo en todo lo que el lector marcó: ahí no
 * hay dimensión que destaque y cualquier frase de polo mentiría. Decir que el
 * parecido es general es menos vistoso y es lo que pasa de verdad.
 */
const RAZON_SIN_RASGOS =
  'Ningún rasgo marcado en las dimensiones que te importan: el puntaje sale de un parecido general';

// --- El score ---------------------------------------------------------------

/**
 * Puntúa un libro contra un perfil.
 *
 * El orden importa: primero los filtros duros —que mandan sobre la banda sin
 * importar la similitud—, después el coseno, y al final las razones, que se
 * derivan de las mismas dimensiones que produjeron el número. Nunca al revés.
 */
export function scoreBook(libro: LibroPuntuable, perfil: UserProfile): ScoreResult {
  const bloqueos = flagsBloqueantes(libro, perfil);
  const comparadas = dimensionesComparables(libro, perfil);
  const score = puntaje(comparadas);

  const matches = elegirMatches(comparadas, libro);
  const warnings = elegirWarnings(comparadas, libro);
  const blockers: Reason[] = bloqueos.map((flag) => ({
    kind: 'blocker',
    dimension: flag,
    text: `Contiene ${ETIQUETA_FLAG[flag]} (lo marcaste para evitar)`,
  }));

  // Orden de renderizado de la regla 5: primero lo que suma, después lo que
  // advierte, al final lo que frena.
  const reasons = [...matches, ...warnings, ...blockers];
  if (reasons.length === 0) {
    // Sin nada que decir, el puntaje saldría pelado y eso la regla 5 no lo
    // permite. La excepción es el perfil vacío: ahí no hay dimensión a la que
    // colgar la razón, y la ficha ya tiene `dimensionesComparadas: 0` para
    // mostrar "completá tu perfil" en lugar de un número.
    const masNotable = [...comparadas].sort((x, y) => relevancia(y) - relevancia(x))[0];
    if (masNotable) {
      reasons.push({ kind: 'warning', dimension: masNotable.dim, text: RAZON_SIN_RASGOS });
    }
  }

  return {
    score,
    band: bloqueos.length > 0 ? 'bloqueado' : banda(score),
    reasons,
    dimensionesComparadas: comparadas.length,
  };
}

/**
 * Las dimensiones que los dos lados tenían.
 *
 * Se recorre `APPEAL_DIMENSIONS` y no las claves del perfil: es la lista
 * canónica, ignora cualquier basura que haya quedado en un `localStorage` viejo
 * y fija un orden estable, que es lo que hace determinístico el desempate de las
 * razones. Los valores se limpian acá y no en el cálculo — un `NaN` o un peso
 * negativo que llegue desde un perfil migrado a mano no puede envenenar una suma
 * que después no se puede depurar.
 */
function dimensionesComparables(libro: LibroPuntuable, perfil: UserProfile): Comparada[] {
  const comparadas: Comparada[] = [];

  for (const dim of APPEAL_DIMENSIONS) {
    const valorPerfil = perfil.vector[dim];
    if (valorPerfil === undefined || !Number.isFinite(valorPerfil)) continue;

    const valorLibro = libro.appealVector[dim];
    if (valorLibro === undefined || !Number.isFinite(valorLibro)) continue;

    const pesoCrudo = perfil.pesos?.[dim] ?? PESO_NEUTRO;
    const peso = Number.isFinite(pesoCrudo) ? Math.max(0, pesoCrudo) : PESO_NEUTRO;
    // Peso 0 es el lector diciendo "esto no me importa". No es un match ni una
    // advertencia: es una dimensión que no existe para él.
    if (peso === 0) continue;

    comparadas.push({
      dim,
      libro: clamp01(valorLibro),
      perfil: clamp01(valorPerfil),
      peso,
    });
  }

  return comparadas;
}

/** Coseno ponderado sobre los valores centrados, mapeado de [-1,1] a 0–100. */
function puntaje(comparadas: Comparada[]): number {
  if (comparadas.length === 0) return PUNTAJE_NEUTRO;

  let producto = 0;
  let normaLibro = 0;
  let normaPerfil = 0;

  for (const { libro, perfil, peso } of comparadas) {
    const a = libro - CENTRO;
    const b = perfil - CENTRO;
    producto += peso * a * b;
    normaLibro += peso * a * a;
    normaPerfil += peso * b * b;
  }

  // Norma cero = todas las dimensiones justo en el centro. No hay dirección que
  // comparar, ni de un lado ni del otro: es el caso del lector que contestó
  // todos los pares por el medio, y la respuesta honesta es el neutro.
  if (normaLibro === 0 || normaPerfil === 0) return PUNTAJE_NEUTRO;

  const coseno = producto / (Math.sqrt(normaLibro) * Math.sqrt(normaPerfil));
  // El coseno es matemáticamente ≤ |1|, pero la aritmética de punto flotante
  // devuelve 1.0000000000000002 seguido y eso saldría como 101.
  const acotado = Math.min(1, Math.max(-1, coseno));

  return Math.round(((acotado + 1) / 2) * 100);
}

function banda(score: number): Banda {
  if (score >= PISO_ALTA) return 'alta';
  if (score >= PISO_MEDIA) return 'media';
  return 'baja';
}

// --- Razones ----------------------------------------------------------------

/**
 * Las 2-3 dimensiones más cercanas, y encima notables.
 *
 * El filtro por `UMBRAL_NOTABLE` es lo que separa una razón de un relleno:
 * coincidir en 0.5 no es coincidir en nada, es que ninguno de los dos tiene
 * opinión. Se ordena por cuánto le importa la dimensión al lector multiplicado
 * por cuán marcada está en el libro, que es la definición práctica de "esto te
 * lo tengo que contar".
 */
function elegirMatches(comparadas: Comparada[], libro: LibroPuntuable): Reason[] {
  return comparadas
    .filter(
      (c) =>
        Math.abs(c.libro - c.perfil) <= UMBRAL_MATCH &&
        Math.abs(c.libro - CENTRO) >= UMBRAL_NOTABLE,
    )
    .sort((x, y) => relevancia(y) - relevancia(x))
    .slice(0, MAX_MATCHES)
    .map((c) => ({
      kind: 'match',
      dimension: c.dim,
      text: conPaginas(c, TEXTOS[c.dim][polo(c.libro)].match, libro),
    }));
}

/** Las que más se desvían, ponderadas por cuánto le importan al lector. */
function elegirWarnings(comparadas: Comparada[], libro: LibroPuntuable): Reason[] {
  return comparadas
    .filter((c) => Math.abs(c.libro - c.perfil) >= UMBRAL_WARNING)
    .sort((x, y) => desvio(y) - desvio(x))
    .slice(0, MAX_WARNINGS)
    .map((c) => ({
      kind: 'warning',
      dimension: c.dim,
      // El polo se toma contra el perfil, no contra el centro: lo que hay que
      // avisar es para qué lado se va el libro RESPECTO DEL LECTOR. Un libro en
      // 0.45 es más corto que alguien que busca 0.9, aunque esté casi al medio.
      text: conPaginas(c, TEXTOS[c.dim][c.libro > c.perfil ? 'alto' : 'bajo'].warning, libro),
    }));
}

/** Advertencias que el lector pidió evitar y el libro tiene. Sin repetir. */
function flagsBloqueantes(libro: LibroPuntuable, perfil: UserProfile): ContentFlag[] {
  const evitados = new Set(perfil.avoids);
  return [...new Set(libro.contentFlags)].filter((flag) => evitados.has(flag));
}

/**
 * La razón sobre `extension` dice páginas cuando las hay.
 *
 * "640 páginas — bastante más largo de lo que solés elegir" es un dato que el
 * lector puede verificar dándole vuelta el libro; "bastante más largo" solo le
 * pide que confíe. Es el ejemplo textual de la regla 5.
 */
function conPaginas(c: Comparada, texto: string, libro: LibroPuntuable): string {
  if (c.dim !== 'extension' || libro.pageCount === undefined) return texto;
  return `${libro.pageCount} páginas — ${texto.charAt(0).toLowerCase()}${texto.slice(1)}`;
}

/** Cuánto le importa al lector × cuán marcado está el libro. */
function relevancia(c: Comparada): number {
  return c.peso * Math.abs(c.libro - CENTRO);
}

/** Cuánto le importa al lector × cuánto se aleja el libro de él. */
function desvio(c: Comparada): number {
  return c.peso * Math.abs(c.libro - c.perfil);
}

function polo(valor: number): 'bajo' | 'alto' {
  return valor >= CENTRO ? 'alto' : 'bajo';
}

function clamp01(valor: number): number {
  return Math.min(1, Math.max(0, valor));
}
