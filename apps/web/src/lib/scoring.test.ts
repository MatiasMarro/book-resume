import { describe, expect, it } from 'vitest';
import { APPEAL_DIMENSIONS } from '@lector/shared';
import type { AppealVector } from '@lector/shared';
import { perfilVacio, type UserProfile } from './perfil';
import { scoreBook, type LibroPuntuable } from './scoring';

// --- Ayudantes --------------------------------------------------------------

/** Un vector con las 14 dimensiones en el mismo valor. */
function plano(valor: number): AppealVector {
  return Object.fromEntries(APPEAL_DIMENSIONS.map((dim) => [dim, valor])) as AppealVector;
}

/**
 * Un libro puntuable. El vector se completa con `relleno` (0.5 por defecto) para
 * que las dimensiones que un test no nombra no aporten nada al coseno: centradas
 * en 0 no mueven ni el producto ni las normas.
 */
function libro(
  vector: Partial<AppealVector>,
  extra: { contentFlags?: LibroPuntuable['contentFlags']; pageCount?: number; relleno?: number } = {},
): LibroPuntuable {
  return {
    appealVector: { ...plano(extra.relleno ?? 0.5), ...vector },
    contentFlags: extra.contentFlags ?? [],
    ...(extra.pageCount !== undefined && { pageCount: extra.pageCount }),
  };
}

function perfil(vector: Partial<AppealVector>, extra: Partial<UserProfile> = {}): UserProfile {
  return { vector, avoids: [], ...extra };
}

const textos = (resultado: { reasons: { text: string }[] }) =>
  resultado.reasons.map((r) => r.text);
const clases = (resultado: { reasons: { kind: string }[] }) =>
  resultado.reasons.map((r) => r.kind);

// --- El coseno --------------------------------------------------------------

describe('scoreBook · similitud', () => {
  it('da 100 con vectores idénticos', () => {
    const resultado = scoreBook(libro(plano(0.9)), perfil(plano(0.9)));
    expect(resultado.score).toBe(100);
    expect(resultado.band).toBe('alta');
  });

  it('da 0 con vectores opuestos', () => {
    expect(scoreBook(libro(plano(0.9)), perfil(plano(0.1))).score).toBe(0);
  });

  // Regresión de la razón por la que el coseno va centrado: sin restarle 0.5 a
  // cada componente, estos dos vectores son colineales y puntúan 100.
  it('no confunde un libro extremo en todo con uno mínimo en todo', () => {
    const resultado = scoreBook(libro(plano(0.9)), perfil(plano(0.1)));
    expect(resultado.score).toBe(0);
    expect(resultado.band).toBe('baja');
  });

  it('da el neutro cuando el libro está justo en el centro de todo', () => {
    const resultado = scoreBook(libro(plano(0.5)), perfil(plano(0.9)));
    expect(resultado.score).toBe(50);
  });

  it('da el neutro cuando el perfil está justo en el centro de todo', () => {
    expect(scoreBook(libro(plano(0.9)), perfil(plano(0.5))).score).toBe(50);
  });

  it('da el neutro y no compara nada con un perfil vacío', () => {
    const resultado = scoreBook(libro(plano(0.9)), perfilVacio());
    expect(resultado).toEqual({
      score: 50,
      band: 'media',
      reasons: [],
      dimensionesComparadas: 0,
    });
  });

  it('es determinístico: la misma entrada da exactamente la misma salida', () => {
    const l = libro({ ritmo: 0.9, humor: 0.2, extension: 0.8 }, { pageCount: 610 });
    const p = perfil({ ritmo: 0.85, humor: 0.9, extension: 0.2 });
    expect(scoreBook(l, p)).toEqual(scoreBook(l, p));
  });
});

// --- Pesos ------------------------------------------------------------------

describe('scoreBook · pesos', () => {
  it('deja que una dimensión con peso alto domine el puntaje', () => {
    const l = libro({ ritmo: 0.9, humor: 0.1 });
    const p = perfil({ ritmo: 0.1, humor: 0.9 }, { pesos: { humor: 20 } });

    // Sin pesos las dos dimensiones se cancelarían en 50; con humor pesando 20
    // el desacuerdo en humor manda.
    expect(scoreBook(l, p).score).toBeLessThan(50);
  });

  it('excluye del cálculo una dimensión con peso 0', () => {
    const l = libro({ ritmo: 0.9, humor: 0.1 });
    const p = perfil({ ritmo: 0.9, humor: 0.9 }, { pesos: { humor: 0 } });

    // Con humor adentro habría desacuerdo; con peso 0 queda solo ritmo, que
    // coincide.
    expect(scoreBook(l, p)).toMatchObject({ score: 100, dimensionesComparadas: 1 });
  });

  it('trata un peso negativo como 0 en vez de invertir la dimensión', () => {
    const l = libro({ ritmo: 0.9, humor: 0.1 });
    const p = perfil({ ritmo: 0.9, humor: 0.9 }, { pesos: { humor: -5 } });
    expect(scoreBook(l, p).dimensionesComparadas).toBe(1);
  });

  it('cae al peso neutro si el peso guardado no es un número finito', () => {
    const l = libro({ ritmo: 0.9, humor: 0.9 });
    const p = perfil({ ritmo: 0.9, humor: 0.9 }, { pesos: { humor: Number.NaN } });
    expect(scoreBook(l, p)).toMatchObject({ score: 100, dimensionesComparadas: 2 });
  });
});

// --- Dimensiones faltantes y datos sucios -----------------------------------

describe('scoreBook · dimensiones faltantes', () => {
  it('compara solo las dimensiones que están en los dos lados', () => {
    const resultado = scoreBook(libro(plano(0.9)), perfil({ ritmo: 0.9, humor: 0.9 }));
    expect(resultado.dimensionesComparadas).toBe(2);
    expect(resultado.score).toBe(100);
  });

  it('ignora una dimensión que el libro no trae', () => {
    const incompleto = libro(plano(0.9));
    delete (incompleto.appealVector as Partial<AppealVector>).humor;

    const resultado = scoreBook(incompleto, perfil({ ritmo: 0.9, humor: 0.9 }));
    expect(resultado.dimensionesComparadas).toBe(1);
  });

  it('ignora un valor no finito en el perfil', () => {
    const p = perfil({ ritmo: 0.9, humor: Number.NaN });
    expect(scoreBook(libro(plano(0.9)), p).dimensionesComparadas).toBe(1);
  });

  it('ignora un valor no finito en el libro', () => {
    const roto = libro({ ritmo: 0.9, humor: Number.POSITIVE_INFINITY });
    expect(scoreBook(roto, perfil({ ritmo: 0.9, humor: 0.9 })).dimensionesComparadas).toBe(1);
  });

  it('recorta a 0–1 los valores que se hayan ido de rango', () => {
    // 5 y -3 recortados son 1 y 0: opuestos exactos, o sea puntaje 0. Sin
    // recorte las normas se disparan y el número deja de significar algo.
    const resultado = scoreBook(libro({ ritmo: 5 }), perfil({ ritmo: -3 }));
    expect(resultado.score).toBe(0);
  });

  it('ignora claves de más que hayan quedado en un perfil viejo', () => {
    const p = perfil({ ritmo: 0.9, inventada: 0.9 } as Partial<AppealVector>);
    expect(scoreBook(libro(plano(0.9)), p).dimensionesComparadas).toBe(1);
  });
});

// --- Bandas -----------------------------------------------------------------

describe('scoreBook · bandas', () => {
  it('marca alta justo en el piso de 75', () => {
    // Construido para que el coseno dé exactamente 0.5: con el libro desviado
    // solo en ritmo, el perfil forma 60° con él cuando la otra componente vale
    // √3 veces la primera.
    const componente = 0.4 / Math.sqrt(3);
    const resultado = scoreBook(
      libro({ ritmo: 0.9 }),
      perfil({ ritmo: 0.5 + componente, humor: 0.9 }),
    );
    expect(resultado.score).toBe(75);
    expect(resultado.band).toBe('alta');
  });

  it('marca media justo en el piso de 50', () => {
    const resultado = scoreBook(libro({ ritmo: 0.9, humor: 0.9 }), perfil({ ritmo: 0.9, humor: 0.1 }));
    expect(resultado.score).toBe(50);
    expect(resultado.band).toBe('media');
  });

  it('marca baja apenas abajo del piso de 50', () => {
    const resultado = scoreBook(libro({ ritmo: 0.85, humor: 0.9 }), perfil({ ritmo: 0.9, humor: 0.1 }));
    expect(resultado.score).toBe(47);
    expect(resultado.band).toBe('baja');
  });
});

// --- Filtros duros ----------------------------------------------------------

describe('scoreBook · bloqueos', () => {
  it('bloquea por un solo flag evitado, con la similitud en 100', () => {
    const resultado = scoreBook(
      libro(plano(0.9), { contentFlags: ['maltrato-animal'] }),
      perfil(plano(0.9), { avoids: ['maltrato-animal'] }),
    );

    expect(resultado.band).toBe('bloqueado');
    // El número sobrevive: 100 y bloqueado no es lo mismo que 20 y bloqueado.
    expect(resultado.score).toBe(100);
    expect(resultado.reasons).toContainEqual({
      kind: 'blocker',
      dimension: 'maltrato-animal',
      text: 'Contiene maltrato animal (lo marcaste para evitar)',
    });
  });

  it('no bloquea si los flags del libro no están entre los evitados', () => {
    const resultado = scoreBook(
      libro(plano(0.9), { contentFlags: ['suicidio'] }),
      perfil(plano(0.9), { avoids: ['maltrato-animal'] }),
    );
    expect(resultado.band).toBe('alta');
    expect(clases(resultado)).not.toContain('blocker');
  });

  it('emite una razón por cada flag evitado que el libro tiene', () => {
    const resultado = scoreBook(
      libro(plano(0.9), { contentFlags: ['maltrato-animal', 'suicidio', 'adicciones'] }),
      perfil(plano(0.9), { avoids: ['suicidio', 'maltrato-animal'] }),
    );

    const bloqueos = resultado.reasons.filter((r) => r.kind === 'blocker');
    expect(bloqueos.map((r) => r.dimension)).toEqual(['maltrato-animal', 'suicidio']);
  });

  it('no repite la razón si el flag viene duplicado en la ficha', () => {
    const resultado = scoreBook(
      libro(plano(0.9), { contentFlags: ['suicidio', 'suicidio'] }),
      perfil(plano(0.9), { avoids: ['suicidio'] }),
    );
    expect(resultado.reasons.filter((r) => r.kind === 'blocker')).toHaveLength(1);
  });

  it('bloquea aunque la similitud sea pésima', () => {
    const resultado = scoreBook(
      libro(plano(0.1), { contentFlags: ['final-tragico'] }),
      perfil(plano(0.9), { avoids: ['final-tragico'] }),
    );
    expect(resultado).toMatchObject({ score: 0, band: 'bloqueado' });
  });
});

// --- Razones ----------------------------------------------------------------

describe('scoreBook · razones', () => {
  it('da match en las dimensiones cercanas y marcadas', () => {
    const resultado = scoreBook(
      libro({ ritmo: 0.9, luminosidad: 0.1, humor: 0.9 }),
      perfil({ ritmo: 0.9, luminosidad: 0.1, humor: 0.9 }),
    );

    expect(textos(resultado)).toEqual([
      'Ritmo trepidante, de los que no se sueltan',
      'Tono oscuro, sin consuelo fácil',
      'El humor es central, no un condimento',
    ]);
  });

  it('corta en 3 los matches', () => {
    const dims = { ritmo: 0.9, densidadPersonajes: 0.9, introspeccion: 0.9, linealidad: 0.9 };
    const resultado = scoreBook(libro(dims), perfil(dims));
    expect(resultado.reasons).toHaveLength(3);
  });

  it('pone primero la dimensión que más le importa al lector', () => {
    const dims = { ritmo: 0.9, humor: 0.9 };
    const resultado = scoreBook(libro(dims), perfil(dims, { pesos: { humor: 5 } }));

    expect(resultado.reasons[0]).toMatchObject({ kind: 'match', dimension: 'humor' });
  });

  it('no toma como match una dimensión que ninguno de los dos tiene marcada', () => {
    const resultado = scoreBook(libro({ ritmo: 0.55 }), perfil({ ritmo: 0.55 }));
    expect(clases(resultado)).not.toContain('match');
  });

  it('advierte cuando el libro se desvía mucho, con el polo hacia el que se va', () => {
    const resultado = scoreBook(
      libro({ ritmo: 0.1, luminosidad: 0.1 }),
      perfil({ ritmo: 0.9, luminosidad: 0.9 }),
    );

    expect(textos(resultado)).toEqual([
      'Ritmo bastante más lento de lo que solés elegir',
      'Bastante más oscuro de lo que solés bancar',
    ]);
  });

  it('corta en 2 las advertencias y deja las que más pesan', () => {
    const resultado = scoreBook(
      libro({ ritmo: 0.1, luminosidad: 0.1, humor: 0.1 }),
      perfil({ ritmo: 0.9, luminosidad: 0.9, humor: 0.9 }, { pesos: { humor: 9, luminosidad: 4 } }),
    );

    expect(resultado.reasons.map((r) => r.dimension)).toEqual(['humor', 'luminosidad']);
  });

  // El polo de una advertencia se mide contra el lector, no contra el centro:
  // 0.45 está casi al medio de la escala pero es corto para quien busca 0.9.
  it('mide el polo de la advertencia contra el perfil, no contra el centro', () => {
    const resultado = scoreBook(libro({ extension: 0.45 }), perfil({ extension: 0.9 }));
    expect(textos(resultado)).toEqual(['Más corto de lo que solés elegir']);
  });

  it('ordena las razones: primero los match, después las advertencias, al final los bloqueos', () => {
    const resultado = scoreBook(
      libro(
        { ritmo: 0.9, luminosidad: 0.1 },
        { contentFlags: ['suicidio'] },
      ),
      perfil({ ritmo: 0.9, luminosidad: 0.9 }, { avoids: ['suicidio'] }),
    );

    expect(clases(resultado)).toEqual(['match', 'warning', 'blocker']);
  });

  it('nunca devuelve un puntaje pelado si hubo algo que comparar', () => {
    // Libro parejo en todo: ninguna dimensión llega a ser match ni advertencia.
    // Van dos dimensiones para que la razón tenga que elegir la más marcada.
    const resultado = scoreBook(
      libro({ ritmo: 0.52, humor: 0.5 }),
      perfil({ ritmo: 0.5, humor: 0.52 }),
    );

    expect(resultado.reasons).toEqual([
      {
        kind: 'warning',
        dimension: 'ritmo',
        text: 'Ningún rasgo marcado en las dimensiones que te importan: el puntaje sale de un parecido general',
      },
    ]);
  });
});

// --- Páginas ----------------------------------------------------------------

describe('scoreBook · extensión en páginas', () => {
  it('dice las páginas en la advertencia cuando el libro las trae', () => {
    const resultado = scoreBook(
      libro({ extension: 0.95 }, { pageCount: 640 }),
      perfil({ extension: 0.1 }),
    );

    expect(textos(resultado)).toEqual(['640 páginas — bastante más largo de lo que solés elegir']);
  });

  it('dice las páginas también cuando la extensión es un match', () => {
    const resultado = scoreBook(
      libro({ extension: 0.9 }, { pageCount: 640 }),
      perfil({ extension: 0.9 }),
    );

    expect(textos(resultado)).toEqual(['640 páginas — largo, de los que duran']);
  });

  it('usa el texto sin páginas si el libro no las trae', () => {
    const resultado = scoreBook(libro({ extension: 0.95 }), perfil({ extension: 0.1 }));
    expect(textos(resultado)).toEqual(['Bastante más largo de lo que solés elegir']);
  });

  it('no le mete páginas a una razón de otra dimensión', () => {
    const resultado = scoreBook(libro({ ritmo: 0.9 }, { pageCount: 640 }), perfil({ ritmo: 0.9 }));
    expect(textos(resultado)).toEqual(['Ritmo trepidante, de los que no se sueltan']);
  });
});

// --- Cobertura de los textos ------------------------------------------------

describe('textos de las razones', () => {
  it('tiene las cuatro frases de las 14 dimensiones, sin repetir ninguna', () => {
    const frases = new Set<string>();

    for (const dim of APPEAL_DIMENSIONS) {
      // El polo alto sale como match cuando los dos coinciden en 0.9, y como
      // advertencia cuando el perfil está en el otro extremo. Idem el bajo.
      const alto = scoreBook(libro({ [dim]: 0.9 }), perfil({ [dim]: 0.9 }));
      const bajo = scoreBook(libro({ [dim]: 0.1 }), perfil({ [dim]: 0.1 }));
      const altoWarn = scoreBook(libro({ [dim]: 0.9 }), perfil({ [dim]: 0.1 }));
      const bajoWarn = scoreBook(libro({ [dim]: 0.1 }), perfil({ [dim]: 0.9 }));

      for (const resultado of [alto, bajo, altoWarn, bajoWarn]) {
        expect(resultado.reasons).toHaveLength(1);
        frases.add(resultado.reasons[0]!.text);
      }
    }

    expect(frases.size).toBe(APPEAL_DIMENSIONS.length * 4);
  });
});

describe('perfilVacio', () => {
  it('arranca sin dimensiones y sin evitaciones', () => {
    expect(perfilVacio()).toEqual({ vector: {}, avoids: [] });
  });
});
