-- Extensión E: metadatos de sección + nivel de autoridad en los chunks (aditivo, idempotente).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'authority_level') THEN
    CREATE TYPE authority_level AS ENUM ('constitutional', 'governance', 'dynamic');
  END IF;
END$$;

ALTER TABLE file_vector_chunks
  ADD COLUMN IF NOT EXISTS section_label   text,
  ADD COLUMN IF NOT EXISTS section_number  text,
  ADD COLUMN IF NOT EXISTS authority        authority_level,
  ADD COLUMN IF NOT EXISTS section_ordinal  integer,
  ADD COLUMN IF NOT EXISTS ingest_schema_v  smallint DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_fvc_authority_alwayson
  ON file_vector_chunks (version_id, authority)
  WHERE authority IN ('constitutional', 'governance');
CREATE INDEX IF NOT EXISTS idx_fvc_version_authority
  ON file_vector_chunks (version_id, authority);
