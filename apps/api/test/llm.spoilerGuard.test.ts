/**
 * El guard de salida.
 *
 * Los falsos negativos arruinan un libro; los falsos positivos arruinan el
 * catálogo entero, porque penalizan el confidence de fichas que estaban bien.
 * Por eso hay tantos casos negativos como positivos.
 */
import { describe, expect, it } from 'vitest';
import {
  PENALIZACION_REVISION,
  describirHallazgos,
  penalizarConfidence,
  revisarSpoilers,
} from '../src/llm/spoilerGuard';

function revisar(summary: string, hook = 'Un gancho limpio.') {
  return revisarSpoilers({ summary, hook });
}

describe('detecta las construcciones de revelación', () => {
  const casos: [string, string][] = [
    ['al-final', 'La novela sigue a Erdosain y al final todo se derrumba.'],
    ['resulta-que', 'Un detective investiga un robo, pero resulta que fue su socio.'],
    ['se-revela', 'Con el correr de las páginas se revela que el narrador miente.'],
    ['descubre-que', 'La protagonista descubre que en realidad es hija del rey.'],
    ['termina-con', 'La historia termina con la casa vacía.'],
    ['termina-gerundio', 'El protagonista termina aceptando su destino.'],
    ['muere', 'Es una historia de amistad en la que uno de los dos muere.'],
    ['desenlace', 'El desenlace ocurre en la estación de tren.'],
    ['en-realidad', 'El pueblo en realidad es un recuerdo.'],
    ['asesina-a', 'El narrador asesina a su amante.'],
  ];

  for (const [nombre, texto] of casos) {
    it(`rechaza "${nombre}"`, () => {
      const veredicto = revisar(texto);
      expect(veredicto.limpio, texto).toBe(false);
      if (veredicto.limpio) return;
      expect(veredicto.hallazgos.map((h) => h.nombre)).toContain(nombre);
    });
  }

  it('detecta también en el hook, no solo en el summary', () => {
    const veredicto = revisarSpoilers({
      summary: 'Un resumen impecable del planteo inicial.',
      hook: 'Nadie adivina que el asesino muere primero.',
    });

    expect(veredicto.limpio).toBe(false);
    if (veredicto.limpio) return;
    expect(veredicto.hallazgos[0]!.campo).toBe('hook');
  });

  it('junta todos los hallazgos, no se corta en el primero', () => {
    const veredicto = revisar('Al final resulta que el protagonista muere.');

    expect(veredicto.limpio).toBe(false);
    if (veredicto.limpio) return;
    expect(veredicto.hallazgos.length).toBeGreaterThanOrEqual(3);
  });

  it('guarda el fragmento con contexto, para poder leer el log', () => {
    const veredicto = revisar('Una novela larga sobre una familia donde al final nadie se salva.');

    expect(veredicto.limpio).toBe(false);
    if (veredicto.limpio) return;
    expect(veredicto.hallazgos[0]!.fragmento).toContain('al final');
    expect(veredicto.hallazgos[0]!.fragmento.length).toBeGreaterThan('al final'.length);
  });
});

describe('NO se activa con resúmenes legítimos', () => {
  const limpios = [
    // El caso más importante: la muerte como PREMISA es el arranque de un
    // tercio de las novelas que existen. Marcarla haría saltar el guard sobre
    // medio catálogo y la penalización dejaría de significar nada.
    'Tras la muerte de su padre, Amanda vuelve al pueblo donde creció.',
    'La novela arranca con un velorio y la llegada de un forastero.',
    'Un profesor de literatura vive una vida gris en una universidad del Medio Oeste.',
    'Dos hermanas heredan una casa en la costa y tienen que decidir qué hacer con ella.',
    'Ambientada en el Buenos Aires de los años veinte, retrata a un grupo de conspiradores.',
    'Es un ensayo sobre el duelo, escrito desde la experiencia personal del autor.',
    'El protagonista es un inventor obsesionado con una máquina que nadie entiende.',
  ];

  for (const texto of limpios) {
    it(`deja pasar: "${texto.slice(0, 45)}…"`, () => {
      expect(revisar(texto).limpio, texto).toBe(true);
    });
  }

  it('"muerte" como sustantivo no dispara; "muere" como verbo sí', () => {
    expect(revisar('Habla de la muerte y del duelo.').limpio).toBe(true);
    expect(revisar('El personaje muere.').limpio).toBe(false);
  });

  it('no confunde "final" dentro de otra palabra', () => {
    expect(revisar('Una novela sobre la etapa final de la carrera de un pianista.').limpio).toBe(
      true
    );
  });
});

describe('penalización', () => {
  it('multiplica por el factor de revisión', () => {
    expect(penalizarConfidence(0.8)).toBeCloseTo(0.8 * PENALIZACION_REVISION);
  });

  it('es más dura que el ×0.8 de la cola larga', () => {
    // Un modelo económico mal calibrado sigue siendo útil. Un resumen que
    // probablemente spoilea es justo lo que el producto promete no hacer.
    expect(PENALIZACION_REVISION).toBeLessThan(0.8);
  });

  it('nunca se sale de 0–1', () => {
    expect(penalizarConfidence(5)).toBeLessThanOrEqual(1);
    expect(penalizarConfidence(-1)).toBe(0);
  });
});

describe('describirHallazgos', () => {
  it('arma una línea legible para el log del Worker', () => {
    const veredicto = revisar('Al final todo se resuelve.');
    expect(veredicto.limpio).toBe(false);
    if (veredicto.limpio) return;

    const linea = describirHallazgos(veredicto.hallazgos);
    expect(linea).toContain('summary/al-final');
    expect(linea).toContain('Al final');
  });
});
