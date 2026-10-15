-- ==================== PKGD Spotlight (aditivo, idempotente) ====================
CREATE TABLE IF NOT EXISTS spotlight_areas (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL UNIQUE,
  director_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  sort_order       int  NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS spotlight_cycles (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  year                          int  NOT NULL,
  month                         int  NOT NULL,
  label                         text NOT NULL DEFAULT '',
  status                        text NOT NULL DEFAULT 'nominating',  -- nominating | voting | closed
  nominations_close_at          timestamptz,
  voting_close_at               timestamptz,
  winner_nomination_id          uuid,
  special_mention_nomination_id uuid,
  is_tie                        boolean NOT NULL DEFAULT false,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (year, month)
);

CREATE TABLE IF NOT EXISTS spotlight_nominations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id            uuid NOT NULL REFERENCES spotlight_cycles(id) ON DELETE CASCADE,
  area_id             uuid REFERENCES spotlight_areas(id) ON DELETE SET NULL,
  title               text NOT NULL,
  description         text,
  youtube_url         text,
  external_links      jsonb NOT NULL DEFAULT '[]',
  created_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  vote_count          int NOT NULL DEFAULT 0,
  director_vote_count int NOT NULL DEFAULT 0,
  award_vote_count    int NOT NULL DEFAULT 0,
  is_historical       boolean NOT NULL DEFAULT false,
  is_month_winner     boolean NOT NULL DEFAULT false,
  is_special_mention  boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_spotlight_nom_cycle ON spotlight_nominations(cycle_id);
CREATE INDEX IF NOT EXISTS idx_spotlight_nom_area  ON spotlight_nominations(area_id);

CREATE TABLE IF NOT EXISTS spotlight_nomination_participants (
  nomination_id uuid NOT NULL REFERENCES spotlight_nominations(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (nomination_id, user_id)
);

CREATE TABLE IF NOT EXISTS spotlight_nomination_images (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nomination_id uuid NOT NULL REFERENCES spotlight_nominations(id) ON DELETE CASCADE,
  url           text NOT NULL,
  sort_order    int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_spotlight_img_nom ON spotlight_nomination_images(nomination_id);

CREATE TABLE IF NOT EXISTS spotlight_reviews (
  cycle_id      uuid NOT NULL REFERENCES spotlight_cycles(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nomination_id uuid NOT NULL REFERENCES spotlight_nominations(id) ON DELETE CASCADE,
  reviewed      boolean NOT NULL DEFAULT false,
  video_percent int NOT NULL DEFAULT 0,
  reviewed_at   timestamptz,
  PRIMARY KEY (user_id, nomination_id)
);
CREATE INDEX IF NOT EXISTS idx_spotlight_review_cycle_user ON spotlight_reviews(cycle_id, user_id);

-- Boleta anónima: registra QUE la persona votó (evita doble voto) sin guardar la elección.
CREATE TABLE IF NOT EXISTS spotlight_ballots (
  cycle_id uuid NOT NULL REFERENCES spotlight_cycles(id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind     text NOT NULL DEFAULT 'popular',  -- popular | special
  voted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cycle_id, user_id, kind)
);

CREATE TABLE IF NOT EXISTS spotlight_award_cycles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  year            int  NOT NULL UNIQUE,
  status          text NOT NULL DEFAULT 'voting',  -- voting | closed
  voting_close_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS spotlight_award_ballots (
  award_cycle_id uuid NOT NULL REFERENCES spotlight_award_cycles(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  area_id        uuid NOT NULL REFERENCES spotlight_areas(id) ON DELETE CASCADE,
  voted_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (award_cycle_id, user_id, area_id)
);

CREATE TABLE IF NOT EXISTS spotlight_award_winners (
  award_cycle_id uuid NOT NULL REFERENCES spotlight_award_cycles(id) ON DELETE CASCADE,
  area_id        uuid NOT NULL REFERENCES spotlight_areas(id) ON DELETE CASCADE,
  nomination_id  uuid REFERENCES spotlight_nominations(id) ON DELETE SET NULL,
  PRIMARY KEY (award_cycle_id, area_id)
);

-- Centro de notificaciones global (reusable por otros módulos).
CREATE TABLE IF NOT EXISTS notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       text NOT NULL DEFAULT 'info',
  title      text NOT NULL,
  body       text,
  link       text,
  read       boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, read, created_at DESC);
