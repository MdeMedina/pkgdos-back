-- ─────────────────────────────────────────────────────────────────────────────
-- ADITIVO IDEMPOTENTE — Anclaje de carpetas del Drive a Departamentos
-- ─────────────────────────────────────────────────────────────────────────────
-- Tabla join many-to-many: una carpeta puede anclarse a 0..N departamentos.
--
-- SEMÁNTICA DE VISIBILIDAD (compat hacia atrás):
--   • Carpeta SIN filas aquí  → visible para TODOS (comportamiento previo intacto).
--   • Carpeta CON N filas      → visible SOLO para usuarios cuyo department_id esté
--                                en ese conjunto, o para admins (global_role='admin').
--   • La restricción CASCADEA hacia abajo: si un ancestro está oculto para el
--     usuario, todo su subárbol (subcarpetas + archivos) queda oculto, sin importar
--     los anclajes propios de los hijos. (Semántica de "carpeta con candado".)
--   • Los archivos no se anclan directamente: heredan la visibilidad de su carpeta.
--   • El gate de marca (user_brands) sigue aplicándose de forma independiente:
--     ambos gates deben pasar.
--
-- FKs con ON DELETE CASCADE: borrar la carpeta o el departamento limpia el anclaje.
-- Idempotente: se puede reaplicar sin efectos secundarios.

CREATE TABLE IF NOT EXISTS drive_folder_departments (
  folder_id     uuid        NOT NULL,
  department_id uuid        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT drive_folder_departments_pkey
    PRIMARY KEY (folder_id, department_id),
  CONSTRAINT drive_folder_departments_folder_fkey
    FOREIGN KEY (folder_id)     REFERENCES drive_folders(id) ON DELETE CASCADE,
  CONSTRAINT drive_folder_departments_department_fkey
    FOREIGN KEY (department_id) REFERENCES departments(id)   ON DELETE CASCADE
);

-- Índice para resolver rápido "¿qué carpetas ve el departamento D?" y para los
-- borrados por department_id (FK cascade). El PK ya cubre lookups por folder_id.
CREATE INDEX IF NOT EXISTS idx_drive_folder_departments_department
  ON drive_folder_departments (department_id);
