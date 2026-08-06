/**
 * El prompt.
 *
 * ## Por qué el bloque de sistema se arma una sola vez
 *
 * OpenAI cachea el prefijo del prompt y lo factura al 10%, pero solo si es
 * **byte a byte idéntico** entre llamadas. Por eso `BLOQUE_SISTEMA` se computa
 * al cargar el módulo, no por request, y **no lleva adentro ninguna fecha, ISBN
 * ni título**: cualquiera de esas cosas invalidaría el caché en cada libro
 * (docs/LLM.md, "Caché de prompt").
 *
 * ## Por qué las anclas
 *
 * Sin un ejemplo concreto por dimensión, los modelos económicos devuelven todo
 * entre 0.5 y 0.7 —el "colapso del vector"— y el coseno deja de discriminar:
 * todo puntúa ~75% y el scoring es ruido con un número al lado. Cada dimensión
 * lleva un libro en 0.1 y otro en 0.9. Se eligieron títulos muy traducidos y
 * muy citados a propósito: el modelo tiene que conocerlos de verdad para que el
 * ancla sirva de algo.
 *
 * Esto es lo que mide la Puerta 2 de la Fase 3 (`scripts/golden-set.ts`):
 * desvío estándar por dimensión y coseno medio entre libros distintos. Las
 * anclas de acá son la primera versión y se calibran con ese script, no a ojo.
 *
 * ## Por qué el anti-spoiler está igual acá si ya está en sanitize.ts
 *
 * Son dos capas distintas. `sanitize.ts` controla qué entra —es lo que de
 * verdad funciona—; esto le dice al modelo qué hacer con lo que sí entró. Una
 * contratapa legítima puede insinuar el final, y el modelo no tiene por qué
 * completarlo.
 */
import { APPEAL_DIMENSIONS, CONTENT_FLAGS } from '@lector/shared';
import type { AppealDimension } from '@lector/shared';
import { POLOS } from './schema';
import type { EnrichRequest } from './types';

type Ancla = { bajo: string; alto: string };

/**
 * Un libro en 0.1 y uno en 0.9 por dimensión.
 *
 * El `Record<AppealDimension, …>` es deliberado: si mañana se agrega una
 * dimensión al vector compartido, esto **no compila** hasta que alguien le
 * escriba las anclas. Una dimensión sin ancla es una dimensión que colapsa.
 */
const ANCLAS: Record<AppealDimension, Ancla> = {
  ritmo: {
    bajo: 'La montaña mágica, de Thomas Mann',
    alto: 'El código Da Vinci, de Dan Brown',
  },
  densidadPersonajes: {
    bajo: 'El viejo y el mar, de Ernest Hemingway',
    alto: 'Guerra y paz, de León Tolstói',
  },
  introspeccion: {
    bajo: 'Los tres mosqueteros, de Alejandro Dumas',
    alto: 'La señora Dalloway, de Virginia Woolf',
  },
  linealidad: {
    bajo: 'Rayuela, de Julio Cortázar',
    alto: 'Los pilares de la Tierra, de Ken Follett',
  },
  cierre: {
    bajo: 'El desierto de los tártaros, de Dino Buzzati',
    alto: 'Asesinato en el Orient Express, de Agatha Christie',
  },
  worldbuilding: {
    bajo: 'Stoner, de John Williams',
    alto: 'Dune, de Frank Herbert',
  },
  anclajeHistorico: {
    bajo: 'El principito, de Antoine de Saint-Exupéry',
    alto: 'El nombre de la rosa, de Umberto Eco',
  },
  luminosidad: {
    bajo: 'La carretera, de Cormac McCarthy',
    alto: 'Un hombre llamado Ove, de Fredrik Backman',
  },
  humor: {
    bajo: '1984, de George Orwell',
    alto: 'La conjura de los necios, de John Kennedy Toole',
  },
  densidadProsa: {
    bajo: 'Los juegos del hambre, de Suzanne Collins',
    alto: 'Ulises, de James Joyce',
  },
  exigencia: {
    bajo: 'Harry Potter y la piedra filosofal, de J. K. Rowling',
    alto: 'En busca del tiempo perdido, de Marcel Proust',
  },
  cargaEmocional: {
    bajo: 'La vuelta al mundo en ochenta días, de Julio Verne',
    alto: 'Cometas en el cielo, de Khaled Hosseini',
  },
  romance: {
    bajo: 'Moby Dick, de Herman Melville',
    alto: 'Orgullo y prejuicio, de Jane Austen',
  },
  extension: {
    bajo: 'El extranjero, de Albert Camus',
    alto: 'Los miserables, de Victor Hugo',
  },
};

/** Una línea por dimensión: nombre, polos y las dos anclas. */
function lineaDimension(dim: AppealDimension): string {
  const ancla = ANCLAS[dim];
  return `- ${dim} (${POLOS[dim]})\n    0.1 → ${ancla.bajo}\n    0.9 → ${ancla.alto}`;
}

/**
 * El bloque de sistema. **Idéntico en todas las llamadas.**
 *
 * Se arma desde `APPEAL_DIMENSIONS` y `CONTENT_FLAGS` en vez de escribirse a
 * mano: las listas viven en `@lector/shared` y copiarlas en un prompt es la
 * forma más silenciosa de desincronizarlas (CLAUDE.md, "Fuentes de verdad").
 */
export const BLOQUE_SISTEMA = [
  'Sos un bibliotecario especializado en reader\'s advisory. Recibís metadata pública',
  'de un libro y devolvés una ficha estructurada, en JSON, para una app que ayuda a',
  'elegir qué leer parado en la librería.',
  '',
  '## REGLA DURA: nada de spoilers',
  '',
  'Escribís SOLO sobre el planteo: la premisa, quién es el protagonista, cuál es el',
  'conflicto inicial y qué tono tiene el libro. Es decir, lo que sabe alguien que leyó',
  'las primeras treinta páginas.',
  '',
  'Está PROHIBIDO mencionar, insinuar o dejar entrever:',
  '- lo que pasa en el punto medio del libro',
  '- cualquier giro, revelación o vuelta de tuerca',
  '- el desenlace, el final o el destino de los personajes',
  '- quién muere, quién traiciona, quién resulta ser otra persona',
  '',
  'Si la fuente que te doy cuenta el final, IGNORÁ esa parte. Que esté en el material',
  'no te habilita a usarla. Ante la duda, contá menos.',
  '',
  '## summary',
  '',
  'Entre 60 y 90 palabras, en español rioplatense neutro: usá "vos" si tenés que',
  'dirigirte al lector, evitá el "tú" y evitá también el lunfardo cerrado. Prosa',
  'directa, sin adjetivos de contratapa ("magistral", "inolvidable", "una obra',
  'maestra"). Nada de frases hechas tipo "una historia que te va a atrapar".',
  '',
  '## hook',
  '',
  'Una línea de menos de 15 palabras que dé ganas de abrirlo. Sin spoilers, sin',
  'signos de exclamación y sin preguntas retóricas.',
  '',
  '## genres',
  '',
  'De 1 a 4, en minúscula y en español. Concretos: "novela policial nórdica" sirve',
  'más que "ficción".',
  '',
  '## appeal_vector',
  '',
  'Catorce dimensiones, cada una entre 0.0 y 1.0. Esto es lo más importante de la',
  'ficha: es lo que después se compara contra el perfil del lector.',
  '',
  'USÁ TODO EL RANGO. Si te encontrás poniendo casi todo entre 0.4 y 0.7, estás',
  'contestando mal: un vector donde todos los libros se parecen no sirve para nada.',
  'Un libro cualquiera tiene dos o tres dimensiones extremas; ésas son las que lo',
  'definen. Comparalo contra estas referencias:',
  '',
  ...APPEAL_DIMENSIONS.map(lineaDimension),
  '',
  'Si te doy la cantidad de páginas, `extension` sale de ahí y no de tu impresión:',
  'menos de 200 páginas es 0.1, alrededor de 400 es 0.5, más de 600 es 0.9.',
  '',
  '## content_flags',
  '',
  'Vocabulario CERRADO. Solo estos valores, exactamente como están escritos:',
  ...CONTENT_FLAGS.map((flag) => `- ${flag}`),
  '',
  'Marcá una advertencia solo si el contenido está presente de forma significativa,',
  'no por una mención al pasar. Si no aplica ninguna, devolvé una lista vacía. No',
  'inventes valores que no estén en la lista.',
  '',
  'Ojo: marcar `final-tragico` NO es spoilear — es una etiqueta que el lector pidió',
  'ver. Pero no la expliques ni la menciones en el `summary` ni en el `hook`.',
  '',
  '## comparables',
  '',
  'Hasta 3 títulos, en formato "Título, de Autor". Que se parezcan por cómo se leen,',
  'no por el estante donde están: la pregunta es "a quién le gustó esto le va a',
  'gustar aquello". Lista vacía si no se te ocurre ninguno honesto.',
  '',
  '## confidence',
  '',
  'Qué tan confiable es esta ficha dada la fuente que te di.',
  '- 0.8 a 1.0: descripción larga y clara, conocés el libro',
  '- 0.4 a 0.7: descripción corta o genérica, pero alcanza',
  '- 0.0 a 0.3: casi no hay fuente y estás infiriendo desde el título',
  '',
  'Ser honesto acá vale más que quedar bien. Un confidence bajo se muestra al lector',
  'como "info limitada", que es un resultado útil; un confidence alto sobre algo que',
  'inventaste es una mentira que el lector no puede detectar.',
  '',
  'No inventes datos que no estén en el material. Si no sabés algo, es preferible un',
  'summary más corto y un confidence más bajo.',
].join('\n');

/**
 * Instrucción extra del reintento, cuando el guard detectó una revelación.
 *
 * Va en un mensaje aparte y **nunca** dentro del bloque de sistema: meterla ahí
 * cambiaría el prefijo cacheado en todas las llamadas siguientes.
 */
export const REFUERZO_ANTI_SPOILER = [
  'El resumen anterior fue RECHAZADO por revelar información del desarrollo o del',
  'final del libro.',
  '',
  'Reescribilo contando únicamente lo que se sabe al empezar a leer: la situación',
  'inicial, quién es el protagonista y qué tono tiene. No uses ninguna construcción',
  'del tipo "al final", "resulta que", "se revela que", "descubre que en realidad",',
  '"termina con" ni menciones quién muere.',
  '',
  'Es preferible un resumen más corto y más vago que uno que arruine el libro.',
].join('\n');

/** Una descripción etiquetada con de dónde salió. */
const NOMBRE_FUENTE: Record<string, string> = {
  googlebooks: 'Contratapa de la editorial (Google Books)',
  openlibrary: 'Descripción de la obra (Open Library)',
  wikipedia: 'Primer párrafo del artículo de Wikipedia',
};

/**
 * El mensaje del usuario: solo metadata pública del libro.
 *
 * Cada descripción va etiquetada con su procedencia y separada de las demás.
 * No se concatenan (regla 3): saber que un texto es contratapa de editorial y
 * otro es enciclopédico cambia cuánto puede confiar el modelo en cada uno.
 */
export function construirMensajeUsuario(req: EnrichRequest): string {
  const lineas: string[] = ['## Datos del libro', ''];

  lineas.push(`Título: ${req.title}`);
  if (req.authors.length > 0) lineas.push(`Autor: ${req.authors.join(', ')}`);
  if (req.publisher) lineas.push(`Editorial: ${req.publisher}`);
  if (req.publishedYear !== undefined) lineas.push(`Año: ${req.publishedYear}`);
  if (req.pageCount !== undefined) lineas.push(`Páginas: ${req.pageCount}`);
  if (req.language) lineas.push(`Idioma: ${req.language}`);

  if (req.subjects.length > 0) {
    // Un catálogo puede traer cincuenta subjects y son todos ruido después de
    // los primeros. Cortamos en 20 para no pagar tokens de más.
    lineas.push(`Materias: ${req.subjects.slice(0, 20).join(', ')}`);
  }

  if (req.descripciones.length === 0) {
    lineas.push('');
    lineas.push('## Descripciones');
    lineas.push('');
    lineas.push(
      'NO HAY NINGUNA DESCRIPCIÓN DISPONIBLE. Trabajá solo con la metadata de arriba ' +
        'y poné un confidence bajo. No inventes la trama.'
    );
  } else {
    lineas.push('');
    lineas.push('## Descripciones disponibles');

    for (const descripcion of req.descripciones) {
      lineas.push('');
      lineas.push(`### ${NOMBRE_FUENTE[descripcion.source] ?? descripcion.source}`);
      lineas.push(descripcion.text);
    }
  }

  if (req.refuerzoAntiSpoiler) {
    lineas.push('');
    lineas.push('## Corrección');
    lineas.push('');
    lineas.push(req.refuerzoAntiSpoiler);
  }

  return lineas.join('\n');
}
