/**
 * El JSON Schema de la salida y su validación con Zod.
 *
 * Lo que más se testea acá es que el schema **se derive** de `@lector/shared` y
 * no sea una copia: una copia vieja falla en silencio, con el modelo devolviendo
 * 13 dimensiones buenas y una inventada.
 */
import { describe, expect, it } from 'vitest';
import { APPEAL_DIMENSIONS, CONTENT_FLAGS } from '@lector/shared';
import { NOMBRE_SCHEMA, POLOS, jsonSchemaEnriquecimiento, validarSalida } from '../src/llm/schema';

/** Una salida válida, para mutarla en cada caso. */
function salidaValida(overrides: Record<string, unknown> = {}) {
  return {
    summary: 'Un resumen del planteo, sin contar nada de lo que pasa después.',
    hook: 'Un gancho de una línea.',
    genres: ['novela', 'realismo'],
    appeal_vector: Object.fromEntries(APPEAL_DIMENSIONS.map((d) => [d, 0.5])),
    content_flags: [],
    comparables: ['Stoner, de John Williams'],
    confidence: 0.8,
    ...overrides,
  };
}

describe('jsonSchemaEnriquecimiento — modo estricto de OpenAI', () => {
  const schema = jsonSchemaEnriquecimiento() as Record<string, any>;

  it('tiene additionalProperties:false en CADA nivel', () => {
    // OpenAI rechaza el schema entero si falta en cualquier objeto anidado.
    expect(schema['additionalProperties']).toBe(false);
    expect(schema['properties'].appeal_vector.additionalProperties).toBe(false);
  });

  it('lista TODAS las propiedades en required, sin opcionales', () => {
    // En strict mode no existen los campos opcionales: `comparables` vacío se
    // manda como [], no se omite.
    expect(schema['required']).toEqual(Object.keys(schema['properties']));
    expect(schema['required']).toContain('comparables');
  });

  it('las 14 dimensiones salen de APPEAL_DIMENSIONS, no de una copia', () => {
    const dims = Object.keys(schema['properties'].appeal_vector.properties);

    expect(dims).toEqual([...APPEAL_DIMENSIONS]);
    expect(dims).toHaveLength(14);
    expect(schema['properties'].appeal_vector.required).toEqual([...APPEAL_DIMENSIONS]);
  });

  it('cada dimensión declara su rango y sus polos', () => {
    for (const dim of APPEAL_DIMENSIONS) {
      const prop = schema['properties'].appeal_vector.properties[dim];
      expect(prop.type, dim).toBe('number');
      expect(prop.minimum, dim).toBe(0);
      expect(prop.maximum, dim).toBe(1);
      expect(prop.description, dim).toBe(POLOS[dim]);
    }
  });

  it('content_flags es un enum cerrado que sale de CONTENT_FLAGS', () => {
    expect(schema['properties'].content_flags.items.enum).toEqual([...CONTENT_FLAGS]);
  });

  it('el schema es un objeto nuevo cada vez: nadie lo puede mutar', () => {
    const uno = jsonSchemaEnriquecimiento() as Record<string, any>;
    uno['properties'].summary.description = 'pisado';

    expect((jsonSchemaEnriquecimiento() as Record<string, any>)['properties'].summary.description)
      .not.toBe('pisado');
  });

  it('el nombre del schema viaja en la request', () => {
    expect(NOMBRE_SCHEMA).toBe('enriquecimiento_libro');
  });
});

describe('validarSalida — rangos y semántica', () => {
  it('acepta una salida bien formada y la pasa a camelCase', () => {
    const resultado = validarSalida(salidaValida());

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.valor.appealVector.ritmo).toBe(0.5);
    expect(resultado.valor.contentFlags).toEqual([]);
    expect(resultado.valor.summary).toContain('planteo');
  });

  it('CLAMPEA los valores fuera de rango en vez de tirar el libro', () => {
    // El JSON Schema no restringe rangos: un 1.4 pasa la decodificación igual.
    // Un modelo redondeando mal no puede costarnos la ficha entera.
    const vector = Object.fromEntries(APPEAL_DIMENSIONS.map((d) => [d, 0.5]));
    vector['ritmo'] = 1.4;
    vector['humor'] = -0.3;

    const resultado = validarSalida(salidaValida({ appeal_vector: vector }));

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.valor.appealVector.ritmo).toBe(1);
    expect(resultado.valor.appealVector.humor).toBe(0);
  });

  it('clampea también el confidence', () => {
    const resultado = validarSalida(salidaValida({ confidence: 1.5 }));
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.valor.confidence).toBe(1);
  });

  it('rechaza si falta una dimensión: 13 de 14 no es un vector', () => {
    const vector = Object.fromEntries(
      APPEAL_DIMENSIONS.filter((d) => d !== 'humor').map((d) => [d, 0.5])
    );

    const resultado = validarSalida(salidaValida({ appeal_vector: vector }));

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.motivo).toContain('humor');
  });

  it('FILTRA los content_flags inventados en vez de rechazar la ficha', () => {
    // Un modelo de la cola inventando 'violencia-psicologica' no puede costar el
    // enriquecimiento entero; el vocabulario cerrado de shared es el que manda.
    const resultado = validarSalida(
      salidaValida({ content_flags: ['suicidio', 'violencia-psicologica', 'maltrato-animal'] })
    );

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.valor.contentFlags).toEqual(['suicidio', 'maltrato-animal']);
  });

  it('rechaza un summary vacío', () => {
    expect(validarSalida(salidaValida({ summary: '' })).ok).toBe(false);
  });

  it('rechaza cualquier cosa que no sea un objeto', () => {
    for (const basura of [null, undefined, 'un string', 42, []]) {
      expect(validarSalida(basura).ok, String(basura)).toBe(false);
    }
  });

  it('normaliza los géneros a minúscula y sin espacios de más', () => {
    const resultado = validarSalida(salidaValida({ genres: ['  Novela Negra ', 'ENSAYO'] }));

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.valor.genres).toEqual(['novela negra', 'ensayo']);
  });

  it('el motivo del rechazo dice qué campo falló, no "invalid input"', () => {
    const resultado = validarSalida({ summary: 'ok' });

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.motivo.length).toBeGreaterThan(10);
    expect(resultado.motivo).toMatch(/hook|appeal_vector|genres/);
  });
});
