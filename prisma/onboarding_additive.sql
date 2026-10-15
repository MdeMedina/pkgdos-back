-- Aditivo, idempotente. Flag del tour de onboarding (recorrido guiado por pantalla).
-- false = el operador aún no ha visto/terminado el tour → se le muestra en el primer login.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS onboarding_completed boolean NOT NULL DEFAULT false;
