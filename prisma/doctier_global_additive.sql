-- Agrega el valor GLOBAL al enum DocTier (tier institucional, siempre presente).
-- ADD VALUE es aditivo e idempotente con IF NOT EXISTS (Postgres 12+). Correr FUERA de transacción.
ALTER TYPE "DocTier" ADD VALUE IF NOT EXISTS 'GLOBAL';
