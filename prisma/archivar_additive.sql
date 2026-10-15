-- Spotlight · archivar nominaciones sin borrarlas (2026-09-21)
-- Caso: seis proyectos se nominaron en Septiembre y luego se les corrió la
-- votación atrasada de Agosto con copias propias. Los originales quedaron vivos
-- en el ciclo abierto aunque esos proyectos ya tienen ganador. Se archivan: la
-- fila se conserva íntegra, pero deja de aparecer en el feed y en los Awards.
ALTER TABLE spotlight_nominations
  ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS spotlight_nominations_cycle_archived_idx
  ON spotlight_nominations (cycle_id, archived);
