-- Jefe del proyecto: la primera persona nominada. Es quien gira la ruleta si el
-- proyecto gana. Se guarda EXPLÍCITO porque la tabla de participantes no guarda
-- orden, y "el primero" no se podía reconstruir.
-- NULL = nominación anterior a esta regla: conserva el comportamiento viejo
-- (cualquier participante del ganador gira). Así no se afecta septiembre 2026.
ALTER TABLE spotlight_nominations
  ADD COLUMN IF NOT EXISTS lead_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
SELECT count(*) FILTER (WHERE lead_user_id IS NULL) sin_jefe, count(*) total FROM spotlight_nominations;
