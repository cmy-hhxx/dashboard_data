-- Migration 0002: 3 Layered Statistical Materialized Views
-- Supports zero-lock REFRESH MATERIALIZED VIEW CONCURRENTLY via UNIQUE indexes.

-- =============================================================================
-- E. 分层统计汇总视图（3 张，定时分钟级刷新，零口径漂移）
-- =============================================================================

-- 1. stats_daily_overview (biz_day × model × source × is_real × is_lost)
DROP MATERIALIZED VIEW IF EXISTS public.stats_daily_overview;
CREATE MATERIALIZED VIEW public.stats_daily_overview AS
WITH latest_out AS (
    SELECT
        o.output_id,
        o.input_id,
        o.max_severity,
        o.p0_cnt,
        o.p1_cnt,
        o.p2_cnt,
        o.p3_cnt,
        o.p4_cnt,
        o.problem_count,
        o.is_gold,
        o.eval_duration_ms,
        o.eval_cost_usd,
        COALESCE(pc.clustered_cnt, 0) AS clustered_prob_cnt,
        COALESCE(hr.has_hr_attr, FALSE) AS has_hr_attr,
        COALESCE(hr.has_hr_compact, FALSE) AS has_hr_compact
    FROM public.eval_outputs o
    LEFT JOIN (
        SELECT
            output_id,
            COUNT(*) FILTER (WHERE cluster_code IS NOT NULL) AS clustered_cnt
        FROM public.eval_problems
        GROUP BY output_id
    ) pc ON pc.output_id = o.output_id
    LEFT JOIN (
        SELECT
            output_id,
            BOOL_OR(target_kind = 'attribution' AND status = 'done') AS has_hr_attr,
            BOOL_OR(target_kind = 'compact' AND status = 'done') AS has_hr_compact
        FROM public.human_read_overlays
        GROUP BY output_id
    ) hr ON hr.output_id = o.output_id
    WHERE o.is_latest = TRUE
)
SELECT
    i.biz_day,
    i.model,
    COALESCE(i.source, 'prelaunch') AS source,
    COALESCE(u.is_real, FALSE) AS is_real,
    COALESCE(u.is_lost, FALSE) AS is_lost,
    -- 输入总量与去重指标
    COUNT(*)::BIGINT AS total_traces,
    COUNT(*) FILTER (WHERE i.has_input_blob)::BIGINT AS blob_inputs,
    COUNT(DISTINCT NULLIF(i.session_id, ''))::BIGINT AS unique_sessions,
    COUNT(DISTINCT NULLIF(i.user_id, ''))::BIGINT AS unique_users,
    COALESCE(SUM(COALESCE((i.extra->>'dup_count')::INTEGER, 0)), 0)::BIGINT AS dup_count,
    COUNT(*) FILTER (WHERE NOT i.is_multi_turn)::BIGINT AS single_turn_cnt,
    COUNT(*) FILTER (WHERE i.is_multi_turn)::BIGINT AS multi_turn_cnt,
    -- Token 指标
    AVG(i.total_tokens)::DOUBLE PRECISION AS avg_tokens,
    PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY i.total_tokens)
        FILTER (WHERE i.total_tokens IS NOT NULL)::DOUBLE PRECISION AS p50_tokens,
    PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY i.total_tokens)
        FILTER (WHERE i.total_tokens IS NOT NULL)::DOUBLE PRECISION AS p90_tokens,
    PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY i.total_tokens)
        FILTER (WHERE i.total_tokens IS NOT NULL)::DOUBLE PRECISION AS p99_tokens,
    COALESCE(SUM(i.input_tokens), 0)::BIGINT AS sum_input_tokens,
    COALESCE(SUM(i.output_tokens), 0)::BIGINT AS sum_output_tokens,
    COALESCE(SUM(i.total_tokens), 0)::BIGINT AS sum_total_tokens,
    -- Tool 指标
    AVG(i.tool_count)::DOUBLE PRECISION AS avg_tool_count,
    COALESCE(
        COUNT(*) FILTER (WHERE i.tool_count > 0)::DOUBLE PRECISION / NULLIF(COUNT(*), 0),
        0.0
    ) AS tool_call_rate,
    COALESCE(SUM(i.tool_count), 0)::BIGINT AS sum_tool_count,
    -- Latency 分位
    AVG(i.latency_ms)::DOUBLE PRECISION AS avg_latency_ms,
    PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY i.latency_ms)
        FILTER (WHERE i.latency_ms IS NOT NULL)::DOUBLE PRECISION AS p50_latency_ms,
    PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY i.latency_ms)
        FILTER (WHERE i.latency_ms IS NOT NULL)::DOUBLE PRECISION AS p90_latency_ms,
    PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY i.latency_ms)
        FILTER (WHERE i.latency_ms IS NOT NULL)::DOUBLE PRECISION AS p99_latency_ms,
    -- Step 2 评测状态与覆盖率
    COUNT(*) FILTER (WHERE i.eval_status = 'pending')::BIGINT AS pending_cnt,
    COUNT(*) FILTER (WHERE i.eval_status = 'claimed')::BIGINT AS claimed_cnt,
    COUNT(lo.output_id)::BIGINT AS evaluated_cnt,
    COUNT(*) FILTER (WHERE i.eval_status = 'failed')::BIGINT AS failed_cnt,
    COUNT(*) FILTER (WHERE i.eval_status = 'skipped')::BIGINT AS skipped_cnt,
    COALESCE(
        COUNT(lo.output_id)::DOUBLE PRECISION / NULLIF(COUNT(*), 0),
        0.0
    ) AS eval_coverage_rate,
    -- Trace 最高严重度分布（GOLD + P0..P4）
    COUNT(*) FILTER (WHERE lo.max_severity = 'GOLD')::BIGINT AS gold_cnt,
    COUNT(*) FILTER (WHERE lo.max_severity = 'P0')::BIGINT AS max_p0_cnt,
    COUNT(*) FILTER (WHERE lo.max_severity = 'P1')::BIGINT AS max_p1_cnt,
    COUNT(*) FILTER (WHERE lo.max_severity = 'P2')::BIGINT AS max_p2_cnt,
    COUNT(*) FILTER (WHERE lo.max_severity = 'P3')::BIGINT AS max_p3_cnt,
    COUNT(*) FILTER (WHERE lo.max_severity = 'P4')::BIGINT AS max_p4_cnt,
    -- 问题条目级计数
    COALESCE(SUM(lo.problem_count), 0)::BIGINT AS prob_total_cnt,
    COALESCE(SUM(lo.p0_cnt), 0)::BIGINT AS prob_p0_cnt,
    COALESCE(SUM(lo.p1_cnt), 0)::BIGINT AS prob_p1_cnt,
    COALESCE(SUM(lo.p2_cnt), 0)::BIGINT AS prob_p2_cnt,
    COALESCE(SUM(lo.p3_cnt), 0)::BIGINT AS prob_p3_cnt,
    COALESCE(SUM(lo.p4_cnt), 0)::BIGINT AS prob_p4_cnt,
    -- 聚类率、人话率、分类回填率
    COALESCE(SUM(lo.clustered_prob_cnt), 0)::BIGINT AS clustered_prob_cnt,
    COALESCE(
        SUM(lo.clustered_prob_cnt)::DOUBLE PRECISION / NULLIF(SUM(lo.problem_count), 0),
        0.0
    ) AS cluster_rate,
    COUNT(*) FILTER (WHERE lo.has_hr_attr)::BIGINT AS hr_attr_cnt,
    COUNT(*) FILTER (WHERE lo.has_hr_compact)::BIGINT AS hr_compact_cnt,
    COALESCE(
        COUNT(*) FILTER (WHERE lo.has_hr_attr)::DOUBLE PRECISION / NULLIF(COUNT(lo.output_id), 0),
        0.0
    ) AS hr_rate,
    COUNT(*) FILTER (WHERE i.category_status = 'done')::BIGINT AS cat_done_cnt,
    COALESCE(
        COUNT(*) FILTER (WHERE i.category_status = 'done')::DOUBLE PRECISION / NULLIF(COUNT(*), 0),
        0.0
    ) AS cat_backfill_rate,
    -- 评测耗时与成本
    AVG(lo.eval_duration_ms)::DOUBLE PRECISION AS avg_eval_duration_ms,
    COALESCE(SUM(lo.eval_cost_usd), 0.0)::DOUBLE PRECISION AS sum_eval_cost_usd
FROM public.eval_inputs i
LEFT JOIN public.users u ON u.user_id = i.user_id
LEFT JOIN latest_out lo ON lo.input_id = i.input_id
WHERE NOT i.is_deleted
GROUP BY
    i.biz_day,
    i.model,
    COALESCE(i.source, 'prelaunch'),
    COALESCE(u.is_real, FALSE),
    COALESCE(u.is_lost, FALSE)
WITH NO DATA;

CREATE UNIQUE INDEX uq_stats_daily_overview
    ON public.stats_daily_overview (biz_day, model, source, is_real, is_lost);

-- 2. stats_daily_intent (biz_day × model × task_category × subtask_category × taxonomy_version)
DROP MATERIALIZED VIEW IF EXISTS public.stats_daily_intent;
CREATE MATERIALIZED VIEW public.stats_daily_intent AS
SELECT
    i.biz_day,
    i.model,
    COALESCE(i.task_category, '') AS task_category,
    COALESCE(i.subtask_category, '') AS subtask_category,
    COALESCE(i.taxonomy_version, '') AS taxonomy_version,
    COUNT(*)::BIGINT AS input_cnt,
    COUNT(*) FILTER (WHERE i.has_input_blob)::BIGINT AS blob_input_cnt,
    COUNT(o.output_id)::BIGINT AS evaluated_cnt,
    COUNT(*) FILTER (WHERE o.max_severity = 'GOLD')::BIGINT AS gold_cnt,
    COUNT(*) FILTER (WHERE o.max_severity = 'P0')::BIGINT AS max_p0_cnt,
    COUNT(*) FILTER (WHERE o.max_severity = 'P1')::BIGINT AS max_p1_cnt,
    COUNT(*) FILTER (WHERE o.max_severity = 'P2')::BIGINT AS max_p2_cnt,
    COUNT(*) FILTER (WHERE o.max_severity = 'P3')::BIGINT AS max_p3_cnt,
    COUNT(*) FILTER (WHERE o.max_severity = 'P4')::BIGINT AS max_p4_cnt,
    COALESCE(SUM(o.problem_count), 0)::BIGINT AS prob_total_cnt,
    COALESCE(SUM(o.p0_cnt), 0)::BIGINT AS prob_p0_cnt,
    COALESCE(SUM(o.p1_cnt), 0)::BIGINT AS prob_p1_cnt,
    COALESCE(SUM(o.p2_cnt), 0)::BIGINT AS prob_p2_cnt,
    COALESCE(SUM(o.p3_cnt), 0)::BIGINT AS prob_p3_cnt,
    COALESCE(SUM(o.p4_cnt), 0)::BIGINT AS prob_p4_cnt
FROM public.eval_inputs i
LEFT JOIN public.eval_outputs o
    ON o.input_id = i.input_id AND o.is_latest = TRUE
WHERE NOT i.is_deleted
GROUP BY
    i.biz_day,
    i.model,
    COALESCE(i.task_category, ''),
    COALESCE(i.subtask_category, ''),
    COALESCE(i.taxonomy_version, '')
WITH NO DATA;

CREATE UNIQUE INDEX uq_stats_daily_intent
    ON public.stats_daily_intent (biz_day, model, task_category, subtask_category, taxonomy_version);

-- 3. stats_daily_cluster (biz_day × model × l1 × l2 × l3 × l4 × component × severity)
DROP MATERIALIZED VIEW IF EXISTS public.stats_daily_cluster;
CREATE MATERIALIZED VIEW public.stats_daily_cluster AS
SELECT
    p.biz_day,
    p.model,
    COALESCE(p.l1_stage, '') AS l1_stage,
    COALESCE(p.l2_mechanism, '') AS l2_mechanism,
    COALESCE(p.l3_leaf, '') AS l3_leaf,
    COALESCE(p.l4_subleaf, '') AS l4_subleaf,
    COALESCE(p.component_family, p.component, '') AS component,
    COALESCE(p.severity, '') AS severity,
    COUNT(*)::BIGINT AS problem_cnt,
    COUNT(DISTINCT p.input_id)::BIGINT AS unique_traces,
    COUNT(DISTINCT NULLIF(i.session_id, ''))::BIGINT AS unique_sessions
FROM public.eval_problems p
JOIN public.eval_outputs o
    ON o.output_id = p.output_id AND o.is_latest = TRUE
JOIN public.eval_inputs i
    ON i.input_id = p.input_id AND NOT i.is_deleted
GROUP BY
    p.biz_day,
    p.model,
    COALESCE(p.l1_stage, ''),
    COALESCE(p.l2_mechanism, ''),
    COALESCE(p.l3_leaf, ''),
    COALESCE(p.l4_subleaf, ''),
    COALESCE(p.component_family, p.component, ''),
    COALESCE(p.severity, '')
WITH NO DATA;

CREATE UNIQUE INDEX uq_stats_daily_cluster
    ON public.stats_daily_cluster (
        biz_day, model, l1_stage, l2_mechanism, l3_leaf, l4_subleaf, component, severity
    );
