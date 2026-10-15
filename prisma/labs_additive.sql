ALTER TABLE users ADD COLUMN IF NOT EXISTS can_view_labs boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_lab_owner  boolean NOT NULL DEFAULT false;
UPDATE users SET is_lab_owner=true, can_view_labs=true WHERE email='test@pkgd.os';
CREATE TABLE IF NOT EXISTS app_settings (
  id text PRIMARY KEY DEFAULT 'singleton',
  lab_sections jsonb NOT NULL DEFAULT '["/spotlight"]',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_settings (id) VALUES ('singleton') ON CONFLICT DO NOTHING;
