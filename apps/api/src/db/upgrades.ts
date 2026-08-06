/**
 * `enrichment_upgrades` — la cola del upgrade perezoso.
 *
 * La distribución de escaneos es zipfiana (docs/LLM.md): unos pocos títulos se
 * llevan casi todo el tráfico. Un cache miss en vivo usa siempre el modelo de la
 * cola —un libro que nadie escaneó todavía no es cabeza, por definición— y esta
 * tabla es el mecanismo que corrige esa apuesta cuando el libro resulta popular:
 * a los 3 escaneos se anota para re-enriquecerlo con el modelo bueno.
 *
 * **Acá no se llama al LLM.** Encolar es un INSERT y nada más. El drenaje lo
 * hace `scripts/enrich-batch.ts` (punto 8 de la Fase 3), fuera del camino del
 * request: gastar segundos de un cache hit —el 95% del tráfico, el que tiene que
 * responder en menos de 100 ms— para re-enriquecer sería romper justo lo que
 * este diseño protege.
 */

/** Escaneos a partir de los cuales un libro de la cola merece el modelo pago. */
export const UMBRAL_UPGRADE = 3;

export const MOTIVOS_UPGRADE = ['scan-count', 'needs-review'] as const;

export type MotivoUpgrade = (typeof MOTIVOS_UPGRADE)[number];

export type PedidoUpgrade = {
  isbn13: string;
  motivo: MotivoUpgrade;
  /** Con qué modelo estaba enriquecido cuando se encoló. Para auditar después. */
  fromModel: string;
};

/**
 * Decide si una ficha ya guardada merece el upgrade. Función pura: toda la
 * política vive acá y se testea sin base.
 *
 * La comparación es contra el modelo de la **cabeza**, no contra el de la cola,
 * y no es un detalle: el ID de la cola cambia cada vez que un catálogo gratuito
 * se cae, y los proveedores decoran lo que devuelven (`fixture:` adelante, o un
 * ID versionado que no coincide con el configurado). Preguntar "¿ya está en lo
 * mejor que tenemos?" es estable; preguntar "¿es exactamente el de la cola?"
 * empieza a fallar en silencio el día que rota un model ID.
 */
export function decidirUpgrade(params: {
  modelUsed: string;
  scanCount: number;
  needsReview: boolean;
  /** `LLM_MODEL`. Una ficha ya hecha con este modelo no tiene a dónde subir. */
  modeloCabeza: string;
}): MotivoUpgrade | null {
  if (params.modelUsed === params.modeloCabeza) return null;
  if (params.needsReview) return 'needs-review';
  if (params.scanCount >= UMBRAL_UPGRADE) return 'scan-count';
  return null;
}

/**
 * Anota un libro en la cola. Idempotente por `INSERT OR IGNORE`: los escaneos
 * 4, 5 y 6 de un libro ya encolado no hacen nada.
 *
 * **Nunca lanza.** Perder un upgrade degrada la calidad de una ficha; romper el
 * escaneo deja a alguien parado en el pasillo mirando un error. Devuelve si se
 * pudo guardar, para poder loguearlo sin cortar la respuesta.
 */
export async function encolarUpgrade(
  db: D1Database,
  pedido: PedidoUpgrade,
  now: number = Date.now()
): Promise<boolean> {
  try {
    await db
      .prepare(
        `INSERT OR IGNORE INTO enrichment_upgrades (isbn13, reason, from_model, queued_at)
         VALUES (?, ?, ?, ?)`
      )
      .bind(pedido.isbn13, pedido.motivo, pedido.fromModel, now)
      .run();

    return true;
  } catch (error) {
    console.warn(
      `[upgrade] no se pudo encolar ${pedido.isbn13}: ` +
        (error instanceof Error ? error.message : String(error))
    );
    return false;
  }
}
