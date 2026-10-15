-- ============================================================================
-- Spotlight Awards · Fase 1 — SQL ADITIVO (idempotente, sin db push)
-- ============================================================================

-- La ELECCIÓN del votante, separada de la boleta.
--
-- REGLA DE NEGOCIO (no tocar): esta tabla NUNCA se cruza con
-- spotlight_award_ballots. Aquella sabe QUIÉN votó (para impedir el doble voto)
-- y ésta sabe QUÉ se votó (para poder cambiarlo). Unirlas destruye el anonimato
-- que es la premisa del sistema de votación de Spotlight.
--
-- voter_token = HMAC-SHA256(SPOTLIGHT_VOTE_SECRET, user_id + ':' + award_cycle_id).
-- No se guarda en ningún lado la correspondencia persona→token: se deriva en cada
-- petición desde la sesión. Un volcado de esta tabla es opaco.
CREATE TABLE IF NOT EXISTS spotlight_award_choices (
  award_cycle_id uuid        NOT NULL,
  voter_token    text        NOT NULL,
  area_id        uuid        NOT NULL,
  nomination_id  uuid        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (award_cycle_id, voter_token, area_id)
);

-- Índice para recontar por nominación sin escanear la tabla.
CREATE INDEX IF NOT EXISTS spotlight_award_choices_nom_idx
  ON spotlight_award_choices (award_cycle_id, nomination_id);

-- Confirmación explícita del votante ("Enviar mis votos"). El voto ya cuenta
-- desde que se emite; esto solo registra que la persona dio por cerrada su
-- boleta, para el panel de admin y para dejar de recordárselo.
ALTER TABLE spotlight_award_ballots
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz;

-- Duración del video, en segundos. La captura el reproductor de YouTube que ya
-- corre en el visor (getDuration) la primera vez que alguien lo reproduce: sin
-- API key ni cuota externa. NULL = todavía nadie lo ha abierto.
ALTER TABLE spotlight_nominations
  ADD COLUMN IF NOT EXISTS video_duration_seconds integer;

-- Estado del revelado por área, para destapar ganadores uno a uno en la junta.
ALTER TABLE spotlight_award_winners
  ADD COLUMN IF NOT EXISTS revealed_at timestamptz;

-- Desempate por área: deja constancia de cómo se resolvió, para que un empate
-- resuelto por dirección no se lea como si el conteo hubiera dicho algo que no dijo.
ALTER TABLE spotlight_award_winners
  ADD COLUMN IF NOT EXISTS decided_by text;   -- 'votos' | 'desempate' | 'direccion'

-- Ronda de desempate acotada a un área: mientras esté abierta, esa área acepta
-- votos aunque el ciclo anual ya esté cerrado. Los candidatos son los empatados
-- arriba, que se recalculan; no hace falta guardarlos.
ALTER TABLE spotlight_award_winners
  ADD COLUMN IF NOT EXISTS runoff_open boolean NOT NULL DEFAULT false;
