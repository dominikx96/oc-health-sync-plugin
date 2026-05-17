TRUNCATE diet_consumption, diet_catering_meals, diet_catering_day,
         diet_products, diet_subscriptions RESTART IDENTITY CASCADE;
TRUNCATE health_samples RESTART IDENTITY CASCADE;

INSERT INTO diet_subscriptions (delivery_diet_id, plan_kcal) VALUES (1, 2000);
INSERT INTO diet_products (simple_product_id, name, kcal, protein_g, carb_g, fat_g) VALUES
  (10, 'Breakfast', 500, 30, 50, 20),
  (11, 'Lunch',     700, 40, 70, 25),
  (12, 'Granola alt', 300, 8, 40, 10);
INSERT INTO diet_catering_meals
  (delivery_item_id, delivery_diet_id, delivery_id, day, meal_slot_key, meal_slot_position, simple_product_id, status)
VALUES
  (100, 1, 9, DATE '2026-05-18', 'BREAKFAST', 1, 10, 'REALIZED'),
  (101, 1, 9, DATE '2026-05-18', 'LUNCH',     3, 11, 'REALIZED');
INSERT INTO diet_catering_day (delivery_diet_id, day, plan_kcal, kcal, protein_g, carb_g, fat_g)
  VALUES (1, DATE '2026-05-18', 2000, 1200, 70, 120, 45);

-- Deviations: skip lunch, partial breakfast 0.5
INSERT INTO diet_consumption (uuid, day, tz, kind, catering_meal_id, consumed_fraction)
  SELECT 'd-part', DATE '2026-05-18', 'UTC', 'partial', id, 0.5
    FROM diet_catering_meals WHERE delivery_item_id = 100;
INSERT INTO diet_consumption (uuid, day, tz, kind, catering_meal_id)
  SELECT 'd-skip', DATE '2026-05-18', 'UTC', 'skip', id
    FROM diet_catering_meals WHERE delivery_item_id = 101;
-- Ad-hoc snack
INSERT INTO diet_consumption (uuid, day, tz, kind, name, kcal, protein_g)
  VALUES ('d-adhoc', DATE '2026-05-18', 'UTC', 'adhoc', 'Protein bar', 200, 20);
-- Energy out
INSERT INTO health_samples (uuid, sample_kind, data_type, value, unit, start_date, end_date) VALUES
  ('e1','quantity','HKQuantityTypeIdentifierActiveEnergyBurned', 600,'kcal','2026-05-18T10:00:00Z','2026-05-18T10:00:00Z'),
  ('e2','quantity','HKQuantityTypeIdentifierBasalEnergyBurned', 1500,'kcal','2026-05-18T10:00:00Z','2026-05-18T10:00:00Z');

DO $$
DECLARE r RECORD;
BEGIN
  SELECT * INTO r FROM diet_consumed_day('UTC') WHERE day = DATE '2026-05-18';
  -- breakfast 500*0.5=250 ; lunch skipped 0 ; adhoc 200  => 450 kcal
  IF r.consumed_kcal <> 450 THEN
    RAISE EXCEPTION 'consumed_kcal expected 450 got %', r.consumed_kcal;
  END IF;
  IF r.n_skip <> 1 OR r.n_partial <> 1 OR r.n_adhoc <> 1 THEN
    RAISE EXCEPTION 'deviation counts wrong: skip=% partial=% adhoc=%', r.n_skip, r.n_partial, r.n_adhoc;
  END IF;
  IF r.plan_target_kcal <> 2000 OR r.planned_kcal <> 1200 THEN
    RAISE EXCEPTION 'plan numbers wrong: target=% planned=%', r.plan_target_kcal, r.planned_kcal;
  END IF;

  SELECT * INTO r FROM diet_energy_balance('UTC') WHERE day = DATE '2026-05-18';
  IF r.total_out_kcal <> 2100 OR r.intake_kcal <> 450 OR r.net_kcal <> -1650 THEN
    RAISE EXCEPTION 'energy balance wrong: out=% intake=% net=%', r.total_out_kcal, r.intake_kcal, r.net_kcal;
  END IF;

  PERFORM 1 FROM diet_weekly('UTC') WHERE consumed_kcal = 450;
  IF NOT FOUND THEN RAISE EXCEPTION 'diet_weekly did not roll up the day'; END IF;

  -- swap precedence: latest non-deleted deviation wins
  INSERT INTO diet_consumption (uuid, day, tz, kind, catering_meal_id, swap_product_id)
    SELECT 'd-swap', DATE '2026-05-18', 'UTC', 'swap', id, 12
      FROM diet_catering_meals WHERE delivery_item_id = 100;
  -- now breakfast = granola alt (300) instead of 500*0.5; lunch 0; adhoc 200 => 500
  SELECT * INTO r FROM diet_consumed_day('UTC') WHERE day = DATE '2026-05-18';
  IF r.consumed_kcal <> 500 THEN
    RAISE EXCEPTION 'swap precedence wrong: expected 500 got %', r.consumed_kcal;
  END IF;

  -- soft-deleted deviations are ignored
  UPDATE diet_consumption SET deleted_at = now() WHERE uuid IN ('d-swap','d-part');
  SELECT * INTO r FROM diet_consumed_day('UTC') WHERE day = DATE '2026-05-18';
  -- breakfast back to full 500 ; lunch 0 ; adhoc 200 => 700
  IF r.consumed_kcal <> 700 THEN
    RAISE EXCEPTION 'soft-delete handling wrong: expected 700 got %', r.consumed_kcal;
  END IF;

  RAISE NOTICE 'diet_functions.test.sql OK';
END $$;
