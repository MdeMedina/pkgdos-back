-- Aditivo, idempotente, no destructivo. Añade el flag de "líder de departamento".
-- Un líder puede mover/borrar archivos y carpetas ancladas a su departamento (y su
-- subárbol), excepto /EXTERNAL DOWNLOADS (solo admins). Varios líderes por depto.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_department_leader boolean NOT NULL DEFAULT false;
