/**
 * Filtro anti-spoiler de la entrada al LLM.
 *
 * ## Por qué existe este archivo y no un párrafo en el prompt
 *
 * Poner "no cuentes el final" en el prompt **no funciona**: si el argumento
 * completo está en el contexto, el modelo lo usa igual — lo parafrasea, lo
 * insinúa, o lo mete en el `hook`. La regla 3 de CLAUDE.md se resuelve
 * controlando **qué entra**, no pidiendo buena conducta. Por eso este módulo se
 * escribió antes que `prompts.ts`.
 *
 * Lo que se permite pasar:
 *   - `description` de Google Books (contratapa del editor, texto de venta)
 *   - subjects / BISAC
 *   - **solo el primer párrafo** del extracto de Wikipedia
 *
 * Lo que se corta antes del prompt:
 *   - toda sección cuyo encabezado matchee SECCION_PROHIBIDA
 *   - bloques de reseñas de usuarios
 *   - cualquier cosa después de un marcador explícito de spoiler
 *
 * ## Por qué se filtra por procedencia y no en un solo string
 *
 * Cada fuente se filtra distinto: Google Books entero, Wikipedia un párrafo.
 * Por eso las descripciones viajan separadas desde `sources/types.ts` y este
 * módulo las recibe como `DescriptionCandidate[]`, nunca concatenadas.
 *
 * ## Por qué regex y no un parser de HTML
 *
 * No hay DOM: `workerd` tiene `HTMLRewriter` pero Node no, y este módulo tiene
 * que correr igual en el Worker que en `scripts/enrich-batch.ts` bajo Node. Un
 * parser real sería otra dependencia para un caso donde la entrada de
 * producción es un fragmento de contratapa con `<p>` y `<i>`, no un artículo
 * entero. La limpieza es deliberadamente **conservadora**: ante la duda, corta.
 * Los tests corren igual contra HTML real de Wikipedia ES, que es el peor caso
 * imaginable, para que el corte de secciones esté probado donde importa.
 */
import type { DescriptionCandidate, SourceName } from '../sources/types';

/**
 * Encabezados que cuentan la historia. **Es la lista de la regla 3 de
 * CLAUDE.md** — si cambia, cambia en los dos lados.
 *
 * Ancla en `^` a propósito: tiene que agarrar "Trama por capítulos" y
 * "Personajes principales", que son los encabezados reales de los artículos, no
 * los títulos idealizados.
 */
export const SECCION_PROHIBIDA =
  /^(argumento|trama|sinopsis|resumen|desenlace|final|personajes|plot)/i;

/**
 * Reseñas de **usuarios**, que la regla 3 prohíbe. No incluye "Recepción" ni
 * "Críticas" a secas: son crítica profesional, que la regla no veta. Para
 * Wikipedia da igual —solo sobrevive el primer párrafo— y para el resto
 * ensanchar esta lista sin discutirlo sería cambiar la regla por mi cuenta.
 */
export const SECCION_RESENAS =
  /^((rese[ñn]as?|opiniones|comentarios|cr[íi]ticas)\s+(de\s+)?(l[oa]s\s+)?(usuarios?|lectores?|clientes?)|valoraciones|(customer|user|reader)\s+reviews?)/i;

/** Avisos explícitos de spoiler: lo que sigue no se mira. */
const MARCADOR_SPOILER =
  /(^|\n)[^\n]{0,80}(alerta\s+de\s+spoilers?|contiene\s+spoilers?|advertencia:?\s*spoilers?|spoiler\s+alert)[^\n]{0,80}/i;

/**
 * Techo de caracteres por fuente y en total.
 *
 * docs/LLM.md presupuesta ~2.500 tokens de entrada por libro. El bloque de
 * sistema con las 28 anclas se come cerca de la mitad, así que a las fuentes les
 * quedan ~1.200 tokens ≈ 4.000 caracteres de español. Cortar acá es lo que
 * mantiene el costo por libro donde dice el presupuesto.
 */
export const LIMITE_POR_FUENTE = 2_000;
export const LIMITE_TOTAL = 4_000;

export type MotivoDescarte =
  | 'seccion-prohibida'
  | 'resenas-usuarios'
  | 'marcado-spoiler'
  | 'parrafos-posteriores'
  | 'duplicado'
  | 'recorte-por-largo';

/** Un pedazo que no llegó al prompt, con por qué. Para debug, no para el LLM. */
export type Descarte = {
  motivo: MotivoDescarte;
  source: SourceName;
  /** El encabezado o marcador que lo disparó. Vacío si no aplica. */
  detalle: string;
  chars: number;
};

export type TextoLimpio = {
  source: SourceName;
  text: string;
};

export type Sanitizado = {
  textos: TextoLimpio[];
  descartes: Descarte[];
};

export type LimitesSanitizado = {
  porFuente: number;
  total: number;
};

// ─── HTML → texto ──────────────────────────────────────────────────────────

/**
 * Etiquetas que se anidan y hay que borrar enteras. `<table>` es el caso real:
 * el infobox de Wikipedia tiene tablas adentro de tablas, y un `[\s\S]*?`
 * no-greedy corta en el `</table>` **interno** y deja colgando la cola del
 * infobox — así se colaba "[editar datos en Wikidata]" como si fuera el primer
 * párrafo del artículo.
 */
const ETIQUETAS_ANIDABLES = ['table', 'figure'] as const;

/** Cota de seguridad: ningún artículo real anida tanto, pero nadie se cuelga. */
const MAX_PASADAS_ANIDADAS = 20;

/**
 * Bloques de nivel de bloque: se reemplazan por un espacio porque separan
 * contenido que no debe quedar pegado.
 */
const BLOQUES_BASURA = [
  /<script\b[\s\S]*?<\/script>/gi,
  /<style\b[\s\S]*?<\/style>/gi,
];

/**
 * Basura **en línea**: se reemplaza por nada, no por un espacio. Un `<sup>` de
 * cita vive pegado a la palabra anterior y antes del punto —"en 1948[1]."— así
 * que un espacio dejaría "en 1948 .".
 */
const BASURA_EN_LINEA = [
  /<sup\b[\s\S]*?<\/sup>/gi, // marcadores de cita: [1], [2]…
  /<span class="mw-editsection"[\s\S]*?<\/span><\/span>/gi,
];

/** Borra de adentro hacia afuera: cada pasada se lleva las más internas. */
export function quitarAnidadas(html: string, etiqueta: string): string {
  // El `(?!<etiqueta)` es lo que hace que solo matcheen las que no contienen
  // otra adentro, o sea las más internas de cada rama.
  const patron = new RegExp(`<${etiqueta}\\b(?:(?!<${etiqueta}\\b)[\\s\\S])*?<\\/${etiqueta}>`, 'gi');

  let resultado = html;
  for (let pasada = 0; pasada < MAX_PASADAS_ANIDADAS; pasada++) {
    const siguiente = resultado.replace(patron, ' ');
    if (siguiente === resultado) break;
    resultado = siguiente;
  }
  return resultado;
}

/** Etiquetas de bloque: su cierre es un corte de párrafo, no un espacio. */
const CIERRE_DE_BLOQUE = /<\/(p|div|li|ul|ol|h[1-6]|blockquote|section|tr)\s*>/gi;

const ENTIDADES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  ntilde: 'ñ',
  uuml: 'ü',
};

export function decodificarEntidades(texto: string): string {
  return texto
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (entero, nombre: string) => ENTIDADES[nombre.toLowerCase()] ?? entero);
}

/** Heurística barata: ¿esto tiene etiquetas o es texto plano? */
export function pareceHtml(texto: string): boolean {
  return /<\/?(p|div|h[1-6]|br|span|table|i|b|em|strong|ul|li)\b[^>]*>/i.test(texto);
}

export function htmlATexto(html: string): string {
  let texto = html;
  for (const patron of BLOQUES_BASURA) texto = texto.replace(patron, ' ');
  for (const etiqueta of ETIQUETAS_ANIDABLES) texto = quitarAnidadas(texto, etiqueta);
  for (const patron of BASURA_EN_LINEA) texto = texto.replace(patron, '');

  return normalizarEspacios(
    decodificarEntidades(
      texto
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(CIERRE_DE_BLOQUE, '\n\n')
        .replace(/<[^>]+>/g, '')
    )
  );
}

/** Espacios prolijos, párrafos preservados. Todo lo demás colapsa. */
export function normalizarEspacios(texto: string): string {
  return texto
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Solo el lead (regla 3). El resto del extracto puede tener el argumento. */
export function primerParrafo(texto: string): string {
  return texto.split(/\n\s*\n/)[0]!.trim();
}

// ─── Corte de secciones ────────────────────────────────────────────────────

type Encabezado = {
  /** Dónde empieza lo que hay que borrar si el encabezado está prohibido. */
  inicio: number;
  /** Dónde termina el encabezado en sí. */
  fin: number;
  nivel: number;
  titulo: string;
};

/** Texto de un encabezado HTML, ya sin etiquetas internas ni entidades. */
function tituloDeEncabezado(interior: string): string {
  return normalizarEspacios(decodificarEntidades(interior.replace(/<[^>]+>/g, ' ')));
}

/**
 * Encabezados de un HTML, en orden.
 *
 * Wikipedia envuelve cada uno en `<div class="mw-heading mw-heading2">` junto
 * con el link de "editar". El wrapper se incluye en el rango a borrar cuando
 * está, para no dejar el `[editar]` colgado del párrafo anterior.
 */
export function encabezadosHtml(html: string): Encabezado[] {
  const encabezados: Encabezado[] = [];
  const patron = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;

  for (const match of html.matchAll(patron)) {
    const indice = match.index;
    const antes = html.slice(Math.max(0, indice - 120), indice);
    const wrapper = antes.match(/<div class="mw-heading[^"]*">\s*$/);

    encabezados.push({
      inicio: wrapper ? indice - wrapper[0].length : indice,
      fin: indice + match[0].length,
      nivel: Number.parseInt(match[1]!, 10),
      titulo: tituloDeEncabezado(match[2]!),
    });
  }

  return encabezados;
}

/**
 * Encabezados de texto plano: markdown (`## Argumento`) y wikitexto
 * (`== Argumento ==`).
 *
 * Hace falta además del caso HTML porque Open Library sirve seguido el artículo
 * de Wikipedia copiado y pegado, ya convertido a texto, con los encabezados
 * intactos. Ese es el camino real por el que un argumento completo llega al
 * pipeline hoy — la fuente `wikipedia` nunca trae más que el lead.
 */
export function encabezadosTexto(texto: string): Encabezado[] {
  const encabezados: Encabezado[] = [];
  const patron = /^[ \t]*(#{1,6}|={2,6})[ \t]*(.+?)[ \t]*(?:={2,6})?[ \t]*$/gm;

  for (const match of texto.matchAll(patron)) {
    encabezados.push({
      inicio: match.index,
      fin: match.index + match[0].length,
      nivel: match[1]!.length,
      titulo: normalizarEspacios(match[2]!),
    });
  }

  return encabezados;
}

/**
 * Una línea corta y suelta que arranca con una palabra prohibida es un
 * encabezado al que se le cayó el marcado — pasa cuando alguien pega un
 * artículo sin formato. El límite de largo es lo que evita comerse un párrafo
 * que casualmente empieza con "Final": un párrafo real no mide 40 caracteres.
 */
const LARGO_MAXIMO_ENCABEZADO_PELADO = 40;

export function encabezadosPelados(texto: string): Encabezado[] {
  const encabezados: Encabezado[] = [];
  const lineas = texto.split('\n');
  let offset = 0;

  for (const linea of lineas) {
    const limpia = linea.trim();
    if (
      limpia.length > 0 &&
      limpia.length <= LARGO_MAXIMO_ENCABEZADO_PELADO &&
      !/[.:;!?]$/.test(limpia) &&
      (SECCION_PROHIBIDA.test(limpia) || SECCION_RESENAS.test(limpia))
    ) {
      encabezados.push({
        inicio: offset,
        fin: offset + linea.length,
        nivel: 2,
        titulo: limpia,
      });
    }
    offset += linea.length + 1;
  }

  return encabezados;
}

/**
 * Borra las secciones prohibidas.
 *
 * Una sección va desde su encabezado hasta el próximo encabezado de nivel igual
 * o superior — no hasta el próximo encabezado a secas: "Argumento" con un
 * "Primera parte" adentro tiene que irse **entero**, subsecciones incluidas.
 */
export function quitarSecciones(
  texto: string,
  encabezados: Encabezado[],
  source: SourceName
): { texto: string; descartes: Descarte[] } {
  const descartes: Descarte[] = [];
  const rangos: { desde: number; hasta: number; motivo: MotivoDescarte; titulo: string }[] = [];

  for (const [i, encabezado] of encabezados.entries()) {
    const prohibida = SECCION_PROHIBIDA.test(encabezado.titulo);
    const resena = SECCION_RESENAS.test(encabezado.titulo);
    if (!prohibida && !resena) continue;

    const siguiente = encabezados
      .slice(i + 1)
      .find((otro) => otro.nivel <= encabezado.nivel && otro.inicio > encabezado.inicio);

    rangos.push({
      desde: encabezado.inicio,
      hasta: siguiente ? siguiente.inicio : texto.length,
      // Reseñas gana si matchean las dos: es el motivo más específico.
      motivo: resena ? 'resenas-usuarios' : 'seccion-prohibida',
      titulo: encabezado.titulo,
    });
  }

  if (rangos.length === 0) return { texto, descartes };

  // De atrás para adelante: así los índices de los rangos que faltan procesar
  // siguen siendo válidos después de cada corte.
  let resultado = texto;
  for (const rango of [...rangos].sort((a, b) => b.desde - a.desde)) {
    const pedazo = resultado.slice(rango.desde, rango.hasta);
    resultado = resultado.slice(0, rango.desde) + '\n\n' + resultado.slice(rango.hasta);
    descartes.push({
      motivo: rango.motivo,
      source,
      detalle: rango.titulo,
      chars: pedazo.length,
    });
  }

  return { texto: resultado, descartes: descartes.reverse() };
}

// ─── Pipeline por fuente ───────────────────────────────────────────────────

/**
 * Limpia el texto de UNA fuente.
 *
 * El orden no es negociable: las secciones se cortan **sobre el marcado**,
 * mientras los encabezados todavía se distinguen del cuerpo. Si primero se
 * convirtiera a texto plano, "Argumento" quedaría como una línea más y
 * distinguirla del párrafo que la sigue sería adivinanza.
 */
export function sanitizarTexto(
  crudo: string,
  source: SourceName,
  limite: number = LIMITE_POR_FUENTE
): { texto: string; descartes: Descarte[] } {
  const descartes: Descarte[] = [];
  let texto = crudo;

  // 1 · Marcador explícito de spoiler: se corta ahí y no se mira más.
  const marcador = texto.match(MARCADOR_SPOILER);
  if (marcador?.index !== undefined) {
    descartes.push({
      motivo: 'marcado-spoiler',
      source,
      detalle: normalizarEspacios(marcador[0]).slice(0, 60),
      chars: texto.length - marcador.index,
    });
    texto = texto.slice(0, marcador.index);
  }

  // 2 · Secciones, sobre el marcado original.
  if (pareceHtml(texto)) {
    const corte = quitarSecciones(texto, encabezadosHtml(texto), source);
    texto = corte.texto;
    descartes.push(...corte.descartes);
    texto = htmlATexto(texto);
  }

  const corteTexto = quitarSecciones(texto, encabezadosTexto(texto), source);
  texto = corteTexto.texto;
  descartes.push(...corteTexto.descartes);

  const cortePelado = quitarSecciones(texto, encabezadosPelados(texto), source);
  texto = cortePelado.texto;
  descartes.push(...cortePelado.descartes);

  texto = normalizarEspacios(texto);

  // 3 · Wikipedia: solo el lead, pase lo que pase (regla 3).
  if (source === 'wikipedia') {
    const lead = primerParrafo(texto);
    if (lead.length < texto.length) {
      descartes.push({
        motivo: 'parrafos-posteriores',
        source,
        detalle: 'extracto de Wikipedia recortado al primer párrafo',
        chars: texto.length - lead.length,
      });
    }
    texto = lead;
  }

  // 4 · Techo de tokens. Corta en el último punto para no dejar una oración
  //     partida al aire, que es justo lo que hace alucinar a un modelo chico.
  if (texto.length > limite) {
    const recortado = texto.slice(0, limite);
    const ultimoPunto = recortado.lastIndexOf('. ');
    const final = ultimoPunto > limite * 0.6 ? recortado.slice(0, ultimoPunto + 1) : recortado;

    descartes.push({
      motivo: 'recorte-por-largo',
      source,
      detalle: `${texto.length} → ${final.length} caracteres`,
      chars: texto.length - final.length,
    });
    texto = final.trim();
  }

  return { texto, descartes };
}

/** Firma de un texto para detectar que dos fuentes traen lo mismo. */
function firma(texto: string): string {
  return texto
    .toLowerCase()
    .replace(/[^a-záéíóúñü0-9]/g, '')
    .slice(0, 120);
}

/**
 * Punto de entrada: las descripciones de la cascada, listas para el prompt.
 *
 * Devuelve los textos **separados y con su procedencia** —igual que entran— para
 * que `prompts.ts` pueda etiquetar cada bloque. Concatenarlos acá sería perder
 * la única información que permite auditar de dónde salió cada frase del
 * resumen.
 */
export function sanitizeDescriptions(
  descriptions: DescriptionCandidate[],
  limites: LimitesSanitizado = { porFuente: LIMITE_POR_FUENTE, total: LIMITE_TOTAL }
): Sanitizado {
  const textos: TextoLimpio[] = [];
  const descartes: Descarte[] = [];
  const vistas = new Set<string>();
  let acumulado = 0;

  for (const candidata of descriptions) {
    const { texto, descartes: propios } = sanitizarTexto(
      candidata.text,
      candidata.source,
      limites.porFuente
    );
    descartes.push(...propios);

    if (texto.length === 0) continue;

    // Open Library copia seguido la contratapa que ya trajo Google Books.
    // Mandar las dos paga los mismos tokens dos veces.
    const huella = firma(texto);
    if (huella.length > 0 && vistas.has(huella)) {
      descartes.push({
        motivo: 'duplicado',
        source: candidata.source,
        detalle: 'otra fuente ya trajo este mismo texto',
        chars: texto.length,
      });
      continue;
    }
    vistas.add(huella);

    const disponible = limites.total - acumulado;
    if (disponible <= 0) {
      descartes.push({
        motivo: 'recorte-por-largo',
        source: candidata.source,
        detalle: 'se alcanzó el techo total de contexto',
        chars: texto.length,
      });
      continue;
    }

    const final = texto.length > disponible ? texto.slice(0, disponible).trim() : texto;
    if (final.length < texto.length) {
      descartes.push({
        motivo: 'recorte-por-largo',
        source: candidata.source,
        detalle: `techo total: ${texto.length} → ${final.length} caracteres`,
        chars: texto.length - final.length,
      });
    }

    textos.push({ source: candidata.source, text: final });
    acumulado += final.length;
  }

  return { textos, descartes };
}
