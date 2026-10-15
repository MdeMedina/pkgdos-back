-- Rol dentro de cada departamento (incluye secundarios). El del principal sigue
-- viviendo en users.department_role_id; aquí se refleja para tener una sola vista.
ALTER TABLE user_departments ADD COLUMN IF NOT EXISTS department_role_id uuid NULL REFERENCES department_roles(id) ON DELETE SET NULL;
UPDATE user_departments ud SET department_role_id = u.department_role_id
FROM users u WHERE u.id = ud.user_id AND ud.department_id = u.department_id AND ud.department_role_id IS NULL AND u.department_role_id IS NOT NULL;
