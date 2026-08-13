-- Cambios ADITIVOS para el espejo de Dropbox. Seguro de re-ejecutar (idempotente).
-- NO toca ninguna tabla/columna existente fuera de las de Dropbox.

-- Enum de origen del nodo (LOCAL vs DROPBOX)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DriveSource') THEN
    CREATE TYPE "DriveSource" AS ENUM ('LOCAL', 'DROPBOX');
  END IF;
END
$$;

-- drive_folders: origen + identidad Dropbox
ALTER TABLE "drive_folders" ADD COLUMN IF NOT EXISTS "source" "DriveSource" NOT NULL DEFAULT 'LOCAL';
ALTER TABLE "drive_folders" ADD COLUMN IF NOT EXISTS "dropbox_id" TEXT;
ALTER TABLE "drive_folders" ADD COLUMN IF NOT EXISTS "dropbox_path_lower" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "drive_folders_dropbox_id_key" ON "drive_folders" ("dropbox_id");
CREATE UNIQUE INDEX IF NOT EXISTS "drive_folders_dropbox_path_lower_key" ON "drive_folders" ("dropbox_path_lower");

-- drive_files: origen + identidad/rev de Dropbox
ALTER TABLE "drive_files" ADD COLUMN IF NOT EXISTS "source" "DriveSource" NOT NULL DEFAULT 'LOCAL';
ALTER TABLE "drive_files" ADD COLUMN IF NOT EXISTS "dropbox_id" TEXT;
ALTER TABLE "drive_files" ADD COLUMN IF NOT EXISTS "dropbox_path_lower" TEXT;
ALTER TABLE "drive_files" ADD COLUMN IF NOT EXISTS "dropbox_rev" TEXT;
ALTER TABLE "drive_files" ADD COLUMN IF NOT EXISTS "dropbox_content_hash" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "drive_files_dropbox_id_key" ON "drive_files" ("dropbox_id");

-- Estado de la sincronización (una sola fila: id = 'singleton')
CREATE TABLE IF NOT EXISTS "dropbox_sync_state" (
  "id"             TEXT PRIMARY KEY DEFAULT 'singleton',
  "cursor"         TEXT,
  "root_path"      TEXT NOT NULL,
  "account_id"     TEXT,
  "last_synced_at" TIMESTAMP(3),
  "last_error"     TEXT,
  "updated_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
