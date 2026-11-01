#!/usr/bin/env python3
"""Generate a rich offline datasets fixture for local dashboard debugging.

The fixture mirrors the production layout (demo_data attribution + compact,
eval_input, cluster_tree, comparison) so ``scan_datasets.py``, ``prepare.py``
and ``prepare_samples.py`` run unchanged against ``EVAL_DATASETS``.

It is regenerated from scratch on every run; nothing here is real evaluation
data.  Dates are relative to today so the freshness chip stays green.
"""
import argparse
import collections
import hashlib
import json
import os
import random
import shutil
from datetime import datetime, timedelta, timezone

TZ = timezone(timedelta(hours=8))
WENCAI_MODELS = ["a_fast", "b_fast", "a_expert", "b_expert"]
AIME_MODELS = ["aime_fast", "aime_expert"]

# Four-level mock taxonomy: task -> subtask -> intent -> answer form.
# Keeping the leaf questions explicit makes the sample page and the cluster
# drilldown refer to the same cases instead of unrelated synthetic data.
WENCAI_BASE_CASES = [
    ("行情与个股", "个股行情", "财报对比", "中等", "对比贵州茅台和五粮液最近三个季度的毛利率与净利率，并解释差异来源。"),
    ("行情与个股", "个股行情", "估值定位", "中等", "结合历史分位与同业估值，判断宁德时代当前估值处于什么位置。"),
    ("行情与个股", "个股行情", "资金流向", "简单", "统计近五个交易日主力资金净流入前十的沪深 300 成分股。"),
    ("行情与个股", "板块轮动", "行业排名", "中等", "列出本周申万一级行业涨跌幅前五和后五，并判断主线是否切换。"),
    ("行情与个股", "板块轮动", "风格切换", "困难", "比较最近一个月大盘成长、大盘价值、小盘成长和小盘价值的相对收益。"),
    ("行情与个股", "板块轮动", "主线识别", "困难", "从涨停梯队、成交额和连板高度判断当前市场主线及持续性。"),
    ("选股筛选", "条件选股", "多因子筛选", "中等", "筛选近 20 日涨幅超过 15% 且换手率低于 8% 的主板股票。"),
    ("选股筛选", "条件选股", "风险排除", "困难", "剔除 ST、商誉占比过高和近一年有监管处罚的消费板块公司。"),
    ("选股筛选", "条件选股", "流动性过滤", "简单", "筛选近 20 日日均成交额超过 5 亿元且振幅低于 6% 的股票。"),
    ("选股筛选", "因子选股", "ROE 筛选", "中等", "用 ROE 连续三年大于 15%、资产负债率低于 50% 的条件筛选消费板块公司。"),
    ("选股筛选", "因子选股", "动量筛选", "中等", "按 20 日动量与 60 日动量排名，筛选两者均位于前 10% 的股票。"),
    ("选股筛选", "因子选股", "估值筛选", "困难", "筛选 PE 分位低于 30%、PEG 小于 1 且盈利预测上调的公司。"),
    ("交易与持仓", "组合调仓", "股债配置", "中等", "有 10 万元模拟资金，按 6:4 配置沪深 300 ETF 和国债 ETF，给出调仓建议。"),
    ("交易与持仓", "组合调仓", "行业再平衡", "困难", "将当前组合的行业偏离控制在 5 个百分点内，并给出再平衡顺序。"),
    ("交易与持仓", "风险控制", "回撤约束", "困难", "在最大回撤不超过 8% 的约束下，调整当前组合的权益仓位。"),
    ("交易与持仓", "风险控制", "集中度约束", "中等", "将单一个股和单一行业权重分别控制在 12% 和 30% 以内。"),
    ("资讯解读", "公告解读", "业绩公告", "简单", "解读宁德时代最新一季报中的营收、毛利率和现金流变化。"),
    ("资讯解读", "公告解读", "资本开支", "困难", "分析宁德时代资本开支变化，并说明其对自由现金流和估值的影响。"),
    ("资讯解读", "研报摘要", "观点对比", "中等", "总结最近一周光伏行业的主要卖方观点，并列出核心分歧。"),
    ("资讯解读", "研报摘要", "盈利预测", "困难", "比较三家券商对白酒板块未来两年盈利预测的假设差异。"),
    ("资讯解读", "政策解读", "行业政策", "中等", "解读近期新能源车产业政策对整车和电池产业链的影响。"),
    ("资讯解读", "政策解读", "宏观政策", "困难", "分析专项债发行节奏对基建投资和周期行业盈利的影响。"),
    ("宏观研究", "宏观数据", "社融与 M2", "困难", "对比最近三个月社会融资规模与 M2 增速，判断信用扩张阶段。"),
    ("宏观研究", "宏观数据", "CPI 与 PPI", "中等", "比较最近六个月 CPI、PPI 与上游资源品价格的联动关系。"),
    ("宏观研究", "经济周期", "库存周期", "复杂", "结合工业企业库存和营收增速，判断当前库存周期位置。"),
    ("宏观研究", "经济周期", "信用周期", "复杂", "从社融结构、企业中长贷和居民信贷判断信用周期拐点。"),
    ("宏观研究", "政策影响", "利率变化", "中等", "分析 LPR 下调对银行净息差和地产链盈利的传导路径。"),
    ("宏观研究", "政策影响", "汇率变化", "困难", "分析人民币汇率波动对出口链、航空和外资持仓的影响。"),
]

AIME_BASE_CASES = [
    ("数学推理", "代数计算", "线性方程", "困难", "A shop sells notebooks at $3 each and pens at $2 each. Maria buys 7 items and spends $18. How many notebooks did she buy?", "商店笔记本 3 美元一本、钢笔 2 美元一支，Maria 买 7 件共花 18 美元，问她买了几本笔记本？"),
    ("数学推理", "代数计算", "比例问题", "中等", "A recipe uses flour and sugar in a 5:2 ratio. If 420 grams are used in total, how much sugar is used?", "配方中面粉与糖的比例为 5:2，总用量 420 克，问糖用了多少克？"),
    ("数学推理", "几何", "三角形", "困难", "A right triangle has legs 9 and 12. Find the radius of its incircle.", "一个直角三角形的直角边为 9 和 12，求其内切圆半径。"),
    ("数学推理", "几何", "圆与切线", "复杂", "Two circles with radii 4 and 9 are externally tangent. Find the length of their common external tangent.", "半径分别为 4 和 9 的两圆外切，求外公切线的长度。"),
    ("数据分析", "统计推断", "均值与中位数", "中等", "A dataset has 12 observations with mean 8. After adding one value the mean becomes 9. What value was added?", "某数据集有 12 个观测值，均值为 8；加入一个数后均值变为 9，问加入的数是多少？"),
    ("数据分析", "统计推断", "方差", "困难", "A set of five numbers has mean 10 and variance 4. If every value is doubled, what are the new mean and variance?", "五个数的均值为 10、方差为 4；若每个数翻倍，新的均值和方差分别是多少？"),
    ("数据分析", "概率", "组合概率", "中等", "Two fair dice are rolled. What is the probability the sum is 8?", "同时投掷两枚公平骰子，点数之和为 8 的概率是多少？"),
    ("数据分析", "概率", "条件概率", "困难", "A bag contains 3 red and 5 blue balls. Two are drawn without replacement; given at least one is red, find the probability both are red.", "袋中有 3 个红球和 5 个蓝球，不放回抽取两个；已知至少一个红球，求两个都是红球的概率。"),
    ("财务分析", "报表核对", "利润表", "中等", "A firm reports revenue 500, cost 320 and tax rate 25%. Compute net income.", "某公司营收 500、成本 320、税率 25%，计算净利润。"),
    ("财务分析", "报表核对", "现金流", "困难", "Operating cash flow is 180, capex is 95 and net income is 130. Compute free cash flow and cash conversion.", "经营现金流 180、资本开支 95、净利润 130，计算自由现金流和现金转换率。"),
    ("财务分析", "比率分析", "盈利能力", "中等", "Gross profit is 240 and revenue is 600. Compute gross margin and explain its main driver.", "毛利 240、营收 600，计算毛利率并解释主要驱动因素。"),
    ("财务分析", "比率分析", "偿债能力", "困难", "Current assets are 420, inventory is 120 and current liabilities are 250. Compute the quick ratio.", "流动资产 420、存货 120、流动负债 250，计算速动比率。"),
    ("逻辑推理", "组合计数", "排列组合", "困难", "How many 4-letter strings over {A,B,C} contain at least one A?", "由 {A,B,C} 组成的 4 位字符串中，至少含一个 A 的有多少个？"),
    ("逻辑推理", "组合计数", "容斥原理", "复杂", "How many integers from 1 to 300 are divisible by 3 or 5 but not by 15?", "1 到 300 中能被 3 或 5 整除但不能被 15 整除的整数有多少个？"),
    ("逻辑推理", "命题推理", "真假条件", "中等", "If all A are B and some B are C, which statements must be true?", "若所有 A 都是 B，且有些 B 是 C，哪些结论必然成立？"),
    ("逻辑推理", "命题推理", "推理链", "困难", "Four people each make one true and one false statement. Determine the consistent assignment.", "四个人各说一句真话和一句假话，判断唯一一致的身份分配。"),
]

ANSWER_TYPES = {
    "wencai": ("结论先行", "证据展开"),
    "aime": ("数值结果", "推导过程"),
}


def build_case_catalog(product):
    base = WENCAI_BASE_CASES if product == "wencai" else AIME_BASE_CASES
    suffixes = {
        ("wencai", "结论先行"): ("请先给出结论，再列出关键数据。", "请先给出结论，再列出关键数据。"),
        ("wencai", "证据展开"): ("请给出可复核的证据链和推导过程。", "请给出可复核的证据链和推导过程。"),
        ("aime", "数值结果"): ("Return the final value explicitly.", "请明确给出最终数值结果。"),
        ("aime", "推导过程"): ("Show every derivation step and justify it.", "请写出完整推导过程并说明依据。"),
    }
    cases = []
    for base_case in base:
        if product == "wencai":
            task, subtask, intent, difficulty, question = base_case
            question_zh = question
        else:
            task, subtask, intent, difficulty, question, question_zh = base_case
        for answer_type in ANSWER_TYPES[product]:
            en_suffix, zh_suffix = suffixes[(product, answer_type)]
            cases.append({
                "task": task,
                "subtask": subtask,
                "intent": intent,
                "answer_type": answer_type,
                "difficulty": difficulty,
                "question": f"{question} {en_suffix}".strip(),
                "question_zh": f"{question_zh} {zh_suffix}".strip(),
            })
    return cases


WENCAI_CASES = build_case_catalog("wencai")
AIME_CASES = build_case_catalog("aime")

PROBLEM_POOL = [
    ("planner", "规划遗漏约束", "规划阶段没有覆盖题目中的第二个限制条件，导致后续取数范围偏宽。"),
    ("finquery", "取数口径错误", "查询使用的时间窗口与题目要求的区间不一致，结果口径发生偏移。"),
    ("web_search", "引用来源不可靠", "引用的网页结果没有标注发布日期，无法核对数据时点。"),
    ("analyze.py", "计算步骤跳步", "中间一步除法直接给出结果，缺少可复核的推导过程。"),
    ("final_answer", "结论未回答问题", "最终回答只复述了数据，没有正面给出题目所求的结论。"),
]

SEVERITY_WEIGHTS = [("P1", 4), ("P2", 3), ("P3", 2), ("P0", 1)]


def write_jsonl(path, records):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        for record in records:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")


def write_json(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)


def usage_for(rng):
    inp = rng.randint(1100, 3200)
    out = rng.randint(320, 980)
    return {
        "input_tokens": inp,
        "output_tokens": out,
        "total_tokens": inp + out,
    }


def pick(values, rng):
    return values[rng.randrange(len(values))]


def problems_for(rng, product, count):
    out = []
    for _ in range(count):
        comp, label, reason = pick(PROBLEM_POOL, rng)
        severity = None
        if product == "aime":
            severity = rng.choices(
                [s for s, _ in SEVERITY_WEIGHTS],
                weights=[w for _, w in SEVERITY_WEIGHTS],
            )[0]
        item = {
            "component": comp,
            "label": label,
            "definition": "评测中定义的可复核问题：原文必须能定位到具体位置。",
            "problem_phenomena": reason,
            "reason": reason,
            "severity_reason": "该环节直接影响最终结论，且可复现。",
            "evidence": [
                {
                    "quote": "根据最近三个季度的财报数据，毛利率同比有所提升。",
                    "position": f"第{rng.randint(1, 4)}轮 · 回答第{rng.randint(1, 5)}段",
                    "component": comp,
                    "reason": "原文在此处给出结论，但未说明取数区间。",
                },
                {
                    "quote": "综合来看，建议关注后续的边际变化。",
                    "position": f"第{rng.randint(1, 4)}轮 · 回答第{rng.randint(1, 5)}段",
                    "component": comp,
                    "reason": "结论表述模糊，无法核对。",
                },
            ],
        }
        if severity:
            item["severity"] = severity
        out.append(item)
    return out


def build_trace(product, model, date, index, case, sid, tid, usage, duration):
    task = case["task"]
    subtask = case["subtask"]
    intent = case["intent"]
    answer_type = case["answer_type"]
    difficulty = case["difficulty"]
    question = case["question"]
    question_zh = case["question_zh"]
    system = (
        "你是问财智能投研助手，必须基于可核验的数据回答问题。"
        if product == "wencai"
        else "You are an AIME evaluation agent. Solve the problem step by step."
    )
    tool = "finquery" if product == "wencai" else "web_search"
    plan = json.dumps(
        [
            {"content": "拆解题目条件并确定数据口径"},
            {"content": "调用工具取数并核对区间"},
            {"content": "计算并给出结论"},
        ],
        ensure_ascii=False,
    )
    if product == "wencai":
        tool_output = {
            "status_msg": "success",
            "row_count": 12,
            "columns": [{"key": "period"}, {"key": "gross_margin"}, {"key": "net_margin"}],
            "datas": [{"period": "2026Q3", "gross_margin": "91.2%", "net_margin": "52.4%"}],
        }
        answer = (
            f"围绕“{intent}”完成{task} / {subtask}分析。"
            "结论建立在最近三个季度的结构化数据与公告原文上，"
            "关键口径已标注，并对异常值做了交叉核验。"
        )
    else:
        tool_output = {
            "items": [
                {
                    "serial_number": 1,
                    "title": "Worked solution for the problem",
                    "url": "https://example.com/aime/solution",
                    "summary": "Translate the word problem into a linear system and solve.",
                }
            ]
        }
        answer = (
            f"Completed the {task} / {subtask} / {intent} problem. "
            f"The response is delivered as {answer_type.lower()} with a verifiable final result."
        )
    messages = [
        {"type": "user_question", "content": question},
        {
            "type": "llm_turn",
            "name": "planner",
            "input_messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": question},
            ],
            "output": plan,
        },
        {
            "type": "tool_call",
            "name": tool,
            "input": {"query": "最近三个季度毛利率" if product == "wencai" else "notebooks pens system"},
            "latency": 320,
        },
        {"type": "tool_result", "name": tool, "output": tool_output, "latency": 320},
        {
            "type": "llm_turn",
            "name": "reasoner",
            "output": "先核对取数口径，再逐步计算，最后回到题目所问。",
        },
        {"type": "final_answer", "content": answer},
    ]
    come_from = ["paper_trading", "screener", "ainvest", "search"][index % 4]
    agent_mode = "fast" if "fast" in model else "expert"
    meta = {
        "trace_id": tid,
        "session_id": sid,
        "question": question,
        "question_zh": question_zh,
        "task": task,
        "subtask": subtask,
        "intent": intent,
        "answer_type": answer_type,
        "cluster_path": [task, subtask, intent, answer_type],
        "difficulty": difficulty,
        "comefrom": come_from,
        "agent_mode": agent_mode,
        "usage": usage,
        "total_tokens": usage["total_tokens"],
        "n_messages": len(messages),
        "tool_count": 1,
        "total_duration_ms": duration,
        "answer_len": len(answer),
    }
    return {
        "trace_id": tid,
        "session_id": sid,
        "meta": meta,
        "messages": messages,
        "_answer": answer,
    }


def build_output(product, model, date, index, case, sid, tid, usage, duration, answer, rng):
    task = case["task"]
    subtask = case["subtask"]
    intent = case["intent"]
    answer_type = case["answer_type"]
    difficulty = case["difficulty"]
    question = case["question"]
    question_zh = case["question_zh"]
    problem_count = rng.choices([0, 1, 2], weights=[2, 5, 3])[0]
    turn_problems = problems_for(rng, product, problem_count)
    session_problems = problems_for(rng, product, 1) if rng.random() < 0.35 else []
    turn_meta = {
        "trace_id": tid,
        "question": question,
        "question_zh": question_zh,
        "task": task,
        "subtask": subtask,
        "intent": intent,
        "answer_type": answer_type,
        "cluster_path": [task, subtask, intent, answer_type],
        "difficulty": difficulty,
        "usage": usage,
        "total_duration_ms": duration,
        "answer_len": len(answer),
        "n_messages": 8,
        "tool_count": 1,
    }
    session_meta = {
        "session_id": sid,
        "trace_id": tid,
        "user_id": f"u-{hashlib.sha1(sid.encode('utf-8')).hexdigest()[:10]}",
        "question": question,
        "question_zh": question_zh,
        "request_time": f"{date}T{8 + (index * 3) % 14:02d}:{index * 7 % 60:02d}:{index * 13 % 60:02d}+08:00",
        "source": "daily",
        "agent_mode": "fast" if "fast" in model else "expert",
        "outcome": "success",
        "difficulty": difficulty,
        "task": task,
        "subtask": subtask,
        "intent": intent,
        "answer_type": answer_type,
        "cluster_path": [task, subtask, intent, answer_type],
        "ok": True,
        "usage": usage,
        "total_tokens_sum": usage["total_tokens"],
        "total_duration_ms": duration,
        "finish_answer_time_cost": duration,
        "answer_len": len(answer),
        "n_messages": 8,
        "tool_count": 1,
    }
    attribution = {
        "session_meta": session_meta,
        "session_summary": (
            f"会话共 1 轮，归属 {task} / {subtask} / {intent} / {answer_type}。"
            + ("模型结论基本可复核，但部分证据定位仍不够精确。" if problem_count else "模型结论完整，关键数据均可在原文中复核。")
        ),
        "session_problem": session_problems,
        "turns": [
            {
                "meta": turn_meta,
                "summary": f"先识别{intent}所需条件，再完成取数与核验，最后以{answer_type}输出结论。",
                "is_correct": rng.random() > 0.4,
                "correct_reason": "关键口径一致，结论方向正确，证据可回到原文。",
                "problem": turn_problems,
            }
        ],
    }
    compact = {
        "session_meta": {"session_id": sid, "trace_id": tid},
        "trace_meta": [{"trace_id": tid}],
        "session_overview": [
            "1 轮会话 · 1 次工具调用",
            f"任务路径：{task} / {subtask}",
            f"意图：{intent} · 输出：{answer_type}",
        ],
        "turns": [
            {
                "turn_idx": 0,
                "plans": [
                    {"step_idx": 1, "content": "拆解题目条件并确定数据口径"},
                    {"step_idx": 2, "content": "调用工具取数并核对区间"},
                ],
                "reasoning_chain": [
                    {"step_idx": 1, "content": "先确认时间窗口，再比较同比与环比。"}
                ],
                "execution_chain": [
                    {"step_idx": 1, "content": "finquery 返回 12 行结构化数据。"}
                ],
                "reflections": [
                    {"reflection_idx": 1, "reflection_content": "取数区间与题目一致。"}
                ],
                "tool_errors": [],
                "components": [
                    {
                        "components_name": "planner",
                        "components_kind": "stage",
                        "components_content": "规划覆盖了题目条件。",
                    }
                ],
                "final_answer": answer,
            }
        ],
    }
    return attribution, compact


CLUSTER_LEVEL_NAMES = ["任务", "子任务", "意图", "答案形态"]


def cluster_id(path):
    digest = hashlib.sha1("|".join(path).encode("utf-8")).hexdigest()[:10]
    return f"cluster-{digest}"


def build_cluster_tree(root_name, sessions_by_path, items_by_path):
    """Build a deterministic four-level tree from leaf case aggregates."""
    session_prefixes = collections.Counter()
    item_prefixes = collections.Counter()
    for path, session_count in sessions_by_path.items():
        item_count = items_by_path.get(path, 0)
        for depth in range(1, len(path) + 1):
            prefix = tuple(path[:depth])
            session_prefixes[prefix] += session_count
            item_prefixes[prefix] += item_count

    children_by_prefix = collections.defaultdict(list)
    for prefix in session_prefixes:
        children_by_prefix[prefix[:-1]].append(prefix)

    def node(prefix):
        children = [
            node(child)
            for child in sorted(
                children_by_prefix.get(prefix, []),
                key=lambda path: (-session_prefixes[path], path[-1]),
            )
        ]
        sessions = sum(sessions_by_path.values()) if not prefix else session_prefixes[prefix]
        items = sum(items_by_path.values()) if not prefix else item_prefixes[prefix]
        return {
            "id": cluster_id(prefix),
            "name": prefix[-1] if prefix else root_name,
            "sessions": int(sessions),
            "count": int(items),
            "level": len(prefix),
            "level_name": CLUSTER_LEVEL_NAMES[len(prefix) - 1] if prefix else "根节点",
            "path": list(prefix),
            **({"children": children} if children else {}),
        }

    return node(())


def write_cluster(datasets, rel_path, root_name, sessions_by_path, items_by_path, now):
    tree = build_cluster_tree(root_name, sessions_by_path, items_by_path)
    write_json(
        f"{datasets}/{rel_path}",
        {
            "meta": {
                "generated_at": now,
                "pipeline_version": "3.0.0-mock",
                "total_sessions": tree["sessions"],
                "total_items": tree["count"],
                "depth": len(CLUSTER_LEVEL_NAMES),
                "level_names": CLUSTER_LEVEL_NAMES,
                "source": "all_models",
            },
            "tree": tree,
        },
    )


def write_clusters(
    datasets,
    wencai_sessions,
    wencai_items,
    aime_sessions,
    aime_items,
):
    now = datetime.now(TZ).isoformat(timespec="seconds")
    write_cluster(
        datasets,
        "0_wencai/eval_output/0_daily_eval_output/a_fast/cluster/cluster_tree.json",
        "问财",
        wencai_sessions,
        wencai_items,
        now,
    )
    write_cluster(
        datasets,
        "1_aime/eval_output/demo_data/aime_fast/cluster/cluster_tree.json",
        "AIME",
        aime_sessions,
        aime_items,
        now,
    )


def write_comparisons(datasets, date, rng):
    for pair, versions in (
        ("a_fast_vs_b_fast", ("a_fast", "b_fast")),
        ("a_expert_vs_b_expert", ("a_expert", "b_expert")),
    ):
        records = []
        for index in range(3):
            winner = versions[index % 2]
            records.append(
                {
                    "status": "decided",
                    "verdicts": {
                        "correctness": {"result": "win", "winner_version": winner},
                        "completeness": {
                            "result": "both_good" if index % 3 else "both_bad",
                        },
                    },
                    "assessments": {
                        versions[0]: {"meets_core": index % 2 == 0},
                        versions[1]: {"meets_core": index % 2 == 1},
                    },
                }
            )
        write_jsonl(
            f"{datasets}/0_wencai/eval_output/0_daily_eval_output/comparison/{pair}/{pair}-{date}_output.jsonl",
            records,
        )


def generate(out, dates, wencai_per_day=24, aime_per_day=16):
    if os.path.isdir(out):
        shutil.rmtree(out)
    datasets = out
    wencai_total = 0
    aime_total = 0
    wencai_case_sessions = collections.Counter()
    wencai_case_items = collections.Counter()
    aime_case_sessions = collections.Counter()
    aime_case_items = collections.Counter()
    for date_index, date in enumerate(dates):
        for model_index, model in enumerate(WENCAI_MODELS):
            rng = random.Random(f"wencai:{model}:{date}")
            inputs, attributions, compacts = [], [], []
            session_count = max(1, wencai_per_day + rng.choice([-2, -1, 0, 0, 1, 2]))
            for index in range(session_count):
                case = WENCAI_CASES[(index * 7 + model_index * 13 + date_index * 5) % len(WENCAI_CASES)]
                sid = f"wencai-{model}-{date}-{index:02d}"
                tid = f"trace-{sid}"
                usage = usage_for(rng)
                duration = rng.randint(4200, 26000)
                trace = build_trace("wencai", model, date, index, case, sid, tid, usage, duration)
                answer = trace.pop("_answer")
                inputs.append(trace)
                attribution, compact = build_output(
                    "wencai", model, date, index, case, sid, tid, usage, duration, answer, rng
                )
                attributions.append(attribution)
                compacts.append(compact)
                path = (case["task"], case["subtask"], case["intent"], case["answer_type"])
                wencai_case_sessions[path] += 1
                wencai_case_items[path] += rng.randint(3, 8)
                wencai_total += 1
            write_jsonl(f"{datasets}/0_wencai/eval_input/{model}/{date}.jsonl", inputs)
            write_jsonl(
                f"{datasets}/0_wencai/eval_output/0_daily_eval_output/{model}/{model}_attribution-{date}.jsonl",
                attributions,
            )
            write_jsonl(
                f"{datasets}/0_wencai/eval_output/0_daily_eval_output/{model}/compact/{model}_compact-{date}.jsonl",
                compacts,
            )
        write_comparisons(datasets, date, random.Random(f"compare:{date}"))

        for model_index, model in enumerate(AIME_MODELS):
            rng = random.Random(f"aime:{model}:{date}")
            inputs, attributions, compacts = [], [], []
            session_count = max(1, aime_per_day + rng.choice([-2, -1, 0, 0, 1, 2]))
            for index in range(session_count):
                case = AIME_CASES[(index * 5 + model_index * 11 + date_index * 3) % len(AIME_CASES)]
                sid = f"aime-{model}-{date}-{index:02d}"
                tid = f"trace-{sid}"
                usage = usage_for(rng)
                duration = rng.randint(3800, 21000)
                trace = build_trace("aime", model, date, index, case, sid, tid, usage, duration)
                answer = trace.pop("_answer")
                inputs.append(trace)
                attribution, compact = build_output(
                    "aime", model, date, index, case, sid, tid, usage, duration, answer, rng
                )
                attributions.append(attribution)
                compacts.append(compact)
                path = (case["task"], case["subtask"], case["intent"], case["answer_type"])
                aime_case_sessions[path] += 1
                aime_case_items[path] += rng.randint(2, 6)
                aime_total += 1
            write_jsonl(
                f"{datasets}/1_aime/eval_input/0_daily_eval_input/{model}/{date}.jsonl", inputs
            )
            write_jsonl(
                f"{datasets}/1_aime/eval_output/demo_data/{model}/{model}_attribution-{date}.jsonl",
                attributions,
            )
            write_jsonl(
                f"{datasets}/1_aime/eval_output/demo_data/{model}/compact/{model}_compact-{date}.jsonl",
                compacts,
            )

    # Clusters are written last so their generated_at is not older than the
    # attribution files they describe (freshness check in prepare.py).
    write_clusters(
        datasets,
        wencai_case_sessions,
        wencai_case_items,
        aime_case_sessions,
        aime_case_items,
    )

    print(
        json.dumps(
            {
                "datasets": datasets,
                "dates": dates,
                "wencai_sessions": wencai_total,
                "aime_sessions": aime_total,
                "wencai_cluster_leaves": len(wencai_case_sessions),
                "aime_cluster_leaves": len(aime_case_sessions),
            },
            ensure_ascii=False,
        )
    )


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    today = datetime.now(TZ).date()
    parser = argparse.ArgumentParser(description="Generate the offline dashboard fixture")
    parser.add_argument("--out", default=os.path.join(here, "datasets"))
    parser.add_argument(
        "--dates",
        default=",".join(
            (today - timedelta(days=n)).isoformat() for n in range(14, 0, -1)
        ),
        help="comma separated YYYY-MM-DD list (default: last 14 days)",
    )
    parser.add_argument("--wencai-per-day", type=int, default=24, help="base sessions per Wencai model per day")
    parser.add_argument("--aime-per-day", type=int, default=16, help="base sessions per AIME model per day")
    args = parser.parse_args()
    dates = sorted(part.strip() for part in args.dates.split(",") if part.strip())
    generate(
        os.path.abspath(os.path.expanduser(args.out)),
        dates,
        max(1, args.wencai_per_day),
        max(1, args.aime_per_day),
    )


if __name__ == "__main__":
    main()
