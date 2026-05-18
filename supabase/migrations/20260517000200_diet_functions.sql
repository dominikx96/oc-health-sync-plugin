CREATE OR REPLACE FUNCTION diet_consumed_day(p_tz TEXT)
RETURNS TABLE (
  day DATE, delivery_diet_id BIGINT, plan_target_kcal INT,
  planned_kcal NUMERIC, planned_protein_g NUMERIC, planned_carb_g NUMERIC,
  planned_fat_g NUMERIC, planned_fiber_g NUMERIC, planned_sugar_g NUMERIC, planned_salt_g NUMERIC,
  consumed_kcal NUMERIC, consumed_protein_g NUMERIC, consumed_carb_g NUMERIC,
  consumed_fat_g NUMERIC, consumed_saturated_fat_g NUMERIC, consumed_fiber_g NUMERIC,
  consumed_sugar_g NUMERIC, consumed_salt_g NUMERIC,
  n_planned INT, n_skip INT, n_partial INT, n_swap INT, n_adhoc INT
) LANGUAGE sql STABLE AS $$
WITH days AS (
  SELECT DISTINCT day FROM diet_catering_meals WHERE deleted_at IS NULL
  UNION
  SELECT DISTINCT day FROM diet_consumption    WHERE deleted_at IS NULL
),
meal_dev AS (
  SELECT m.id AS meal_id, m.day, m.simple_product_id,
         dv.kind, dv.consumed_fraction, dv.swap_product_id
    FROM diet_catering_meals m
    LEFT JOIN LATERAL (
      SELECT c.kind, c.consumed_fraction, c.swap_product_id
        FROM diet_consumption c
       WHERE c.catering_meal_id = m.id AND c.deleted_at IS NULL
         AND c.kind IN ('skip','partial','swap')
       ORDER BY c.updated_at DESC, c.id DESC LIMIT 1
    ) dv ON true
   WHERE m.deleted_at IS NULL
),
meal_nutr AS (
  SELECT md.day, md.kind,
         CASE md.kind WHEN 'skip' THEN 0
                      WHEN 'partial' THEN COALESCE(md.consumed_fraction,0)
                      ELSE 1 END AS mult,
         CASE WHEN md.kind='swap' THEN sp.kcal            ELSE p.kcal            END AS kcal,
         CASE WHEN md.kind='swap' THEN sp.protein_g       ELSE p.protein_g       END AS protein_g,
         CASE WHEN md.kind='swap' THEN sp.carb_g          ELSE p.carb_g          END AS carb_g,
         CASE WHEN md.kind='swap' THEN sp.fat_g           ELSE p.fat_g           END AS fat_g,
         CASE WHEN md.kind='swap' THEN sp.saturated_fat_g ELSE p.saturated_fat_g END AS saturated_fat_g,
         CASE WHEN md.kind='swap' THEN sp.fiber_g         ELSE p.fiber_g         END AS fiber_g,
         CASE WHEN md.kind='swap' THEN sp.sugar_g         ELSE p.sugar_g         END AS sugar_g,
         CASE WHEN md.kind='swap' THEN sp.salt_g          ELSE p.salt_g          END AS salt_g
    FROM meal_dev md
    LEFT JOIN diet_products p  ON p.simple_product_id  = md.simple_product_id
    LEFT JOIN diet_products sp ON sp.simple_product_id = md.swap_product_id
),
meal_agg AS (
  SELECT day,
         SUM(COALESCE(kcal,0)*mult)            AS kcal,
         SUM(COALESCE(protein_g,0)*mult)       AS protein_g,
         SUM(COALESCE(carb_g,0)*mult)          AS carb_g,
         SUM(COALESCE(fat_g,0)*mult)           AS fat_g,
         SUM(COALESCE(saturated_fat_g,0)*mult) AS saturated_fat_g,
         SUM(COALESCE(fiber_g,0)*mult)         AS fiber_g,
         SUM(COALESCE(sugar_g,0)*mult)         AS sugar_g,
         SUM(COALESCE(salt_g,0)*mult)          AS salt_g,
         COUNT(*)                                  AS n_planned,
         COUNT(*) FILTER (WHERE kind='skip')        AS n_skip,
         COUNT(*) FILTER (WHERE kind='partial')     AS n_partial,
         COUNT(*) FILTER (WHERE kind='swap')        AS n_swap
    FROM meal_nutr GROUP BY day
),
adhoc_agg AS (
  SELECT day,
         SUM(COALESCE(kcal,0))            AS kcal,
         SUM(COALESCE(protein_g,0))       AS protein_g,
         SUM(COALESCE(carb_g,0))          AS carb_g,
         SUM(COALESCE(fat_g,0))           AS fat_g,
         SUM(COALESCE(saturated_fat_g,0)) AS saturated_fat_g,
         SUM(COALESCE(fiber_g,0))         AS fiber_g,
         SUM(COALESCE(sugar_g,0))         AS sugar_g,
         SUM(COALESCE(salt_g,0))          AS salt_g,
         COUNT(*)                          AS n_adhoc
    FROM diet_consumption
   WHERE kind='adhoc' AND deleted_at IS NULL
   GROUP BY day
),
cday AS (
  SELECT day, MIN(delivery_diet_id) AS delivery_diet_id,
         SUM(plan_kcal)::int AS plan_target_kcal,
         SUM(kcal) AS kcal, SUM(protein_g) AS protein_g, SUM(carb_g) AS carb_g,
         SUM(fat_g) AS fat_g, SUM(fiber_g) AS fiber_g, SUM(sugar_g) AS sugar_g, SUM(salt_g) AS salt_g
    FROM diet_catering_day GROUP BY day
)
SELECT d.day, cday.delivery_diet_id, cday.plan_target_kcal,
       cday.kcal, cday.protein_g, cday.carb_g, cday.fat_g, cday.fiber_g, cday.sugar_g, cday.salt_g,
       COALESCE(ma.kcal,0)+COALESCE(aa.kcal,0)                       AS consumed_kcal,
       COALESCE(ma.protein_g,0)+COALESCE(aa.protein_g,0)             AS consumed_protein_g,
       COALESCE(ma.carb_g,0)+COALESCE(aa.carb_g,0)                   AS consumed_carb_g,
       COALESCE(ma.fat_g,0)+COALESCE(aa.fat_g,0)                     AS consumed_fat_g,
       COALESCE(ma.saturated_fat_g,0)+COALESCE(aa.saturated_fat_g,0) AS consumed_saturated_fat_g,
       COALESCE(ma.fiber_g,0)+COALESCE(aa.fiber_g,0)                 AS consumed_fiber_g,
       COALESCE(ma.sugar_g,0)+COALESCE(aa.sugar_g,0)                 AS consumed_sugar_g,
       COALESCE(ma.salt_g,0)+COALESCE(aa.salt_g,0)                   AS consumed_salt_g,
       COALESCE(ma.n_planned,0)::int, COALESCE(ma.n_skip,0)::int,
       COALESCE(ma.n_partial,0)::int, COALESCE(ma.n_swap,0)::int,
       COALESCE(aa.n_adhoc,0)::int
  FROM days d
  LEFT JOIN meal_agg  ma ON ma.day  = d.day
  LEFT JOIN adhoc_agg aa ON aa.day  = d.day
  LEFT JOIN cday         ON cday.day = d.day
 ORDER BY d.day;
$$;

CREATE OR REPLACE FUNCTION diet_weekly(p_tz TEXT)
RETURNS TABLE (
  week_start DATE, days_with_delivery INT,
  plan_target_kcal NUMERIC, planned_kcal NUMERIC, consumed_kcal NUMERIC,
  consumed_protein_g NUMERIC, consumed_carb_g NUMERIC, consumed_fat_g NUMERIC,
  n_skip INT, n_partial INT, n_swap INT, n_adhoc INT
) LANGUAGE sql STABLE AS $$
  SELECT date_trunc('week', day)::date AS week_start,
         COUNT(*) FILTER (WHERE delivery_diet_id IS NOT NULL)::int,
         SUM(plan_target_kcal), SUM(planned_kcal), SUM(consumed_kcal),
         SUM(consumed_protein_g), SUM(consumed_carb_g), SUM(consumed_fat_g),
         SUM(n_skip)::int, SUM(n_partial)::int, SUM(n_swap)::int, SUM(n_adhoc)::int
    FROM diet_consumed_day(p_tz)
   GROUP BY 1 ORDER BY 1;
$$;

CREATE OR REPLACE FUNCTION diet_energy_balance(p_tz TEXT)
RETURNS TABLE (
  day DATE, intake_kcal NUMERIC, active_kcal NUMERIC,
  basal_kcal NUMERIC, total_out_kcal NUMERIC, net_kcal NUMERIC
) LANGUAGE sql STABLE AS $$
  WITH intake AS ( SELECT day, consumed_kcal FROM diet_consumed_day(p_tz) ),
  energy AS (
    SELECT (start_date AT TIME ZONE p_tz)::date AS day,
           SUM(value) FILTER (WHERE data_type='HKQuantityTypeIdentifierActiveEnergyBurned') AS active_kcal,
           SUM(value) FILTER (WHERE data_type='HKQuantityTypeIdentifierBasalEnergyBurned')  AS basal_kcal
      FROM health_samples
     WHERE deleted_at IS NULL
       AND data_type IN ('HKQuantityTypeIdentifierActiveEnergyBurned',
                          'HKQuantityTypeIdentifierBasalEnergyBurned')
     GROUP BY 1
  )
  SELECT COALESCE(i.day, e.day),
         COALESCE(i.consumed_kcal,0),
         COALESCE(e.active_kcal,0),
         COALESCE(e.basal_kcal,0),
         COALESCE(e.active_kcal,0)+COALESCE(e.basal_kcal,0),
         COALESCE(i.consumed_kcal,0)-(COALESCE(e.active_kcal,0)+COALESCE(e.basal_kcal,0))
    FROM intake i FULL OUTER JOIN energy e ON e.day = i.day
   ORDER BY 1;
$$;

GRANT EXECUTE ON FUNCTION diet_consumed_day(TEXT)   TO health_read_role, diet_writer_role;
GRANT EXECUTE ON FUNCTION diet_weekly(TEXT)         TO health_read_role, diet_writer_role;
GRANT EXECUTE ON FUNCTION diet_energy_balance(TEXT) TO health_read_role, diet_writer_role;
