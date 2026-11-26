-- Fuente de datos rectora: sus fragmentos ganan en la búsqueda del agente (Pregunta Sencilla)
-- y siempre entran sus mejores coincidencias. Para datos que mandan sobre otros (precios, SKU).
ALTER TABLE drive_files ADD COLUMN IF NOT EXISTS fuente_rectora boolean NOT NULL DEFAULT false;
UPDATE drive_files SET fuente_rectora = true WHERE id = '61c5c290-7124-443f-90c2-5132cc5fadcf'; -- Stewardship Master Workbook
