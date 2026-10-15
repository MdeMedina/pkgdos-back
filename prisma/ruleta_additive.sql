-- PKGD Spotlight · rueda de premios + comentarios en nominaciones (2026-09-21)
-- Aditivo e idempotente. NO usar prisma db push: se refleja a mano en schema.prisma.

-- Interruptor por ciclo. Arranca en false para TODOS los ciclos ya cerrados
-- (decisión: la ruleta aplica solo de aquí en adelante); el cierre de ciclo lo
-- pone en true a partir de ahora.
ALTER TABLE spotlight_cycles
  ADD COLUMN IF NOT EXISTS roulette_enabled boolean NOT NULL DEFAULT false;

-- Catálogo de premios, editable sin deploy.
CREATE TABLE IF NOT EXISTS spotlight_prizes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label       text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Un giro = un premio ya sorteado POR EL SERVIDOR y registrado.
-- prize_label se congela en la fila: si mañana editan el catálogo, el historial
-- de lo que alguien se ganó no se reescribe.
CREATE TABLE IF NOT EXISTS spotlight_prize_spins (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id       uuid NOT NULL REFERENCES spotlight_cycles(id) ON DELETE CASCADE,
  nomination_id  uuid NOT NULL REFERENCES spotlight_nominations(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prize_id       uuid REFERENCES spotlight_prizes(id) ON DELETE SET NULL,
  prize_label    text NOT NULL,
  spin_index     integer NOT NULL,
  created_at     timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- tope duro de 3 giros por persona por ciclo, a nivel base de datos:
  -- dos peticiones simultáneas no pueden colarse.
  CONSTRAINT spotlight_prize_spins_unique UNIQUE (cycle_id, user_id, spin_index),
  CONSTRAINT spotlight_prize_spins_index_range CHECK (spin_index BETWEEN 1 AND 3)
);
CREATE INDEX IF NOT EXISTS spotlight_prize_spins_cycle_idx ON spotlight_prize_spins (cycle_id);
CREATE INDEX IF NOT EXISTS spotlight_prize_spins_user_idx  ON spotlight_prize_spins (user_id);

-- Comentarios dentro de una nominación.
CREATE TABLE IF NOT EXISTS spotlight_comments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nomination_id  uuid NOT NULL REFERENCES spotlight_nominations(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body           text NOT NULL,
  created_at     timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS spotlight_comments_nomination_idx
  ON spotlight_comments (nomination_id, created_at);

-- Semilla del catálogo: los 10 premios del prototipo que pasó Mau.
INSERT INTO spotlight_prizes (label, sort_order)
SELECT v.label, v.ord FROM (VALUES
  ('Tarjetas Amazon',1), ('Cantimploras',2), ('Dulces',3), ('Power Banks',4),
  ('Audífonos',5), ('Masajes',6), ('Gadgets para la oficina',7),
  ('Vale por una comida en la oficina',8), ('Botellas PKGD',9),
  ('Playeras Especiales de PKGD',10)
) AS v(label,ord)
WHERE NOT EXISTS (SELECT 1 FROM spotlight_prizes);
