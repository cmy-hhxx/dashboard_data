-- Migration 0003: Partial indexes for real-time evaluation & clustering speed telemetry.
-- Supports sub-5ms 48h minute-bucket aggregation in dashboard /speed.json (PG mode).

CREATE INDEX IF NOT EXISTS idx_eval_outputs_evaluated_at
    ON public.eval_outputs (evaluated_at DESC)
    WHERE is_latest AND evaluated_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_eval_problems_clustered_at
    ON public.eval_problems (clustered_at DESC)
    WHERE clustered_at IS NOT NULL;
