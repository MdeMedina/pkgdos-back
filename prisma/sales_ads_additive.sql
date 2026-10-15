-- Sales y Ads con permisos separados (antes: can_view_partner_tools para ambas).
-- Quien tenía el permiso combinado conserva acceso a las dos. La columna vieja queda sin uso.
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_view_sales boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_view_ads   boolean NOT NULL DEFAULT false;
UPDATE users SET can_view_sales = true, can_view_ads = true WHERE can_view_partner_tools AND NOT can_view_sales AND NOT can_view_ads;
