-- Fecha real de cada documento (nov-26). En Dropbox la única fecha guardada era la de subida
-- (todo aparecía como 2026); la fecha real suele estar en la ruta o el nombre del archivo.
-- Orden: fecha completa (nombre → ruta, la más cercana al archivo) → mes/año → año
-- → modificación en Google → fecha de subida. La búsqueda del agente penaliza lo viejo.
DROP FUNCTION IF EXISTS pkgd_fecha_de_texto(text);
CREATE OR REPLACE FUNCTION pkgd_fecha_de_texto(t text, nivel int) RETURNS date LANGUAGE plpgsql IMMUTABLE AS $f$
DECLARE s text := lower(coalesce(t, '')); m text[]; y int; mo int; d int; best date; cand date;
  meses CONSTANT text[] := ARRAY['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  meses_es CONSTANT text[] := ARRAY['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
BEGIN
  -- 1) fechas completas: se queda con la ÚLTIMA que aparezca (la más cercana al archivo)
  FOR m IN SELECT regexp_matches(s, '(?<![0-9])(20[0-9]{2})[-_.]([0-9]{1,2})[-_.]([0-9]{1,2})(?![0-9])', 'g') LOOP
    BEGIN cand := make_date(m[1]::int, m[2]::int, m[3]::int); best := cand; EXCEPTION WHEN others THEN END;
  END LOOP;
  FOR m IN SELECT regexp_matches(s, '(?<![0-9])([0-9]{1,2})[-_.]([0-9]{1,2})[-_.](20[0-9]{2}|[0-9]{2})(?![0-9])', 'g') LOOP
    BEGIN y := m[3]::int; IF y < 100 THEN y := 2000 + y; END IF;
      cand := make_date(y, m[1]::int, m[2]::int); best := cand; EXCEPTION WHEN others THEN END;
  END LOOP;
  FOR m IN SELECT regexp_matches(s, '(?<![0-9])([0-9]{1,2})([0-9]{2})(20[0-9]{2})(?![0-9])', 'g') LOOP  -- 10142024, 8192024
    BEGIN cand := make_date(m[3]::int, m[1]::int, m[2]::int); best := cand; EXCEPTION WHEN others THEN END;
  END LOOP;
  IF nivel = 1 THEN RETURN CASE WHEN best <= current_date + 31 THEN best END; END IF;
  best := NULL;
  -- 2) mes + año ("aug 2026", "sept2026", "jan 2025", "oct26") → día 15 de ese mes
  FOR m IN SELECT regexp_matches(s, '(?<![a-z])(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|ene|abr|ago|dic)[a-z]*[ _.-]*(20[0-9]{2}|[0-9]{2})(?![0-9])', 'g') LOOP
    mo := coalesce(array_position(meses, m[1]), array_position(meses_es, m[1]));
    y := m[2]::int; IF y < 100 THEN y := 2000 + y; END IF;
    IF mo IS NOT NULL AND y BETWEEN 2015 AND 2035 THEN best := make_date(y, mo, 15); END IF;
  END LOOP;
  IF nivel = 2 THEN RETURN CASE WHEN best <= current_date + 31 THEN best END; END IF;
  -- 3) solo año ("YTD 2024", "/2025/") → 1 de julio de ese año (el más reciente que aparezca)
  SELECT max(x[1]::int) INTO y FROM regexp_matches(s, '(?<![0-9])(20[0-9]{2})(?![0-9])', 'g') x;
  IF y BETWEEN 2015 AND extract(year FROM current_date)::int THEN RETURN make_date(y, 7, 1); END IF;
  RETURN NULL;
END $f$;

ALTER TABLE drive_files ADD COLUMN IF NOT EXISTS fecha_documento timestamptz;
ALTER TABLE drive_files ADD COLUMN IF NOT EXISTS fecha_origen text;  -- nombre | ruta | google | subida

CREATE OR REPLACE FUNCTION pkgd_drive_files_fecha() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE d date;
BEGIN
  -- precisión primero: fecha completa (nombre, luego ruta) > mes/año > año
  FOR n IN 1..3 LOOP
    d := pkgd_fecha_de_texto(NEW.name, n);
    IF d IS NOT NULL THEN NEW.fecha_documento := d; NEW.fecha_origen := 'nombre'; RETURN NEW; END IF;
    d := pkgd_fecha_de_texto(NEW.full_path, n);
    IF d IS NOT NULL THEN NEW.fecha_documento := d; NEW.fecha_origen := 'ruta'; RETURN NEW; END IF;
  END LOOP;
  IF NULLIF(NEW.gdoc_modified_time, '') IS NOT NULL THEN
    NEW.fecha_documento := NEW.gdoc_modified_time::timestamptz; NEW.fecha_origen := 'google'; RETURN NEW; END IF;
  IF NEW.fecha_origen = 'dropbox' AND NEW.fecha_documento IS NOT NULL THEN RETURN NEW; END IF;  -- modificación real puesta por la sincronización
  NEW.fecha_documento := coalesce(NEW.created_at, now()); NEW.fecha_origen := 'subida';
  RETURN NEW;
END $f$;
DROP TRIGGER IF EXISTS trg_drive_files_fecha ON drive_files;
CREATE TRIGGER trg_drive_files_fecha BEFORE INSERT OR UPDATE OF name, full_path, gdoc_modified_time, fecha_origen ON drive_files
  FOR EACH ROW EXECUTE FUNCTION pkgd_drive_files_fecha();
UPDATE drive_files SET fecha_origen = fecha_origen;  -- recalcula todas
CREATE INDEX IF NOT EXISTS drive_files_fecha_documento_idx ON drive_files (fecha_documento);
