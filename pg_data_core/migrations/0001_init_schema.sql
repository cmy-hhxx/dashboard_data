-- Migration 0001: AIME Evaluation Core Schema (18 Base Tables)
-- Target: PostgreSQL 16 + pg_trgm
-- Note: Migration metadata lives in schema `meta` so `public` contains exactly
-- the 18 canonical base tables + 3 layered materialized views.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE SCHEMA IF NOT EXISTS meta;

CREATE TABLE IF NOT EXISTS meta.schema_migrations (
    version TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS meta.runtime_kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- A. 公共底座与物理存储（3 张表）
-- =============================================================================

-- 1. pack_files: 全盘多帧 .jsonl.zst 不可变分包账本
CREATE TABLE IF NOT EXISTS public.pack_files (
    file_id BIGSERIAL PRIMARY KEY,
    rel_path TEXT NOT NULL UNIQUE,
    domain TEXT NOT NULL CHECK (domain IN ('daily', 'ab', 'ref')),
    kind TEXT NOT NULL CHECK (kind IN ('input', 'attribution', 'compact', 'human_read', 'answer_only', 'reference')),
    model TEXT,
    biz_day DATE,
    part_no INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'sealed', 'compacting', 'retired')),
    committed_bytes BIGINT NOT NULL DEFAULT 0 CHECK (committed_bytes >= 0),
    uncompressed_bytes BIGINT NOT NULL DEFAULT 0 CHECK (uncompressed_bytes >= 0),
    record_count INTEGER NOT NULL DEFAULT 0 CHECK (record_count >= 0),
    session_count INTEGER NOT NULL DEFAULT 0 CHECK (session_count >= 0),
    sha256 TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    extra JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_pack_files_lookup
    ON public.pack_files (domain, kind, model, biz_day, part_no);
CREATE INDEX IF NOT EXISTS idx_pack_files_active
    ON public.pack_files (status, updated_at DESC);

-- 2. users: user_rules.json 真实/测试/流失状态 + user_kyc 画像摘要
CREATE TABLE IF NOT EXISTS public.users (
    user_id TEXT PRIMARY KEY,
    user_id_fp TEXT,
    user_type TEXT NOT NULL DEFAULT 'test' CHECK (user_type IN ('real', 'test', 'internal', 'unknown')),
    is_real BOOLEAN NOT NULL DEFAULT FALSE,
    is_lost BOOLEAN NOT NULL DEFAULT FALSE,
    kyc_status TEXT,
    kyc_n_sections INTEGER NOT NULL DEFAULT 0,
    kyc_profile_bytes INTEGER NOT NULL DEFAULT 0,
    kyc_sections TEXT[] NOT NULL DEFAULT '{}',
    kyc_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
    first_day DATE,
    last_day DATE,
    n_traces INTEGER NOT NULL DEFAULT 0,
    models TEXT[] NOT NULL DEFAULT '{}',
    kyc_fetched_at TIMESTAMPTZ,
    kyc_updated_at TIMESTAMPTZ,
    rules_signature TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    extra JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_users_real_lost ON public.users (is_real, is_lost);
CREATE INDEX IF NOT EXISTS idx_users_kyc_status ON public.users (kyc_status);

-- 3. changes: 单调 BIGSERIAL seq + db_epoch，同事务写入，直驱 5003 /changes
CREATE TABLE IF NOT EXISTS public.changes (
    seq BIGSERIAL PRIMARY KEY,
    db_epoch TEXT NOT NULL,
    entity_type TEXT NOT NULL DEFAULT 'trace',
    op TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
    human_only BOOLEAN NOT NULL DEFAULT FALSE,
    input_id BIGINT,
    output_id BIGINT,
    product TEXT NOT NULL DEFAULT 'aime',
    model TEXT NOT NULL,
    app_version TEXT,
    biz_day DATE,
    trace_id TEXT NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    extra JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_changes_epoch_seq ON public.changes (db_epoch, seq);
CREATE INDEX IF NOT EXISTS idx_changes_human_seq ON public.changes (human_only, seq);
CREATE INDEX IF NOT EXISTS idx_changes_trace_key ON public.changes (trace_id, biz_day, app_version, seq DESC);

-- =============================================================================
-- B. 日常评测核心主干（4 张表）
-- =============================================================================

-- 4. eval_inputs: 按 (product, model, trace_id) 唯一去重准入
CREATE TABLE IF NOT EXISTS public.eval_inputs (
    input_id BIGSERIAL PRIMARY KEY,
    product TEXT NOT NULL DEFAULT 'aime',
    model TEXT NOT NULL,
    trace_id TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    user_id TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'prelaunch',
    app_version TEXT,
    runtime_mode TEXT,
    agent_id TEXT,
    batch_id TEXT,
    case_id TEXT,
    request_time TIMESTAMPTZ,
    biz_day DATE NOT NULL,
    turn_index INTEGER NOT NULL DEFAULT 0,
    session_round INTEGER NOT NULL DEFAULT 1,
    is_multi_turn BOOLEAN NOT NULL DEFAULT FALSE,
    question_text TEXT,
    question_norm TEXT,
    question_hash TEXT,
    n_messages INTEGER NOT NULL DEFAULT 0,
    n_observations INTEGER NOT NULL DEFAULT 0,
    total_tokens BIGINT,
    input_tokens BIGINT,
    output_tokens BIGINT,
    cache_read_tokens BIGINT,
    tool_count INTEGER NOT NULL DEFAULT 0,
    latency_ms DOUBLE PRECISION,
    answer_len INTEGER,
    has_visual BOOLEAN NOT NULL DEFAULT FALSE,
    visual_count INTEGER NOT NULL DEFAULT 0,
    -- Step 4 分类回填权威列
    task_category TEXT,
    subtask_category TEXT,
    intent_code TEXT,
    taxonomy_version TEXT,
    category_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (category_status IN ('pending', 'done', 'empty', 'skipped', 'failed')),
    category_updated_at TIMESTAMPTZ,
    -- Step 2 评测状态机与租约（配合 FOR UPDATE SKIP LOCKED）
    eval_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (eval_status IN ('pending', 'claimed', 'evaluated', 'failed', 'skipped')),
    claimed_by TEXT,
    lease_expires_at TIMESTAMPTZ,
    eval_attempts INTEGER NOT NULL DEFAULT 0,
    eval_error TEXT,
    -- 分包偏移指针
    has_input_blob BOOLEAN NOT NULL DEFAULT TRUE,
    input_file_id BIGINT REFERENCES public.pack_files(file_id),
    input_offset BIGINT,
    input_len INTEGER,
    -- 软删除与扩展
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    extra JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT uq_eval_inputs_pmt UNIQUE (product, model, trace_id)
);

CREATE INDEX IF NOT EXISTS idx_eval_inputs_day_model
    ON public.eval_inputs (biz_day, model) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_eval_inputs_session
    ON public.eval_inputs (model, session_id) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_eval_inputs_user
    ON public.eval_inputs (user_id, biz_day) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_eval_inputs_claim
    ON public.eval_inputs (model, eval_status, lease_expires_at, input_id)
    WHERE NOT is_deleted AND eval_status IN ('pending', 'claimed');
CREATE INDEX IF NOT EXISTS idx_eval_inputs_cat_pending
    ON public.eval_inputs (category_status, biz_day)
    WHERE NOT is_deleted AND category_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_eval_inputs_intent
    ON public.eval_inputs (biz_day, model, task_category, subtask_category) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_eval_inputs_pack
    ON public.eval_inputs (input_file_id, input_offset) WHERE input_file_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_eval_inputs_question_trgm
    ON public.eval_inputs USING GIN (question_text gin_trgm_ops);

-- 5. eval_outputs: 每次评测版本一行（is_latest 保留重评历史）
CREATE TABLE IF NOT EXISTS public.eval_outputs (
    output_id BIGSERIAL PRIMARY KEY,
    input_id BIGINT NOT NULL REFERENCES public.eval_inputs(input_id) ON DELETE CASCADE,
    product TEXT NOT NULL DEFAULT 'aime',
    model TEXT NOT NULL,
    trace_id TEXT NOT NULL,
    biz_day DATE NOT NULL,
    evaluator_version TEXT NOT NULL DEFAULT 'legacy',
    judge_model TEXT,
    evaluated_at TIMESTAMPTZ,
    eval_duration_ms DOUBLE PRECISION,
    eval_cost_usd DOUBLE PRECISION,
    is_latest BOOLEAN NOT NULL DEFAULT TRUE,
    max_severity TEXT NOT NULL DEFAULT 'GOLD'
        CHECK (max_severity IN ('GOLD', 'P0', 'P1', 'P2', 'P3', 'P4')),
    p0_cnt INTEGER NOT NULL DEFAULT 0,
    p1_cnt INTEGER NOT NULL DEFAULT 0,
    p2_cnt INTEGER NOT NULL DEFAULT 0,
    p3_cnt INTEGER NOT NULL DEFAULT 0,
    p4_cnt INTEGER NOT NULL DEFAULT 0,
    problem_count INTEGER NOT NULL DEFAULT 0,
    is_gold BOOLEAN NOT NULL DEFAULT TRUE,
    is_correct BOOLEAN,
    analysis_id TEXT,
    summary TEXT,
    session_summary TEXT,
    attr_file_id BIGINT REFERENCES public.pack_files(file_id),
    attr_offset BIGINT,
    attr_len INTEGER,
    compact_file_id BIGINT REFERENCES public.pack_files(file_id),
    compact_offset BIGINT,
    compact_len INTEGER,
    source_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    extra JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_eval_outputs_latest
    ON public.eval_outputs (input_id) WHERE is_latest;
CREATE INDEX IF NOT EXISTS idx_eval_outputs_input
    ON public.eval_outputs (input_id, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_outputs_day_model_latest
    ON public.eval_outputs (biz_day, model, max_severity) WHERE is_latest;
CREATE INDEX IF NOT EXISTS idx_eval_outputs_trace
    ON public.eval_outputs (model, trace_id);
CREATE INDEX IF NOT EXISTS idx_eval_outputs_attr_pack
    ON public.eval_outputs (attr_file_id, attr_offset) WHERE attr_file_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_eval_outputs_compact_pack
    ON public.eval_outputs (compact_file_id, compact_offset) WHERE compact_file_id IS NOT NULL;

-- 6. eval_problems: 1 条归因问题一行 + Step 3 聚类四层绑定
CREATE TABLE IF NOT EXISTS public.eval_problems (
    problem_id BIGSERIAL PRIMARY KEY,
    output_id BIGINT NOT NULL REFERENCES public.eval_outputs(output_id) ON DELETE CASCADE,
    input_id BIGINT NOT NULL REFERENCES public.eval_inputs(input_id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    biz_day DATE NOT NULL,
    trace_id TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'turn' CHECK (scope IN ('turn', 'session')),
    turn_index INTEGER NOT NULL DEFAULT 0,
    problem_index INTEGER NOT NULL DEFAULT 0,
    severity TEXT CHECK (severity IN ('P0', 'P1', 'P2', 'P3', 'P4')),
    component TEXT,
    component_family TEXT,
    label TEXT,
    evidence_count INTEGER NOT NULL DEFAULT 0,
    located_count INTEGER NOT NULL DEFAULT 0,
    -- Step 3 聚类绑定
    cluster_tree_id BIGINT,
    cluster_version TEXT,
    cluster_code TEXT,
    l1_stage TEXT,
    l2_mechanism TEXT,
    l3_leaf TEXT,
    l4_subleaf TEXT,
    is_edge BOOLEAN NOT NULL DEFAULT FALSE,
    tags TEXT[] NOT NULL DEFAULT '{}',
    clustered_at TIMESTAMPTZ,
    extra JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT uq_eval_problems_pos UNIQUE (output_id, scope, turn_index, problem_index)
);

CREATE INDEX IF NOT EXISTS idx_eval_problems_hierarchy
    ON public.eval_problems (model, l1_stage, l2_mechanism, l3_leaf, l4_subleaf);
CREATE INDEX IF NOT EXISTS idx_eval_problems_code_day
    ON public.eval_problems (model, cluster_code, biz_day);
CREATE INDEX IF NOT EXISTS idx_eval_problems_unclustered
    ON public.eval_problems (model, problem_id) WHERE cluster_code IS NULL;
CREATE INDEX IF NOT EXISTS idx_eval_problems_input
    ON public.eval_problems (input_id);
CREATE INDEX IF NOT EXISTS idx_eval_problems_day_sev
    ON public.eval_problems (biz_day, model, severity);

-- 7. human_read_overlays: 外部人话翻译状态与增量译文分包偏移（支持 attribution + compact）
CREATE TABLE IF NOT EXISTS public.human_read_overlays (
    overlay_id BIGSERIAL PRIMARY KEY,
    output_id BIGINT NOT NULL REFERENCES public.eval_outputs(output_id) ON DELETE CASCADE,
    input_id BIGINT NOT NULL REFERENCES public.eval_inputs(input_id) ON DELETE CASCADE,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('attribution', 'compact')),
    status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('pending', 'done', 'failed', 'stale')),
    prompt_version TEXT,
    translator_model TEXT,
    source_hash TEXT,
    hr_hash TEXT,
    hr_labels TEXT[],
    hr_file_id BIGINT REFERENCES public.pack_files(file_id),
    hr_offset BIGINT,
    hr_len INTEGER,
    translated_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    extra JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT uq_human_read_output_kind UNIQUE (output_id, target_kind)
);

CREATE INDEX IF NOT EXISTS idx_hr_overlays_input ON public.human_read_overlays (input_id, target_kind);
CREATE INDEX IF NOT EXISTS idx_hr_overlays_status ON public.human_read_overlays (status, target_kind, updated_at);
CREATE INDEX IF NOT EXISTS idx_hr_overlays_pack
    ON public.human_read_overlays (hr_file_id, hr_offset) WHERE hr_file_id IS NOT NULL;

-- =============================================================================
-- C. 聚类树、Bench 与标准答案库（5 张表）
-- =============================================================================

-- 8. cluster_trees: 每模型聚类树发布版本与校验结果
CREATE TABLE IF NOT EXISTS public.cluster_trees (
    tree_id BIGSERIAL PRIMARY KEY,
    product TEXT NOT NULL DEFAULT 'aime',
    model TEXT NOT NULL,
    version TEXT NOT NULL,
    release_tag TEXT NOT NULL,
    taxonomy_desc TEXT,
    is_current BOOLEAN NOT NULL DEFAULT FALSE,
    total_items INTEGER NOT NULL DEFAULT 0,
    total_traces INTEGER NOT NULL DEFAULT 0,
    total_sessions INTEGER NOT NULL DEFAULT 0,
    leaf_count INTEGER NOT NULL DEFAULT 0,
    verify_errors INTEGER NOT NULL DEFAULT 0,
    verify_mismatch INTEGER NOT NULL DEFAULT 0,
    edge_flagged INTEGER NOT NULL DEFAULT 0,
    data_cutoff TEXT,
    artifact_rel_dir TEXT NOT NULL,
    generated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    extra JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT uq_cluster_trees_tag UNIQUE (product, model, release_tag)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cluster_trees_current
    ON public.cluster_trees (product, model) WHERE is_current;

-- 9. cluster_nodes: L1→L2→L3→L4 树节点定义、中英文名、legacy_code 与统计计数
CREATE TABLE IF NOT EXISTS public.cluster_nodes (
    node_id BIGSERIAL PRIMARY KEY,
    tree_id BIGINT NOT NULL REFERENCES public.cluster_trees(tree_id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    parent_code TEXT,
    level SMALLINT NOT NULL CHECK (level BETWEEN 0 AND 4),
    sort_order INTEGER NOT NULL DEFAULT 0,
    name_zh TEXT NOT NULL,
    name_en TEXT,
    plain_desc TEXT,
    definition TEXT,
    include_rule TEXT,
    exclude_rule TEXT,
    legacy_code TEXT,
    mechanism TEXT,
    item_count INTEGER NOT NULL DEFAULT 0,
    trace_count INTEGER NOT NULL DEFAULT 0,
    session_count INTEGER NOT NULL DEFAULT 0,
    share DOUBLE PRECISION,
    severity_dist JSONB NOT NULL DEFAULT '{}'::jsonb,
    components TEXT[] NOT NULL DEFAULT '{}',
    tags TEXT[] NOT NULL DEFAULT '{}',
    extra JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT uq_cluster_nodes_code UNIQUE (tree_id, code)
);

CREATE INDEX IF NOT EXISTS idx_cluster_nodes_parent ON public.cluster_nodes (tree_id, parent_code);
CREATE INDEX IF NOT EXISTS idx_cluster_nodes_level ON public.cluster_nodes (tree_id, level, sort_order);

-- 10. bench_sets: 动态主池、tier_500/1000/5000/10000、long 档、冻结快照、人工精选集
CREATE TABLE IF NOT EXISTS public.bench_sets (
    bench_id BIGSERIAL PRIMARY KEY,
    bench_key TEXT NOT NULL UNIQUE,
    product TEXT NOT NULL DEFAULT 'aime',
    model TEXT NOT NULL,
    bench_type TEXT NOT NULL CHECK (bench_type IN ('pool', 'tier', 'long', 'frozen', 'curated', 'ab_snapshot')),
    tier_size INTEGER,
    version TEXT NOT NULL DEFAULT '1.0.0',
    is_frozen BOOLEAN NOT NULL DEFAULT FALSE,
    requested_count INTEGER,
    actual_count INTEGER NOT NULL DEFAULT 0,
    params JSONB NOT NULL DEFAULT '{}'::jsonb,
    stats JSONB NOT NULL DEFAULT '{}'::jsonb,
    built_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    extra JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_bench_sets_model_type ON public.bench_sets (product, model, bench_type, tier_size);

-- 11. bench_items: bench_id × input_id 抽样明细引用（导出时按需流式拼接原文）
CREATE TABLE IF NOT EXISTS public.bench_items (
    bench_item_id BIGSERIAL PRIMARY KEY,
    bench_id BIGINT NOT NULL REFERENCES public.bench_sets(bench_id) ON DELETE CASCADE,
    input_id BIGINT,
    trace_id TEXT NOT NULL,
    session_id TEXT,
    rank INTEGER NOT NULL DEFAULT 0,
    min_tier INTEGER,
    stratum TEXT,
    turn_type TEXT,
    session_round INTEGER,
    severity TEXT,
    dup_question_cnt INTEGER NOT NULL DEFAULT 1,
    question_text TEXT,
    primary_cluster TEXT,
    extra JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT uq_bench_items_trace UNIQUE (bench_id, trace_id)
);

CREATE INDEX IF NOT EXISTS idx_bench_items_rank ON public.bench_items (bench_id, rank);
CREATE INDEX IF NOT EXISTS idx_bench_items_input ON public.bench_items (input_id) WHERE input_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bench_items_tier ON public.bench_items (bench_id, min_tier) WHERE min_tier IS NOT NULL;

-- 12. bench_references: 极简 Bench 标准答案表（暂空预留，后续加客观题/专家标准答案）
CREATE TABLE IF NOT EXISTS public.bench_references (
    ref_id BIGSERIAL PRIMARY KEY,
    input_id BIGINT,
    trace_id TEXT,
    question_hash TEXT,
    ref_type TEXT NOT NULL CHECK (ref_type IN ('objective_answer', 'expert_answer')),
    version TEXT NOT NULL DEFAULT 'v1',
    answer_text TEXT,
    answer_file_id BIGINT REFERENCES public.pack_files(file_id),
    answer_offset BIGINT,
    answer_len INTEGER,
    source TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    extra JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_bench_refs_input ON public.bench_references (input_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_bench_refs_trace ON public.bench_references (trace_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_bench_refs_qhash ON public.bench_references (question_hash) WHERE is_active;

-- =============================================================================
-- D. 多权重 AB 评测（6 张表，无 compare / 无 before-after 写死）
-- =============================================================================

-- 13. ab_rounds: AB 评测轮次总表
CREATE TABLE IF NOT EXISTS public.ab_rounds (
    round_id BIGSERIAL PRIMARY KEY,
    round_key TEXT NOT NULL UNIQUE,
    idempotency_key TEXT UNIQUE,
    product TEXT NOT NULL DEFAULT 'aime',
    model TEXT NOT NULL CHECK (model IN ('aime_expert', 'aime_fast')),
    version_tag TEXT NOT NULL,
    released_at DATE,
    title TEXT,
    bench_id BIGINT REFERENCES public.bench_sets(bench_id),
    tier_size INTEGER,
    requested_count INTEGER,
    actual_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'succeeded',
    stage TEXT NOT NULL DEFAULT 'completed',
    evaluator_version TEXT,
    cluster_version TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    extra JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_ab_rounds_model_rel ON public.ab_rounds (model, released_at DESC);

-- 14. ab_candidates: 登记本轮加载的 1..N 个候选权重及其 description
CREATE TABLE IF NOT EXISTS public.ab_candidates (
    candidate_id BIGSERIAL PRIMARY KEY,
    round_id BIGINT NOT NULL REFERENCES public.ab_rounds(round_id) ON DELETE CASCADE,
    candidate_idx INTEGER NOT NULL CHECK (candidate_idx >= 1),
    candidate_key TEXT NOT NULL,
    description TEXT NOT NULL,
    is_baseline BOOLEAN NOT NULL DEFAULT FALSE,
    source_mode TEXT NOT NULL CHECK (source_mode IN ('live', 'slice', 'answer_only')),
    checkpoint_ref TEXT,
    agent_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    cluster_rel_dir TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    extra JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT uq_ab_candidates_key UNIQUE (round_id, candidate_key),
    CONSTRAINT uq_ab_candidates_idx UNIQUE (round_id, candidate_idx)
);

-- 15. ab_targets: 本轮固定题单（替代 bench/bench.jsonl 与 pairs_index.csv 公共列）
CREATE TABLE IF NOT EXISTS public.ab_targets (
    target_id BIGSERIAL PRIMARY KEY,
    round_id BIGINT NOT NULL REFERENCES public.ab_rounds(round_id) ON DELETE CASCADE,
    eq_index INTEGER NOT NULL,
    case_key TEXT NOT NULL,
    source_input_id BIGINT,
    source_trace_id TEXT,
    ref_id BIGINT REFERENCES public.bench_references(ref_id),
    question_text TEXT,
    turn_type TEXT,
    session_round INTEGER,
    task_category TEXT,
    subtask_category TEXT,
    bench_rank INTEGER,
    bench_severity TEXT,
    extra JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT uq_ab_targets_eq UNIQUE (round_id, eq_index),
    CONSTRAINT uq_ab_targets_key UNIQUE (round_id, case_key)
);

CREATE INDEX IF NOT EXISTS idx_ab_targets_source_trace ON public.ab_targets (round_id, source_trace_id);

-- 16. ab_candidate_cases: 每题 × 每候选权重的执行状态、文件指针与汇总指标
CREATE TABLE IF NOT EXISTS public.ab_candidate_cases (
    case_id BIGSERIAL PRIMARY KEY,
    round_id BIGINT NOT NULL REFERENCES public.ab_rounds(round_id) ON DELETE CASCADE,
    candidate_id BIGINT NOT NULL REFERENCES public.ab_candidates(candidate_id) ON DELETE CASCADE,
    target_id BIGINT NOT NULL REFERENCES public.ab_targets(target_id) ON DELETE CASCADE,
    eq_index INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    eval_bucket TEXT,
    failed_stage TEXT,
    error_code TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    linked_input_id BIGINT,
    linked_output_id BIGINT,
    trace_id TEXT,
    session_id TEXT,
    request_time TIMESTAMPTZ,
    input_file_id BIGINT REFERENCES public.pack_files(file_id),
    input_offset BIGINT,
    input_len INTEGER,
    attr_file_id BIGINT REFERENCES public.pack_files(file_id),
    attr_offset BIGINT,
    attr_len INTEGER,
    compact_file_id BIGINT REFERENCES public.pack_files(file_id),
    compact_offset BIGINT,
    compact_len INTEGER,
    hr_file_id BIGINT REFERENCES public.pack_files(file_id),
    hr_offset BIGINT,
    hr_len INTEGER,
    is_gold BOOLEAN NOT NULL DEFAULT FALSE,
    problem_count INTEGER NOT NULL DEFAULT 0,
    max_severity TEXT CHECK (max_severity IS NULL OR max_severity IN ('GOLD', 'P0', 'P1', 'P2', 'P3', 'P4')),
    p0_cnt INTEGER NOT NULL DEFAULT 0,
    p1_cnt INTEGER NOT NULL DEFAULT 0,
    p2_cnt INTEGER NOT NULL DEFAULT 0,
    p3_cnt INTEGER NOT NULL DEFAULT 0,
    p4_cnt INTEGER NOT NULL DEFAULT 0,
    is_correct BOOLEAN,
    total_tokens BIGINT,
    tool_count INTEGER,
    latency_ms DOUBLE PRECISION,
    change_seq BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    extra JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT uq_ab_cases_rct UNIQUE (round_id, candidate_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_ab_cases_status_eq ON public.ab_candidate_cases (round_id, status, eq_index);
CREATE INDEX IF NOT EXISTS idx_ab_cases_seq ON public.ab_candidate_cases (round_id, change_seq);
CREATE INDEX IF NOT EXISTS idx_ab_cases_cand_eq ON public.ab_candidate_cases (round_id, candidate_id, eq_index);

-- 17. ab_candidate_problems: 毫秒级算出每个候选的严重度/叶子分布与 6×6 迁移矩阵
CREATE TABLE IF NOT EXISTS public.ab_candidate_problems (
    ab_problem_id BIGSERIAL PRIMARY KEY,
    round_id BIGINT NOT NULL REFERENCES public.ab_rounds(round_id) ON DELETE CASCADE,
    case_id BIGINT NOT NULL REFERENCES public.ab_candidate_cases(case_id) ON DELETE CASCADE,
    candidate_id BIGINT NOT NULL REFERENCES public.ab_candidates(candidate_id) ON DELETE CASCADE,
    eq_index INTEGER NOT NULL,
    scope TEXT NOT NULL DEFAULT 'turn' CHECK (scope IN ('turn', 'session')),
    turn_index INTEGER NOT NULL DEFAULT 0,
    problem_index INTEGER NOT NULL DEFAULT 0,
    severity TEXT CHECK (severity IN ('P0', 'P1', 'P2', 'P3', 'P4')),
    component TEXT,
    label TEXT,
    cluster_code TEXT,
    l1_stage TEXT,
    l2_mechanism TEXT,
    l3_leaf TEXT,
    l4_subleaf TEXT,
    is_edge BOOLEAN NOT NULL DEFAULT FALSE,
    extra JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_ab_probs_stage_mech
    ON public.ab_candidate_problems (round_id, candidate_id, l1_stage, l2_mechanism);
CREATE INDEX IF NOT EXISTS idx_ab_probs_cluster_code
    ON public.ab_candidate_problems (round_id, candidate_id, cluster_code);
CREATE INDEX IF NOT EXISTS idx_ab_probs_case
    ON public.ab_candidate_problems (case_id);

-- 18. ab_run_events: AB 流水线事件流与分阶段失败日志
CREATE TABLE IF NOT EXISTS public.ab_run_events (
    event_id BIGSERIAL PRIMARY KEY,
    round_id BIGINT NOT NULL REFERENCES public.ab_rounds(round_id) ON DELETE CASCADE,
    level TEXT NOT NULL DEFAULT 'info',
    stage TEXT NOT NULL,
    candidate_id BIGINT REFERENCES public.ab_candidates(candidate_id) ON DELETE SET NULL,
    case_key TEXT,
    event_type TEXT NOT NULL,
    error_code TEXT,
    message TEXT NOT NULL,
    resolved BOOLEAN NOT NULL DEFAULT FALSE,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ab_events_round ON public.ab_run_events (round_id, event_id DESC);
CREATE INDEX IF NOT EXISTS idx_ab_events_unresolved
    ON public.ab_run_events (round_id, stage) WHERE NOT resolved;
