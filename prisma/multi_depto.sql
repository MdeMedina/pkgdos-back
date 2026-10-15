-- Multi-departamento por usuario (2026-09-23). Aditivo e idempotente.
-- `users.department_id` SE CONSERVA como departamento PRINCIPAL: define con qué
-- área se clasifica una propuesta nueva y qué aparece primero en la bandeja.
-- Los departamentos adicionales (y las jefaturas múltiples) viven aquí.
CREATE TABLE IF NOT EXISTS user_departments (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  is_leader     boolean NOT NULL DEFAULT false,
  created_at    timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, department_id)
);
CREATE INDEX IF NOT EXISTS user_departments_dept_idx ON user_departments (department_id, is_leader);
CREATE INDEX IF NOT EXISTS user_departments_user_idx ON user_departments (user_id);

-- Backfill: lo que hoy vive en users pasa a ser la primera fila de cada quien.
INSERT INTO user_departments (user_id, department_id, is_leader)
SELECT u.id, u.department_id, COALESCE(u.is_department_leader, false)
FROM users u
WHERE u.department_id IS NOT NULL
ON CONFLICT (user_id, department_id) DO NOTHING;
