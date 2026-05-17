-- Diet schema: column presence, the kind / consumed_fraction CHECKs, FKs.
TRUNCATE diet_consumption, diet_catering_meals, diet_catering_day,
         diet_products, diet_subscriptions RESTART IDENTITY CASCADE;

INSERT INTO diet_subscriptions (delivery_diet_id, diet_id, user_diet_name, plan_kcal)
  VALUES (2070357, 3, 'Domino', 2000);
INSERT INTO diet_products (simple_product_id, name, kcal, protein_g, carb_g, fat_g)
  VALUES (606, 'Owsianka', 350, 12, 50, 9);
INSERT INTO diet_catering_meals
  (delivery_item_id, delivery_diet_id, delivery_id, day, meal_slot_key,
   meal_slot_position, simple_product_id, slot_kcal_target, status)
  VALUES (9710456, 2070357, 2125086, DATE '2026-05-18', 'BREAKFAST', 1, 606, 500, 'TO-BE-REALIZED');
INSERT INTO diet_catering_day
  (delivery_diet_id, day, plan_kcal, kcal, protein_g, carb_g, fat_g)
  VALUES (2070357, DATE '2026-05-18', 2000, 1923, 103.7, 217.8, 75.1);

DO $$
DECLARE meal_id_v BIGINT;
BEGIN
  SELECT id INTO meal_id_v FROM diet_catering_meals WHERE delivery_item_id = 9710456;

  -- 1. kind CHECK rejects unknown kinds
  BEGIN
    INSERT INTO diet_consumption (uuid, day, tz, kind, catering_meal_id)
      VALUES ('c-bad-kind', DATE '2026-05-18', 'UTC', 'nibbled', meal_id_v);
    RAISE EXCEPTION 'expected kind CHECK to fail';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 2. partial requires consumed_fraction
  BEGIN
    INSERT INTO diet_consumption (uuid, day, tz, kind, catering_meal_id)
      VALUES ('c-bad-partial', DATE '2026-05-18', 'UTC', 'partial', meal_id_v);
    RAISE EXCEPTION 'expected partial-without-fraction CHECK to fail';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 3. consumed_fraction must be in (0,1]
  BEGIN
    INSERT INTO diet_consumption (uuid, day, tz, kind, catering_meal_id, consumed_fraction)
      VALUES ('c-bad-frac', DATE '2026-05-18', 'UTC', 'partial', meal_id_v, 1.5);
    RAISE EXCEPTION 'expected consumed_fraction CHECK to fail';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 3b. consumed_fraction = 0 is rejected (0 means "ate nothing" = skip; excluded by design)
  BEGIN
    INSERT INTO diet_consumption (uuid, day, tz, kind, catering_meal_id, consumed_fraction)
      VALUES ('c-zero-frac', DATE '2026-05-18', 'UTC', 'partial', meal_id_v, 0);
    RAISE EXCEPTION 'expected consumed_fraction=0 CHECK to fail';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 4. adhoc requires name + kcal
  BEGIN
    INSERT INTO diet_consumption (uuid, day, tz, kind)
      VALUES ('c-bad-adhoc', DATE '2026-05-18', 'UTC', 'adhoc');
    RAISE EXCEPTION 'expected adhoc-missing-fields CHECK to fail';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 5. valid rows of every kind insert cleanly
  INSERT INTO diet_consumption (uuid, day, tz, kind, catering_meal_id) VALUES
    ('c-skip', DATE '2026-05-18', 'UTC', 'skip', meal_id_v);
  INSERT INTO diet_consumption (uuid, day, tz, kind, catering_meal_id, consumed_fraction) VALUES
    ('c-part', DATE '2026-05-18', 'UTC', 'partial', meal_id_v, 0.5);
  INSERT INTO diet_consumption (uuid, day, tz, kind, catering_meal_id, swap_product_id) VALUES
    ('c-swap', DATE '2026-05-18', 'UTC', 'swap', meal_id_v, 606);
  INSERT INTO diet_consumption (uuid, day, tz, kind, name, kcal) VALUES
    ('c-adhoc', DATE '2026-05-18', 'UTC', 'adhoc', 'Banana', 95);
  INSERT INTO diet_consumption (uuid, day, tz, kind, catering_meal_id, notes) VALUES
    ('c-note', DATE '2026-05-18', 'UTC', 'note', meal_id_v, 'tasty');
  INSERT INTO diet_consumption (uuid, day, tz, kind, meal_slot_key, notes) VALUES
    ('c-note-slot', DATE '2026-05-18', 'UTC', 'note', 'LUNCH', 'note via slot only');

  -- 6. GIN index columns exist and accept arrays
  UPDATE diet_products SET categories = ARRAY['VEGAN'], allergens = ARRAY['GLUTEN']
    WHERE simple_product_id = 606;

  RAISE NOTICE 'diet_schema.test.sql OK';
END $$;

TRUNCATE diet_consumption, diet_catering_meals, diet_catering_day,
         diet_products, diet_subscriptions RESTART IDENTITY CASCADE;
