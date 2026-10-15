-- Vínculo zip → subcarpeta con su contenido extraído (para reemplazar al subir versión nueva).
ALTER TABLE drive_files ADD COLUMN IF NOT EXISTS zip_expanded_folder_id uuid;
