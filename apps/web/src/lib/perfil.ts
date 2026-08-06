/**
 * El perfil del lector.
 *
 * ## Por qué vive acá y no en `packages/shared`
 *
 * `@lector/shared` es lo que **comparten** la PWA y el Worker, y el perfil es
 * justamente lo único que el Worker no puede ver nunca (CLAUDE.md, regla 2: el
 * servidor jamás recibe datos del usuario). Publicarlo en shared lo dejaría a un
 * `import` de distancia desde `apps/api`, que es exactamente el error que la
 * regla existe para prevenir. Vive del lado del cliente, que es donde se usa y
 * donde se queda.
 *
 * ## Por qué el vector es parcial
 *
 * El onboarding se puede saltear y completar después, así que un perfil a medio
 * armar es un estado normal y no un error. Las dimensiones ausentes se
 * **excluyen** del coseno en vez de imputarse a 0.5: imputar inventaría una
 * preferencia que el lector nunca expresó, la mezclaría con las que sí expresó y
 * no dejaría rastro de cuál era cuál.
 *
 * ## Por qué no hay campo de "tolerancia de extensión"
 *
 * El paso 4 del onboarding pregunta por el largo, pero eso ya es una dimensión
 * del vector (`extension`, 0 = menos de 200pp, 1 = más de 600). La respuesta se
 * guarda ahí y en su peso. Un campo aparte sería el mismo dato en dos lugares, y
 * uno de los dos iba a quedar viejo.
 */
import type { AppealDimension, AppealVector, ContentFlag } from '@lector/shared';

/** Peso de una dimensión que el lector no ponderó. Todas valen igual por defecto. */
export const PESO_NEUTRO = 1;

export type UserProfile = {
  /**
   * Promedio de los vectores de los libros elegidos en el onboarding, ajustado
   * por los pares forzados. Parcial a propósito — ver el encabezado.
   */
  vector: Partial<AppealVector>;
  /**
   * Cuánto le importa cada dimensión. Sin entrada → `PESO_NEUTRO`.
   *
   * Salen de los 5 pares forzados: elegir un polo no solo mueve el valor de la
   * dimensión, también sube cuánto pesa. Alguien que eligió "que me siga dando
   * vueltas una semana" está diciendo dos cosas —`cargaEmocional` alta **y** que
   * le importa— y son dos números distintos.
   */
  pesos?: Partial<Record<AppealDimension, number>>;
  /**
   * Filtros duros. Un solo flag en común alcanza para bloquear (regla 5): son
   * cosas que el lector pidió no encontrarse, no preferencias a promediar.
   */
  avoids: ContentFlag[];
};

/**
 * El perfil de alguien que salteó el onboarding.
 *
 * No es un `null` disfrazado: puntúa igual que cualquier otro, solo que sin
 * dimensiones para comparar. `scoreBook` devuelve el neutro y avisa con
 * `dimensionesComparadas: 0`.
 */
export function perfilVacio(): UserProfile {
  return { vector: {}, avoids: [] };
}
