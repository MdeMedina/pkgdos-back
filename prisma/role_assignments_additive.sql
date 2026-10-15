-- Mapa de Roles Fijos y Dinámicos (oct-26): roles por persona con tipo.
CREATE TABLE IF NOT EXISTS user_role_assignments (
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department_role_id uuid NOT NULL REFERENCES department_roles(id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('primary','secondary','dynamic')),
  created_at         timestamptz(6) NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, department_role_id)
);
CREATE INDEX IF NOT EXISTS user_role_assignments_department_role_id_idx ON user_role_assignments(department_role_id);
-- Arranque: el rol principal actual de cada persona como primario; los roles de
-- departamentos secundarios ya cargados, como secundarios.
INSERT INTO user_role_assignments (user_id, department_role_id, kind)
SELECT id, department_role_id, 'primary' FROM users WHERE department_role_id IS NOT NULL
ON CONFLICT DO NOTHING;
INSERT INTO user_role_assignments (user_id, department_role_id, kind)
SELECT ud.user_id, ud.department_role_id, 'secondary' FROM user_departments ud JOIN users u ON u.id = ud.user_id
WHERE ud.department_role_id IS NOT NULL AND ud.department_id IS DISTINCT FROM u.department_id
ON CONFLICT DO NOTHING;
