-- Migration number: 0002 	 upgrade perezoso y marca de revisión
-- Cierra el punto 7 de la Fase 3. Dos cosas que el esquema inicial no previó
-- porque todavía no existía el adapter de LLM:
--
-- 1. `needs_review`: el spoiler guard puede fallar dos veces seguidas. La ficha
--    se guarda igual (docs: una ficha sospechosa con confidence bajo le sirve
--    más al lector que una pantalla vacía), pero queda marcada.
--
-- 2. `enrichment_upgrades`: la cola del upgrade perezoso. Un libro enriquecido
--    con el modelo de la cola que acumula 3 escaneos se anota acá para que
--    `scripts/enrich-batch.ts` lo re-enriquezca con el modelo de la cabeza. El
--    sistema se auto-repara hacia donde está la demanda real (docs/LLM.md).
--
-- Es una tabla y no una columna en `enrichments` porque la cola necesita un
-- estado propio —cuándo se encoló, con qué modelo estaba, cuándo se procesó—
-- que no tiene nada que ver con la ficha en sí.

ALTER TABLE enrichments ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0;

CREATE TABLE enrichment_upgrades (
  isbn13     TEXT PRIMARY KEY REFERENCES books(isbn13),
  reason     TEXT NOT NULL,      -- 'scan-count' | 'needs-review'
  from_model TEXT NOT NULL,      -- con qué modelo estaba enriquecido al encolar
  queued_at  INTEGER NOT NULL,
  done_at    INTEGER             -- NULL mientras siga pendiente
);

-- El drenaje de la cola pide siempre lo pendiente. Sin índice, `enrich-batch`
-- escanea la tabla entera en cada corrida.
CREATE INDEX idx_enrichment_upgrades_pendientes
  ON enrichment_upgrades (queued_at)
  WHERE done_at IS NULL;
