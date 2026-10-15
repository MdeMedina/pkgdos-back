-- Herramientas de partners (Sales y Ads, embebidas en PKGD OS).
-- Permiso por usuario y no lista fija, para que los partners que entren después
-- se activen desde Hive sin tocar código. Aditivo e idempotente.
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_view_partner_tools boolean NOT NULL DEFAULT false;

UPDATE users SET can_view_partner_tools = true, updated_at = now()
WHERE email IN ('shawn@pkgdgroup.com','monica@pkgdgroup.com','jp@pkgdgroup.com',
                'miguel@pkgdgroup.com','roy@pkgdgroup.com','clarissa@pkgdgroup.com');

SELECT full_name, email FROM users WHERE can_view_partner_tools ORDER BY full_name;
