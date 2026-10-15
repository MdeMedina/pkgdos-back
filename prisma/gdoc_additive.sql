-- Aditivo, idempotente. Vincula un archivo del Drive de PKGD con su Google Doc de origen
-- para la sincronización programada Google Drive → RAG.
ALTER TABLE drive_files ADD COLUMN IF NOT EXISTS gdoc_id text;
ALTER TABLE drive_files ADD COLUMN IF NOT EXISTS gdoc_modified_time text;
CREATE UNIQUE INDEX IF NOT EXISTS drive_files_gdoc_id_key ON drive_files (gdoc_id) WHERE gdoc_id IS NOT NULL;
