-- The non-unique idx_sets_te_idx is strictly dominated by uq_ts_exercise_setindex
-- on the same columns and predicate. Drop it.
DROP INDEX IF EXISTS idx_sets_te_idx;
