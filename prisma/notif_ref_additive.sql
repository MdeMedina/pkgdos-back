-- notifications.ref_id (2026-09-21): referencia opcional al objeto que originó
-- la notificación. Permite retirarla si ese objeto se borra, en vez de dejar un
-- aviso fantasma que lleva a algo inexistente (pasó con los comentarios).
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS ref_id uuid;

CREATE INDEX IF NOT EXISTS idx_notifications_ref ON notifications (ref_id);
