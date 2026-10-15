-- ============================================================================
-- Sincronizar departamentos ↔ áreas de Spotlight · SQL ADITIVO
-- ============================================================================
-- Siguen siendo dos tablas (las áreas tienen director propio, que decide la
-- mención especial, y las nominaciones/boletas/ganadores apuntan a ellas). Lo
-- que se agrega es el VÍNCULO explícito, para no emparejarlas por nombre: hoy
-- el departamento "Unidad de Diseño" y el área "Diseño Gráfico" son el mismo
-- equipo con dos nombres, y un match por texto habría creado un duplicado
-- dejando huérfanas sus nominaciones.
--
-- ON DELETE SET NULL a propósito: borrar un departamento NO debe borrar su área.
-- El área conserva nominaciones, boletas y ganadores históricos; solo se
-- desvincula.
ALTER TABLE spotlight_areas
  ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES departments(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS spotlight_areas_department_uidx
  ON spotlight_areas (department_id) WHERE department_id IS NOT NULL;

-- Emparejado inicial por nombre exacto (sin acentos ni mayúsculas).
UPDATE spotlight_areas a
SET department_id = d.id, updated_at = now()
FROM departments d
WHERE a.department_id IS NULL
  AND lower(trim(a.name)) = lower(trim(d.name));

SELECT a.name AS area, coalesce(d.name,'— SIN VINCULAR —') AS departamento
FROM spotlight_areas a LEFT JOIN departments d ON d.id = a.department_id
ORDER BY (a.department_id IS NOT NULL), a.sort_order;
