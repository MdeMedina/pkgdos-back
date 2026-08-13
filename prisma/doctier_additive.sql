-- Jerarquía Rector/Normal para documentos del Drive. Aditivo e idempotente.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DocTier') THEN
    CREATE TYPE "DocTier" AS ENUM ('RECTOR', 'NORMAL');
  END IF;
END
$$;

ALTER TABLE "drive_files" ADD COLUMN IF NOT EXISTS "doc_tier" "DocTier" NOT NULL DEFAULT 'NORMAL';

-- Índice para cargar rápido los Rectores de una marca (el endpoint del agente los pide siempre).
CREATE INDEX IF NOT EXISTS "drive_files_rector_brand_idx"
  ON "drive_files" ("brand_id") WHERE "doc_tier" = 'RECTOR';
