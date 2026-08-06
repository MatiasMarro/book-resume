/**
 * Tests de `llm/sanitize.ts` — el módulo que decide qué ve el LLM.
 *
 * Los tres fixtures son **HTML capturado real** de es.wikipedia.org el
 * 2026-08-05 (procedencia en `fixtures/sanitize/README.md`). Se testea contra
 * bytes reales y no contra HTML inventado porque el marcado de los encabezados
 * de Wikipedia es raro de verdad —`<div class="mw-heading mw-heading2">` con el
 * link de "editar" adentro— y un fixture escrito a mano prueba el marcado que
 * yo imagino, no el que existe.
 *
 * Si falla un test acá, el resumen spoilea. Es el diferencial del producto.
 */
import { describe, expect, it } from 'vitest';
import {
  LIMITE_POR_FUENTE,
  SECCION_PROHIBIDA,
  decodificarEntidades,
  encabezadosHtml,
  encabezadosPelados,
  encabezadosTexto,
  htmlATexto,
  normalizarEspacios,
  pareceHtml,
  primerParrafo,
  quitarSecciones,
  sanitizeDescriptions,
  sanitizarTexto,
} from '../src/llm/sanitize';
import type { DescriptionCandidate } from '../src/sources/types';

import losSieteLocos from './fixtures/sanitize/wikipedia-los-siete-locos.html?raw';
import elTunel from './fixtures/sanitize/wikipedia-el-tunel.html?raw';
import distanciaDeRescate from './fixtures/sanitize/wikipedia-distancia-de-rescate.html?raw';

/** Azúcar: los motivos de descarte que aparecieron. */
function motivos(descartes: { motivo: string }[]): string[] {
  return [...new Set(descartes.map((d) => d.motivo))];
}

function detalles(descartes: { detalle: string }[]): string[] {
  return descartes.map((d) => d.detalle);
}

describe('SECCION_PROHIBIDA', () => {
  it('agarra los encabezados reales, no solo la palabra pelada', () => {
    // Estos tres salieron de los fixtures. "Argumento" a secas era la parte
    // fácil; los otros dos son los que rompen un regex sin ancla en ^.
    expect(SECCION_PROHIBIDA.test('Argumento')).toBe(true);
    expect(SECCION_PROHIBIDA.test('Trama por capítulos')).toBe(true);
    expect(SECCION_PROHIBIDA.test('Personajes principales')).toBe(true);
  });

  it('agarra las ocho palabras de la regla 3, sin importar mayúsculas', () => {
    for (const palabra of [
      'argumento',
      'TRAMA',
      'Sinopsis',
      'resumen',
      'Desenlace',
      'FINAL',
      'personajes',
      'Plot summary',
    ]) {
      expect(SECCION_PROHIBIDA.test(palabra), palabra).toBe(true);
    }
  });

  it('no agarra secciones legítimas', () => {
    // Sobre todo "Recepción" y "Referencias", que empiezan parecido a
    // "Resumen" y son las más frecuentes en cualquier artículo.
    for (const palabra of [
      'Recepción',
      'Referencias',
      'Composición',
      'Adaptaciones',
      'Enlaces externos',
      'Estructura',
      'Traducciones',
      'Premios',
    ]) {
      expect(SECCION_PROHIBIDA.test(palabra), palabra).toBe(false);
    }
  });
});

describe('htmlATexto', () => {
  it('saca las etiquetas y deja el texto', () => {
    expect(htmlATexto('<p>Una <i>novela</i> corta.</p>')).toBe('Una novela corta.');
  });

  it('saca los bloques que nunca son prosa del libro', () => {
    // El CSS del infobox aparece literal en el HTML de Wikipedia y sin esto se
    // lo comería el prompt como si fuera texto.
    const html = '<style>.infobox{max-width:100%}</style><p>El texto.</p><table><tr><td>1948</td></tr></table>';
    const texto = htmlATexto(html);

    expect(texto).toBe('El texto.');
    expect(texto).not.toContain('max-width');
    expect(texto).not.toContain('1948');
  });

  it('saca los marcadores de cita, que en el prompt son ruido pago', () => {
    expect(htmlATexto('<p>Se publicó en 1948<sup id="cite_ref-1">[1]</sup>.</p>')).toBe(
      'Se publicó en 1948.'
    );
  });

  it('convierte el cierre de bloque en corte de párrafo', () => {
    // Sin esto se pierde la noción de párrafo y "solo el primer párrafo" del
    // extracto de Wikipedia deja de significar nada.
    expect(htmlATexto('<p>Primero.</p><p>Segundo.</p>')).toBe('Primero.\n\nSegundo.');
    expect(htmlATexto('<p>Una línea<br />y otra</p>')).toBe('Una línea\ny otra');
  });

  it('decodifica las entidades', () => {
    expect(htmlATexto('<p>El t&#250;nel de&#160;Ernesto Sabato &amp; otros</p>')).toBe(
      'El túnel de Ernesto Sabato & otros'
    );
  });
});

describe('decodificarEntidades', () => {
  it('lee nombradas, decimales y hexadecimales', () => {
    expect(decodificarEntidades('&aacute;&#233;&#x69;')).toBe('áéi');
  });

  it('deja intacto lo que no conoce', () => {
    expect(decodificarEntidades('&noexiste; queda')).toBe('&noexiste; queda');
  });
});

describe('normalizarEspacios y primerParrafo', () => {
  it('colapsa espacios y limita los saltos a uno doble', () => {
    expect(normalizarEspacios('a   b\n\n\n\nc')).toBe('a b\n\nc');
  });

  it('primerParrafo corta en el primer doble salto', () => {
    expect(primerParrafo('El lead.\n\nEl argumento.')).toBe('El lead.');
  });

  it('primerParrafo devuelve todo si no hay más de un párrafo', () => {
    expect(primerParrafo('Solo esto.')).toBe('Solo esto.');
  });
});

describe('pareceHtml', () => {
  it('distingue HTML de texto plano', () => {
    expect(pareceHtml('<p>hola</p>')).toBe(true);
    expect(pareceHtml('Una contratapa normal, sin marcado.')).toBe(false);
    // Un '<' suelto no es HTML: pasa en textos con "1948 < 1950".
    expect(pareceHtml('publicada en 1948 < 1950')).toBe(false);
  });
});

describe('encabezadosHtml — contra el marcado real de Wikipedia', () => {
  it('encuentra los encabezados con su nivel', () => {
    const encabezados = encabezadosHtml(losSieteLocos);

    expect(encabezados.map((e) => e.titulo)).toEqual([
      'Argumento',
      'Personajes principales',
      'Estructura',
      'Adaptaciones',
      'Referencias',
      'Enlaces externos',
    ]);
    expect(encabezados.every((e) => e.nivel === 2)).toBe(true);
  });

  it('lee los niveles anidados', () => {
    const niveles = encabezadosHtml(elTunel).map((e) => `h${e.nivel}:${e.titulo}`);

    expect(niveles[0]).toBe('h2:Trama por capítulos');
    expect(niveles[1]).toBe('h3:Capítulo 1 y 2');
    expect(niveles).toContain('h4:Secundarios');
  });

  it('el rango a borrar arranca en el div envoltorio, no en el <h2>', () => {
    // Si arrancara en el <h2>, el "[editar]" del encabezado quedaría pegado al
    // final del párrafo anterior.
    const [primero] = encabezadosHtml(losSieteLocos);
    expect(losSieteLocos.slice(primero!.inicio, primero!.inicio + 30)).toContain('mw-heading');
  });
});

describe('quitarSecciones — anidamiento', () => {
  it('se lleva la sección entera, subsecciones incluidas', () => {
    const html =
      '<p>Lead.</p><h2>Argumento</h2><p>spoiler</p><h3>Segunda parte</h3><p>más spoiler</p><h2>Adaptaciones</h2><p>la película</p>';

    const { texto } = quitarSecciones(html, encabezadosHtml(html), 'openlibrary');

    expect(texto).toContain('Lead.');
    expect(texto).toContain('la película');
    expect(texto).not.toContain('spoiler');
    expect(texto).not.toContain('Segunda parte');
  });

  it('no toca nada si ningún encabezado está prohibido', () => {
    const html = '<p>Lead.</p><h2>Recepción</h2><p>gustó mucho</p>';
    const { texto, descartes } = quitarSecciones(html, encabezadosHtml(html), 'openlibrary');

    expect(texto).toBe(html);
    expect(descartes).toHaveLength(0);
  });

  it('reporta cada sección borrada con su encabezado y su tamaño', () => {
    const html = '<h2>Argumento</h2><p>0123456789</p><h2>Premios</h2><p>ok</p>';
    const { descartes } = quitarSecciones(html, encabezadosHtml(html), 'wikipedia');

    expect(descartes).toHaveLength(1);
    expect(descartes[0]).toMatchObject({
      motivo: 'seccion-prohibida',
      source: 'wikipedia',
      detalle: 'Argumento',
    });
    expect(descartes[0]!.chars).toBeGreaterThan(10);
  });

  it('descarta varias secciones en el mismo texto sin correrse de índice', () => {
    const html =
      '<p>Lead.</p><h2>Argumento</h2><p>AAA</p><h2>Premios</h2><p>BBB</p><h2>Personajes</h2><p>CCC</p>';

    const { texto, descartes } = quitarSecciones(html, encabezadosHtml(html), 'openlibrary');

    expect(texto).toContain('BBB');
    expect(texto).not.toContain('AAA');
    expect(texto).not.toContain('CCC');
    expect(detalles(descartes)).toEqual(['Argumento', 'Personajes']);
  });
});

describe('encabezadosTexto — el camino real por el que entra un argumento', () => {
  it('lee encabezados de wikitexto', () => {
    // Open Library sirve seguido el artículo de Wikipedia copiado y pegado.
    const texto = '== Argumento ==\nspoiler\n== Premios ==\nok';
    expect(encabezadosTexto(texto).map((e) => e.titulo)).toEqual(['Argumento', 'Premios']);
  });

  it('lee encabezados de markdown con su nivel', () => {
    const texto = '## Argumento\nspoiler\n### Detalle\nmás\n## Premios\nok';
    expect(encabezadosTexto(texto).map((e) => `${e.nivel}:${e.titulo}`)).toEqual([
      '2:Argumento',
      '3:Detalle',
      '2:Premios',
    ]);
  });

  it('borra la sección de wikitexto entera', () => {
    const texto = 'Lead.\n\n== Argumento ==\nEl protagonista muere.\n\n== Premios ==\nGanó todo.';
    const { texto: limpio } = sanitizarTexto(texto, 'openlibrary');

    expect(limpio).toContain('Lead.');
    expect(limpio).toContain('Ganó todo.');
    expect(limpio).not.toContain('muere');
  });
});

describe('encabezadosPelados — encabezados a los que se les cayó el marcado', () => {
  it('agarra una línea corta y suelta que es un encabezado disfrazado', () => {
    const encabezados = encabezadosPelados('Lead del libro.\nArgumento\nEl protagonista muere.');
    expect(encabezados.map((e) => e.titulo)).toEqual(['Argumento']);
  });

  it('NO agarra un párrafo que casualmente arranca con una palabra prohibida', () => {
    // El falso positivo es caro: deja al modelo sin contexto y ahí inventa.
    const parrafo =
      'Final de una era: la novela retrata el ocaso de una familia en el Buenos Aires de los años veinte.';
    expect(encabezadosPelados(parrafo)).toHaveLength(0);
  });

  it('NO agarra una línea corta que termina en puntuación de oración', () => {
    expect(encabezadosPelados('Resumen de la obra.')).toHaveLength(0);
  });
});

describe('fixture real · Los siete locos (Argumento + Personajes principales)', () => {
  const { texto, descartes } = sanitizarTexto(losSieteLocos, 'openlibrary', 100_000);

  it('borra las dos secciones prohibidas y solo esas', () => {
    expect(detalles(descartes.filter((d) => d.motivo === 'seccion-prohibida'))).toEqual([
      'Argumento',
      'Personajes principales',
    ]);
  });

  it('el argumento no sobrevive', () => {
    // "burdeles" aparece UNA sola vez en todo el artículo, adentro de
    // Argumento. Es el canario: si aparece, el corte de secciones falló.
    expect(losSieteLocos).toContain('burdeles');
    expect(texto).not.toContain('burdeles');
    expect(texto).not.toContain('Astrólogo');
  });

  it('el lead y las secciones inocentes sobreviven', () => {
    expect(texto).toContain('Roberto Arlt');
    expect(texto).toContain('Estructura');
  });

  it('no queda una sola etiqueta ni CSS del infobox', () => {
    expect(texto).not.toMatch(/<[a-z/]/i);
    expect(texto).not.toContain('mw-parser-output');
    expect(texto).not.toContain('max-width');
  });
});

describe('fixture real · El túnel (Trama por capítulos, con subsecciones)', () => {
  const { texto, descartes } = sanitizarTexto(elTunel, 'openlibrary', 100_000);

  it('borra la sección de trama con TODAS sus subsecciones', () => {
    expect(detalles(descartes)).toContain('Trama por capítulos');
    expect(texto).not.toContain('Capítulo 1 y 2');
    expect(texto).not.toContain('Capítulo 9 a 15');
    expect(texto).not.toContain('Capítulo 34 a 39');
  });

  it('el desarrollo de la trama no sobrevive', () => {
    expect(elTunel).toContain('María Iribarne');
    expect(texto).not.toContain('Maternidad');
    expect(texto).not.toContain('salón Primavera');
  });

  it('borra Personajes y todo lo que cuelga de él', () => {
    // "Aceptación de la crítica" es un h3 dentro de "Personajes": se va como
    // daño colateral, y está bien que se vaya. Una sección de recepción
    // metida adentro de la de personajes habla de personajes.
    expect(detalles(descartes)).toContain('Personajes');
    expect(texto).not.toContain('Aceptación de la crítica');
    expect(texto).not.toContain('Secundarios');
  });

  it('lo que no es trama ni personajes sobrevive', () => {
    expect(texto).toContain('Adaptaciones cinematográficas');
    expect(texto).toContain('Ernesto Sabato');
  });
});

describe('fixture real · Distancia de rescate (control negativo)', () => {
  const { texto, descartes } = sanitizarTexto(distanciaDeRescate, 'openlibrary', 100_000);

  it('no borra NINGUNA sección: el artículo no tiene ninguna prohibida', () => {
    // Tan importante como los otros dos: un sanitizador que borra todo pasa
    // cualquier test de spoilers y deja al modelo sin contexto para inventar.
    expect(motivos(descartes)).not.toContain('seccion-prohibida');
    expect(motivos(descartes)).not.toContain('resenas-usuarios');
  });

  it('conserva las cuatro secciones reales', () => {
    for (const seccion of ['Composición', 'Recepción', 'Adaptación cinematográfica']) {
      expect(texto, seccion).toContain(seccion);
    }
  });

  it('deja texto usable, no un string vacío', () => {
    expect(texto.length).toBeGreaterThan(500);
    expect(texto).toContain('Samanta Schweblin');
  });
});

describe('regla 3 · Wikipedia entra solo con el primer párrafo', () => {
  it('recorta al lead aunque el extracto traiga cinco párrafos', () => {
    const extracto = 'El lead del libro.\n\nSegundo párrafo.\n\nTercero.';
    const { texto, descartes } = sanitizarTexto(extracto, 'wikipedia');

    expect(texto).toBe('El lead del libro.');
    expect(motivos(descartes)).toContain('parrafos-posteriores');
  });

  it('NO recorta al primer párrafo las otras fuentes', () => {
    // La contratapa de Google Books entra entera: es texto de venta, ya
    // escrito sin spoilers (regla 3).
    const contratapa = 'Primer párrafo de la contratapa.\n\nSegundo párrafo.';
    const { texto } = sanitizarTexto(contratapa, 'googlebooks');

    expect(texto).toBe(contratapa);
  });

  it('el artículo entero de Wikipedia queda reducido a una sola oración', () => {
    const { texto } = sanitizarTexto(elTunel, 'wikipedia', 100_000);

    expect(texto.split(/\n\s*\n/)).toHaveLength(1);
    expect(texto).toContain('novela corta de Ernesto Sabato');
    expect(texto).not.toContain('Maternidad');
  });
});

describe('reseñas de usuarios', () => {
  it('borra el bloque de reseñas y lo reporta como tal', () => {
    const html =
      '<p>La contratapa.</p><h2>Opiniones de los lectores</h2><p>Me encantó, aunque el final es triste.</p>';
    const { texto, descartes } = sanitizarTexto(html, 'googlebooks');

    expect(texto).toBe('La contratapa.');
    expect(motivos(descartes)).toEqual(['resenas-usuarios']);
  });

  it('agarra las variantes que aparecen en catálogos en inglés', () => {
    for (const encabezado of ['Customer reviews', 'User Reviews', 'Reseñas de clientes']) {
      const { descartes } = sanitizarTexto(
        `<p>ok</p><h2>${encabezado}</h2><p>cinco estrellas</p>`,
        'googlebooks'
      );
      expect(motivos(descartes), encabezado).toContain('resenas-usuarios');
    }
  });

  it('no confunde crítica profesional con reseñas de usuarios', () => {
    // La regla 3 veta reseñas de usuarios, no la sección de recepción crítica.
    const { descartes } = sanitizarTexto('<p>ok</p><h2>Recepción</h2><p>la crítica…</p>', 'openlibrary');
    expect(motivos(descartes)).not.toContain('resenas-usuarios');
  });
});

describe('marcador explícito de spoiler', () => {
  it('corta desde el aviso hasta el final', () => {
    const texto = 'La premisa del libro.\nAdvertencia: spoilers a continuación\nEl asesino era el mayordomo.';
    const { texto: limpio, descartes } = sanitizarTexto(texto, 'openlibrary');

    expect(limpio).toBe('La premisa del libro.');
    expect(limpio).not.toContain('mayordomo');
    expect(motivos(descartes)).toContain('marcado-spoiler');
  });

  it('agarra las variantes usuales', () => {
    for (const aviso of ['ALERTA DE SPOILERS', 'Contiene spoilers', 'spoiler alert']) {
      const { texto } = sanitizarTexto(`Premisa.\n${aviso}\nrevelación`, 'openlibrary');
      expect(texto, aviso).not.toContain('revelación');
    }
  });
});

describe('techo de contexto', () => {
  it('recorta por fuente y avisa cuánto cortó', () => {
    const largo = 'Una oración de relleno bastante larga. '.repeat(200);
    const { texto, descartes } = sanitizarTexto(largo, 'googlebooks');

    expect(texto.length).toBeLessThanOrEqual(LIMITE_POR_FUENTE);
    expect(motivos(descartes)).toContain('recorte-por-largo');
  });

  it('corta en el punto anterior, no en la mitad de una oración', () => {
    const largo = 'Una oración de relleno bastante larga. '.repeat(200);
    const { texto } = sanitizarTexto(largo, 'googlebooks');

    // Una oración partida al aire es justo lo que hace alucinar a un modelo
    // chico: completa la frase por su cuenta.
    expect(texto.endsWith('.')).toBe(true);
  });

  it('no recorta lo que entra', () => {
    const { texto, descartes } = sanitizarTexto('Corto y al pie.', 'googlebooks');
    expect(texto).toBe('Corto y al pie.');
    expect(descartes).toHaveLength(0);
  });
});

describe('sanitizeDescriptions — entrada real de la cascada', () => {
  const candidatas: DescriptionCandidate[] = [
    { source: 'googlebooks', text: '<p>La contratapa del editor.</p>' },
    { source: 'openlibrary', text: 'Lead.\n\n== Argumento ==\nEl protagonista muere.' },
    { source: 'wikipedia', text: 'El lead de Wikipedia.\n\nEl argumento completo.' },
  ];

  it('conserva la procedencia y el orden que trajo el merge', () => {
    // No se concatenan (regla 3): cada fuente se filtra distinto y el prompt
    // necesita saber de dónde salió cada bloque.
    const { textos } = sanitizeDescriptions(candidatas);
    expect(textos.map((t) => t.source)).toEqual(['googlebooks', 'openlibrary', 'wikipedia']);
  });

  it('aplica a cada fuente la regla que le toca', () => {
    const { textos } = sanitizeDescriptions(candidatas);

    expect(textos[0]!.text).toBe('La contratapa del editor.');
    expect(textos[1]!.text).toBe('Lead.');
    expect(textos[2]!.text).toBe('El lead de Wikipedia.');
  });

  it('descarta el duplicado cuando dos fuentes traen el mismo texto', () => {
    // Open Library copia seguido la contratapa que ya trajo Google Books:
    // mandar las dos paga los mismos tokens dos veces.
    const { textos, descartes } = sanitizeDescriptions([
      { source: 'googlebooks', text: 'La misma contratapa, palabra por palabra.' },
      { source: 'openlibrary', text: 'La misma contratapa, palabra por palabra.' },
    ]);

    expect(textos).toHaveLength(1);
    expect(motivos(descartes)).toContain('duplicado');
  });

  it('respeta el techo total entre todas las fuentes', () => {
    const relleno = 'Oración de relleno. '.repeat(300);
    const { textos } = sanitizeDescriptions(
      [
        { source: 'googlebooks', text: relleno },
        { source: 'openlibrary', text: `${relleno} distinto` },
      ],
      { porFuente: 1_000, total: 1_500 }
    );

    const total = textos.reduce((suma, t) => suma + t.text.length, 0);
    expect(total).toBeLessThanOrEqual(1_500);
  });

  it('saltea las fuentes que quedaron vacías después de filtrar', () => {
    const { textos } = sanitizeDescriptions([
      { source: 'openlibrary', text: '== Argumento ==\nSolo spoilers acá.' },
      { source: 'googlebooks', text: 'Esto sí sirve.' },
    ]);

    expect(textos).toHaveLength(1);
    expect(textos[0]!.source).toBe('googlebooks');
  });

  it('con la lista vacía devuelve vacío y no explota', () => {
    expect(sanitizeDescriptions([])).toEqual({ textos: [], descartes: [] });
  });

  it('los tres fixtures reales pasan sin lanzar y con presupuesto respetado', () => {
    const { textos } = sanitizeDescriptions([
      { source: 'googlebooks', text: losSieteLocos },
      { source: 'openlibrary', text: elTunel },
      { source: 'wikipedia', text: distanciaDeRescate },
    ]);

    const total = textos.reduce((suma, t) => suma + t.text.length, 0);
    expect(total).toBeLessThanOrEqual(4_000);
    expect(textos.every((t) => !/<[a-z/]/i.test(t.text))).toBe(true);
  });
});
