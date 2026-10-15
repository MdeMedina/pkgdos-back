-- Desempate de Spotlight (oct-26): la ronda extra es solo entre empatadas y se conserva el registro.
ALTER TABLE spotlight_cycles ADD COLUMN IF NOT EXISTS runoff_nomination_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE spotlight_cycles ADD COLUMN IF NOT EXISTS tie_history jsonb NOT NULL DEFAULT '[]';
