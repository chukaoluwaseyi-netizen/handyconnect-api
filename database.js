const { Pool } = require('pg');
const logger = require('../utils/logger');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function connectDB() {
  try {
    await pool.query('SELECT 1');
    logger.info('PostgreSQL connected');
    await runMigrations();
  } catch (err) {
    logger.error('PostgreSQL connection failed:', err.message);
    throw err;
  }
}

async function runMigrations() {
  logger.info('Running database migrations...');
  await pool.query(`

    -- ── ENUMS ─────────────────────────────────────────────────────────────
    DO $$ BEGIN
      CREATE TYPE user_role AS ENUM ('client', 'handyman', 'admin');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    DO $$ BEGIN
      CREATE TYPE job_status AS ENUM (
        'requested', 'negotiating', 'agreed', 'in_progress',
        'completed', 'cancelled', 'disputed'
      );
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    DO $$ BEGIN
      CREATE TYPE negotiation_status AS ENUM ('open', 'agreed', 'expired', 'cancelled');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    DO $$ BEGIN
      CREATE TYPE quote_status AS ENUM ('pending', 'accepted', 'declined', 'countered', 'expired');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    DO $$ BEGIN
      CREATE TYPE payment_type AS ENUM ('commission', 'tip', 'subscription', 'verification', 'featured', 'withdrawal');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    DO $$ BEGIN
      CREATE TYPE payment_status AS ENUM ('pending', 'completed', 'failed', 'refunded');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    DO $$ BEGIN
      CREATE TYPE subscription_tier AS ENUM ('basic', 'pro', 'elite');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    -- ── USERS ─────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS users (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      role          user_role NOT NULL,
      first_name    VARCHAR(100) NOT NULL,
      last_name     VARCHAR(100) NOT NULL,
      email         VARCHAR(255) UNIQUE NOT NULL,
      phone         VARCHAR(20) UNIQUE NOT NULL,
      password_hash VARCHAR(255),
      profile_photo VARCHAR(500),
      firebase_uid  VARCHAR(128) UNIQUE,
      is_verified   BOOLEAN DEFAULT false,
      is_active     BOOLEAN DEFAULT true,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );

    -- ── HANDYMAN PROFILES ─────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS handyman_profiles (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id             UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      bio                 TEXT,
      service_categories  TEXT[] NOT NULL DEFAULT '{}',
      service_radius_km   INTEGER DEFAULT 20,
      is_online           BOOLEAN DEFAULT false,
      location_lat        DECIMAL(10,8),
      location_lng        DECIMAL(11,8),
      location_updated_at TIMESTAMPTZ,
      rating_avg          DECIMAL(3,2) DEFAULT 0,
      rating_count        INTEGER DEFAULT 0,
      total_jobs          INTEGER DEFAULT 0,
      wallet_balance      DECIMAL(10,2) DEFAULT 0,
      subscription_tier   subscription_tier DEFAULT 'basic',
      subscription_expires_at TIMESTAMPTZ,
      is_background_checked BOOLEAN DEFAULT false,
      is_id_verified      BOOLEAN DEFAULT false,
      is_approved         BOOLEAN DEFAULT false,
      commission_rate     DECIMAL(4,3) DEFAULT 0.15,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    );

    -- ── CLIENT PROFILES ───────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS client_profiles (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id         UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      default_address TEXT,
      stripe_customer_id VARCHAR(100),
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );

    -- ── SERVICE CATEGORIES (market rate data) ─────────────────────────────
    CREATE TABLE IF NOT EXISTS service_categories (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name          VARCHAR(100) UNIQUE NOT NULL,
      slug          VARCHAR(100) UNIQUE NOT NULL,
      icon          VARCHAR(50),
      description   TEXT,
      is_active     BOOLEAN DEFAULT true,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );

    -- ── MARKET RATE RANGES ────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS market_rates (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      category_id     UUID REFERENCES service_categories(id),
      city            VARCHAR(100) NOT NULL,
      min_rate_cad    DECIMAL(8,2) NOT NULL,
      max_rate_cad    DECIMAL(8,2) NOT NULL,
      updated_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(category_id, city)
    );

    -- ── JOBS ──────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS jobs (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id         UUID REFERENCES users(id),
      handyman_id       UUID REFERENCES users(id),
      category_id       UUID REFERENCES service_categories(id),
      status            job_status DEFAULT 'requested',
      description       TEXT NOT NULL,
      photo_urls        TEXT[] DEFAULT '{}',
      client_address    TEXT NOT NULL,
      client_lat        DECIMAL(10,8),
      client_lng        DECIMAL(11,8),
      agreed_price      DECIMAL(10,2),
      commission_rate   DECIMAL(4,3),
      commission_amount DECIMAL(10,2),
      net_earnings      DECIMAL(10,2),
      requested_at      TIMESTAMPTZ DEFAULT NOW(),
      negotiation_started_at TIMESTAMPTZ,
      agreed_at         TIMESTAMPTZ,
      started_at        TIMESTAMPTZ,
      completed_at      TIMESTAMPTZ,
      cancelled_at      TIMESTAMPTZ,
      cancellation_reason TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    );

    -- ── NEGOTIATIONS ──────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS negotiations (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id          UUID UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
      status          negotiation_status DEFAULT 'open',
      expires_at      TIMESTAMPTZ NOT NULL,
      counter_count   INTEGER DEFAULT 0,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );

    -- ── NEGOTIATION MESSAGES ──────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS negotiation_messages (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      negotiation_id  UUID REFERENCES negotiations(id) ON DELETE CASCADE,
      sender_id       UUID REFERENCES users(id),
      message_type    VARCHAR(30) DEFAULT 'text',  -- text | photo | quote_card | counter_offer | system
      content         TEXT,
      photo_url       VARCHAR(500),
      metadata        JSONB,   -- stores quote/counter details
      is_blocked      BOOLEAN DEFAULT false,
      sent_at         TIMESTAMPTZ DEFAULT NOW()
    );

    -- ── QUOTE CARDS ───────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS quote_cards (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      negotiation_id        UUID REFERENCES negotiations(id) ON DELETE CASCADE,
      handyman_id           UUID REFERENCES users(id),
      quoted_price          DECIMAL(10,2) NOT NULL,
      estimated_duration    VARCHAR(100),
      net_earnings_preview  DECIMAL(10,2) NOT NULL,
      commission_rate       DECIMAL(4,3) NOT NULL,
      status                quote_status DEFAULT 'pending',
      counter_count         INTEGER DEFAULT 0,
      created_at            TIMESTAMPTZ DEFAULT NOW(),
      responded_at          TIMESTAMPTZ
    );

    -- ── COUNTER OFFERS ────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS counter_offers (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      quote_id        UUID REFERENCES quote_cards(id) ON DELETE CASCADE,
      client_id       UUID REFERENCES users(id),
      proposed_price  DECIMAL(10,2) NOT NULL,
      status          quote_status DEFAULT 'pending',
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      responded_at    TIMESTAMPTZ
    );

    -- ── RATINGS ───────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS ratings (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id      UUID REFERENCES jobs(id),
      rater_id    UUID REFERENCES users(id),
      ratee_id    UUID REFERENCES users(id),
      score       INTEGER CHECK (score BETWEEN 1 AND 5),
      comment     TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(job_id, rater_id)
    );

    -- ── PAYMENTS ──────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS payments (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id            UUID REFERENCES jobs(id),
      user_id           UUID REFERENCES users(id),
      type              payment_type NOT NULL,
      amount            DECIMAL(10,2) NOT NULL,
      currency          CHAR(3) DEFAULT 'CAD',
      status            payment_status DEFAULT 'pending',
      stripe_payment_id VARCHAR(200),
      metadata          JSONB,
      processed_at      TIMESTAMPTZ,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    );

    -- ── NOTIFICATIONS ─────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS notifications (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
      title       VARCHAR(200) NOT NULL,
      body        TEXT NOT NULL,
      type        VARCHAR(50),
      data        JSONB,
      is_read     BOOLEAN DEFAULT false,
      sent_at     TIMESTAMPTZ DEFAULT NOW()
    );

    -- ── INDEXES ───────────────────────────────────────────────────────────
    CREATE INDEX IF NOT EXISTS idx_handyman_location ON handyman_profiles(location_lat, location_lng);
    CREATE INDEX IF NOT EXISTS idx_handyman_online ON handyman_profiles(is_online, is_approved);
    CREATE INDEX IF NOT EXISTS idx_jobs_client ON jobs(client_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_handyman ON jobs(handyman_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_neg_messages_neg ON negotiation_messages(negotiation_id, sent_at);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);

    -- ── SEED SERVICE CATEGORIES ───────────────────────────────────────────
    INSERT INTO service_categories (name, slug, icon, description) VALUES
      ('Plumbing',             'plumbing',             '🔧', 'Pipe repairs, leak fixes, installations'),
      ('Carpentry',            'carpentry',             '🪚', 'Furniture assembly, woodwork, repairs'),
      ('Cleaning',             'cleaning',              '🧹', 'Residential and commercial cleaning'),
      ('Painting',             'painting',              '🎨', 'Interior and exterior painting'),
      ('Electrical',           'electrical',            '⚡', 'Minor electrical work and installations'),
      ('Interior Decoration',  'interior-decoration',   '🛋', 'Interior styling and decoration'),
      ('Creative Design',      'creative-design',       '✏️', 'Graphic design and visual creative work'),
      ('Party Planning',       'party-planning',        '🎉', 'Event and party planning coordination'),
      ('Landscaping',          'landscaping',           '🌿', 'Garden maintenance and landscaping')
    ON CONFLICT (slug) DO NOTHING;

    -- ── SEED MARKET RATES ─────────────────────────────────────────────────
    INSERT INTO market_rates (category_id, city, min_rate_cad, max_rate_cad)
    SELECT sc.id, city.name, rates.min_r, rates.max_r
    FROM service_categories sc
    CROSS JOIN (VALUES ('Toronto'), ('Vancouver'), ('Montreal'), ('Calgary'), ('Ottawa')) AS city(name)
    CROSS JOIN LATERAL (
      SELECT
        CASE sc.slug
          WHEN 'plumbing'            THEN 80
          WHEN 'carpentry'           THEN 70
          WHEN 'cleaning'            THEN 50
          WHEN 'painting'            THEN 80
          WHEN 'electrical'          THEN 90
          WHEN 'interior-decoration' THEN 100
          WHEN 'creative-design'     THEN 60
          WHEN 'party-planning'      THEN 150
          WHEN 'landscaping'         THEN 60
          ELSE 50
        END AS min_r,
        CASE sc.slug
          WHEN 'plumbing'            THEN 250
          WHEN 'carpentry'           THEN 200
          WHEN 'cleaning'            THEN 150
          WHEN 'painting'            THEN 300
          WHEN 'electrical'          THEN 280
          WHEN 'interior-decoration' THEN 400
          WHEN 'creative-design'     THEN 300
          WHEN 'party-planning'      THEN 800
          WHEN 'landscaping'         THEN 200
          ELSE 150
        END AS max_r
    ) AS rates
    ON CONFLICT (category_id, city) DO NOTHING;
  `);
  logger.info('Database migrations complete');
}

module.exports = { pool, connectDB };
