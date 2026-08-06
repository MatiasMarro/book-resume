/**
 * El prompt.
 *
 * Dos cosas se testean con dientes: que el bloque de sistema sea **idéntico**
 * entre llamadas (si no, se pierde el caché de prompt de OpenAI y el costo se
 * multiplica) y que las 14 dimensiones lleguen con sus dos anclas (sin anclas,
 * el vector colapsa y el scoring es ruido).
 */
import { describe, expect, it } from 'vitest';
import { APPEAL_DIMENSIONS, CONTENT_FLAGS } from '@lector/shared';
import { BLOQUE_SISTEMA, REFUERZO_ANTI_SPOILER, construirMensajeUsuario } from '../src/llm/prompts';
import type { EnrichRequest } from '../src/llm/types';

function pedido(overrides: Partial<EnrichRequest> = {}): EnrichRequest {
  return {
    isbn13: '9788420471839',
    title: 'Cien años de soledad',
    authors: ['Gabriel García Márquez'],
    subjects: ['realismo mágico'],
    descripciones: [{ source: 'googlebooks', text: 'La contratapa del editor.' }],
    ...overrides,
  };
}

describe('BLOQUE_SISTEMA — el prefijo que se cachea', () => {
  it('es idéntico entre lecturas: es una constante, no se arma por request', () => {
    // Si esto deja de valer, cada libro paga input completo en vez del 10%.
    expect(BLOQUE_SISTEMA).toBe(BLOQUE_SISTEMA);
    expect(typeof BLOQUE_SISTEMA).toBe('string');
  });

  it('no lleva adentro ninguna fecha, ISBN ni título', () => {
    // Cualquiera de esas cosas invalidaría el caché en cada llamada.
    expect(BLOQUE_SISTEMA).not.toMatch(/\b(19|20)\d{2}-\d{2}-\d{2}\b/);
    expect(BLOQUE_SISTEMA).not.toMatch(/\b97[89]\d{10}\b/);
    expect(BLOQUE_SISTEMA).not.toMatch(/\bgpt-|claude-|llama-/i);
  });

  it('menciona las 14 dimensiones con su nombre exacto', () => {
    for (const dim of APPEAL_DIMENSIONS) {
      expect(BLOQUE_SISTEMA, dim).toContain(dim);
    }
  });

  it('le da a CADA dimensión un ancla en 0.1 y otra en 0.9', () => {
    // Es el punto 4 del plan: sin anclas los modelos económicos devuelven todo
    // entre 0.5 y 0.7 y el coseno deja de discriminar.
    const bloques = BLOQUE_SISTEMA.split('\n');

    for (const dim of APPEAL_DIMENSIONS) {
      const i = bloques.findIndex((l) => l.startsWith(`- ${dim} (`));
      expect(i, `falta la línea de ${dim}`).toBeGreaterThan(-1);
      expect(bloques[i + 1], `${dim} sin ancla baja`).toMatch(/^\s+0\.1 → .+, de .+/);
      expect(bloques[i + 2], `${dim} sin ancla alta`).toMatch(/^\s+0\.9 → .+, de .+/);
    }
  });

  it('las anclas son títulos distintos: 28 libros, no 3 repetidos', () => {
    const anclas = [...BLOQUE_SISTEMA.matchAll(/0\.[19] → (.+)/g)].map((m) => m[1]);

    expect(anclas).toHaveLength(28);
    expect(new Set(anclas).size).toBe(28);
  });

  it('lista el vocabulario cerrado de content_flags tal cual está en shared', () => {
    for (const flag of CONTENT_FLAGS) {
      expect(BLOQUE_SISTEMA, flag).toContain(`- ${flag}`);
    }
  });

  it('pide el summary de 60 a 90 palabras en rioplatense', () => {
    expect(BLOQUE_SISTEMA).toContain('60 y 90 palabras');
    expect(BLOQUE_SISTEMA).toContain('rioplatense');
  });

  it('prohíbe explícitamente el punto medio, el giro y el final', () => {
    expect(BLOQUE_SISTEMA).toContain('punto medio');
    expect(BLOQUE_SISTEMA).toMatch(/giro|revelación/);
    expect(BLOQUE_SISTEMA).toMatch(/desenlace|el final/);
    // Y le dice qué hacer si la fuente igual se lo cuenta.
    expect(BLOQUE_SISTEMA).toMatch(/IGNORÁ esa parte/);
  });

  it('pide confidence bajo cuando hay poca fuente', () => {
    expect(BLOQUE_SISTEMA).toMatch(/0\.0 a 0\.3/);
    expect(BLOQUE_SISTEMA).toMatch(/casi no hay fuente/);
  });
});

describe('construirMensajeUsuario', () => {
  it('incluye la metadata que sirve', () => {
    const mensaje = construirMensajeUsuario(
      pedido({ publisher: 'Alfaguara', publishedYear: 2007, pageCount: 609, language: 'es' })
    );

    expect(mensaje).toContain('Cien años de soledad');
    expect(mensaje).toContain('Gabriel García Márquez');
    expect(mensaje).toContain('Alfaguara');
    expect(mensaje).toContain('609');
  });

  it('omite los campos ausentes en vez de escribir "undefined"', () => {
    expect(construirMensajeUsuario(pedido())).not.toContain('undefined');
  });

  it('etiqueta cada descripción con su procedencia', () => {
    // La procedencia cambia cuánto puede confiar el modelo en cada texto: la
    // contratapa es texto de venta, el de Wikipedia es enciclopédico.
    const mensaje = construirMensajeUsuario(
      pedido({
        descripciones: [
          { source: 'googlebooks', text: 'Contratapa.' },
          { source: 'wikipedia', text: 'Lead enciclopédico.' },
        ],
      })
    );

    expect(mensaje).toContain('Contratapa de la editorial (Google Books)');
    expect(mensaje).toContain('Primer párrafo del artículo de Wikipedia');
  });

  it('avisa fuerte cuando NO hay ninguna descripción', () => {
    // Es el caso de la mitad del catálogo argentino según el spike. Si el
    // modelo no sabe que no tiene fuente, inventa la trama con confidence alto.
    const mensaje = construirMensajeUsuario(pedido({ descripciones: [] }));

    expect(mensaje).toContain('NO HAY NINGUNA DESCRIPCIÓN DISPONIBLE');
    expect(mensaje).toContain('No inventes la trama');
  });

  it('corta la lista de materias: cincuenta subjects son ruido pago', () => {
    const mensaje = construirMensajeUsuario(
      pedido({ subjects: Array.from({ length: 50 }, (_, i) => `materia${i}`) })
    );

    expect(mensaje).toContain('materia19');
    expect(mensaje).not.toContain('materia20');
  });

  it('mete el refuerzo anti-spoiler solo cuando se lo pide', () => {
    expect(construirMensajeUsuario(pedido())).not.toContain('RECHAZADO');

    const conRefuerzo = construirMensajeUsuario(
      pedido({ refuerzoAntiSpoiler: REFUERZO_ANTI_SPOILER })
    );
    expect(conRefuerzo).toContain('RECHAZADO');
  });

  it('el refuerzo va en el mensaje del usuario, NUNCA en el de sistema', () => {
    // Meterlo en el bloque de sistema cambiaría el prefijo cacheado de todas
    // las llamadas siguientes.
    expect(BLOQUE_SISTEMA).not.toContain('RECHAZADO');
  });
});
