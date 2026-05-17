-- Diet tracker: subscription mirror, product catalog, catering slots, day
-- totals, and the user-owned consumption log. Catering tables are idempotent
-- provider mirrors. Additive/idempotent (CREATE … IF NOT EXISTS) per repo policy.

CREATE TABLE IF NOT EXISTS diet_subscriptions (
  delivery_diet_id   BIGINT PRIMARY KEY,
  diet_id            BIGINT,
  user_diet_name     TEXT,
  plan_kcal          INT,
  first_delivery_day DATE,
  last_delivery_day  DATE,
  status             TEXT,
  raw                JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS diet_products (
  simple_product_id  BIGINT PRIMARY KEY,
  name               TEXT NOT NULL,
  composition        TEXT,
  weight_g           NUMERIC,
  kind               TEXT,
  kcal NUMERIC, kj NUMERIC,
  protein_g NUMERIC, carb_g NUMERIC, fat_g NUMERIC,
  saturated_fat_g NUMERIC, fiber_g NUMERIC, sugar_g NUMERIC, salt_g NUMERIC,
  protein_pct NUMERIC, carb_pct NUMERIC, fat_pct NUMERIC,
  categories         TEXT[] NOT NULL DEFAULT '{}',
  allergens          TEXT[] NOT NULL DEFAULT '{}',
  images             JSONB,
  crc32              TEXT,
  raw                JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS diet_catering_meals (
  id                     BIGSERIAL PRIMARY KEY,
  delivery_item_id       BIGINT NOT NULL UNIQUE,
  delivery_diet_id       BIGINT NOT NULL REFERENCES diet_subscriptions(delivery_diet_id),
  delivery_id            BIGINT NOT NULL,
  day                    DATE NOT NULL,
  diet_variant_meal_id   BIGINT,
  meal_slot_key          TEXT,
  meal_slot_name         TEXT,
  meal_slot_position     SMALLINT,
  simple_product_id      BIGINT REFERENCES diet_products(simple_product_id),
  slot_kcal_target       INT,
  status                 TEXT,
  alternative_product_ids BIGINT[] NOT NULL DEFAULT '{}',
  raw                    JSONB,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at             TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS diet_catering_day (
  delivery_diet_id   BIGINT NOT NULL REFERENCES diet_subscriptions(delivery_diet_id),
  day                DATE NOT NULL,
  plan_kcal          INT,           -- calorific_kcal_offer
  kcal NUMERIC, kj NUMERIC,
  protein_g NUMERIC, carb_g NUMERIC, fat_g NUMERIC,
  saturated_fat_g NUMERIC, fiber_g NUMERIC, sugar_g NUMERIC, salt_g NUMERIC,
  protein_pct NUMERIC, carb_pct NUMERIC, fat_pct NUMERIC,
  raw                JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (delivery_diet_id, day)
);

CREATE TABLE IF NOT EXISTS diet_consumption (
  id                BIGSERIAL PRIMARY KEY,
  uuid              TEXT NOT NULL UNIQUE,
  day               DATE NOT NULL,           -- local date in tz
  tz                TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('skip','partial','swap','adhoc','note')),
  catering_meal_id  BIGINT REFERENCES diet_catering_meals(id),
  meal_slot_key     TEXT,
  consumed_fraction NUMERIC CHECK (consumed_fraction > 0 AND consumed_fraction <= 1),
  swap_product_id   BIGINT REFERENCES diet_products(simple_product_id),
  name              TEXT,
  kcal NUMERIC, protein_g NUMERIC, carb_g NUMERIC, fat_g NUMERIC,
  saturated_fat_g NUMERIC, fiber_g NUMERIC, sugar_g NUMERIC, salt_g NUMERIC,
  weight_g          NUMERIC,
  source            TEXT CHECK (source IN ('label_photo','web_research','estimate')),
  photo_ref         TEXT,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ,
  CONSTRAINT diet_consumption_kind_fields CHECK (
    (kind = 'skip'    AND catering_meal_id IS NOT NULL)
 OR (kind = 'partial' AND catering_meal_id IS NOT NULL AND consumed_fraction IS NOT NULL)
 OR (kind = 'swap'    AND catering_meal_id IS NOT NULL AND swap_product_id IS NOT NULL)
 OR (kind = 'adhoc'   AND name IS NOT NULL AND kcal IS NOT NULL)
 OR (kind = 'note'    AND notes IS NOT NULL
                       AND (catering_meal_id IS NOT NULL OR meal_slot_key IS NOT NULL))
  )
);

CREATE INDEX IF NOT EXISTS idx_diet_catering_meals_diet_day
  ON diet_catering_meals (delivery_diet_id, day);
CREATE INDEX IF NOT EXISTS idx_diet_catering_meals_day
  ON diet_catering_meals (day) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_diet_catering_meals_product
  ON diet_catering_meals (simple_product_id);
CREATE INDEX IF NOT EXISTS idx_diet_catering_day_day
  ON diet_catering_day (day);
CREATE INDEX IF NOT EXISTS idx_diet_consumption_day
  ON diet_consumption (day) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_diet_consumption_catering_meal
  ON diet_consumption (catering_meal_id);
CREATE INDEX IF NOT EXISTS idx_diet_consumption_kind
  ON diet_consumption (kind);
CREATE INDEX IF NOT EXISTS idx_diet_products_categories
  ON diet_products USING GIN (categories);
CREATE INDEX IF NOT EXISTS idx_diet_products_allergens
  ON diet_products USING GIN (allergens);
