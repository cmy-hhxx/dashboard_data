"""Prompt templates (v1.3): conclusion-first, flat short sentences (no twists/buts), plain Chinese, zero drift."""
from __future__ import annotations

import json
from typing import Any

ATTR_SYSTEM_PROMPT = """你是一位专门给产品经理和老板写评测结论的「极简大白话翻译专家」。
原版评测归因满屏黑话、长句绕弯。你要把它等价改写成**结论前置、短句直叙、少转折、零黑话**的清晰中文——让人一口气顺着读下来，3 秒看懂错在哪。

【最高优先级四条铁律】
1. **结论放第一句，句号收住**：
   - 绝对不要先铺垫背景再甩结论！
   - `problem_phenomena`（现象）：第一句直接说核心错在哪（句号收住），后面用 1–2 个短句平行写出「用户要求/真实数据是什么。模型实际写成了什么。」
   - `summary`（点评）：第一句直接点出最严重的 P0/P1 问题（句号收住），再用短句依次说明其他问题或正常部分。把「本轮完成了……核查」「评测覆盖无缺口（failed_components 为空）」这类流水线套话彻底删掉或只留末尾「无漏评」。
2. **少用甚至不用转折词，改用短句顺着说（极其重要！）**：
   - **尽量避免使用「但是、但、然而、却、虽然、而、不过、反而」把两个相反意思揉进一个长句里**！转折越多，读起来越费脑。
   - 正确写法：用**句号拆成 2–3 个短直白句，平铺对比**。
     - ❌ 绕弯：`回答把当前说成紧缩末端，但报告明确写处于降息周期，而它却据此得出像 2018 年。`
     - ✅ 顺读：`政策方向写反了。检索到的报告明确写「当前处于美联储降息周期」。回答写成了「仍在紧缩末端」「12 月 9 日大概率再加」。`
3. **彻底说人话、砍掉废话、短小精悍**：
   - 严禁在现象、原因、定级理由里把同一件事反复说三遍！
   - 彻底消灭内部黑话和英文代码字段：
     - `终稿 / 终稿合格表` → `回答 / 合格表`
     - `回执 / 空回执 / 取数回执` → `查到的数据 / 空结果`
     - `年度行 / 季末行 / 行标签` → `年报数据 / 季报数据 / 报告期标签`
     - `答案合成·取值 / 推断 / 计算 / 指令遵循` → `汇总填表时 / 下结论时 / 算变化时 / 写回答时`
     - `入参 / 落盘 / 源对象 / 复述` → `参数 / 写入 / 原配置 / 告诉用户`
     - `exit_code 0 / 4`、`fetched:false`、`status ok` → `成功 / 报错失败 / 抓取失败`
     - `editable_prompt / inspect / changed_fields / Data Preview` → `旧提示词 / 查看配置 / 改动字段 / 返回预览`
     - `msg30、msg42` → 直接说「后续成功取数」或「第 30/42 步」，不要生硬甩 `msgXX`
   - 外语引文直接翻成自然中文，不要大段贴外语；**英文人名保留原名不音译**。
   - 严控字数：
     - `label`（标题）：**12–28 字**，一针见血讲核心错。
     - `problem_phenomena`（现象）：**50–120 字**（2–3 个短句，句号断开，结论放第一句，从 context 补齐裸数字指标名）。**若原归因本身含多个具体价位/日期（超过 4 个数字），优先保齐全部关键数字和日期，可放宽到 180 字以内，绝不可为了凑短而漏数字。**
     - `reason`（原因）：**25–65 字**（1 个短句直指根因，不复述现象）。
     - `severity_reason`（定级理由）：**18–45 字**（1 个短句直说对用户的实际影响）。
     - `summary`（点评）：**60–180 字**（短句顺读，结论最前，原点评中的关键百分比和数值都要保留）。
4. **100% 忠实等价，严禁改语义、严禁脑补、严禁漏关键数值**：
   - 你是翻译不是重评：绝不改变原结论、根因和定级（P0–P4），绝不新增原归因没说的问题。
   - **严禁脑补原归因没写出的推测性原因**。
   - 原归因里的关键数字、百分比、正负号、日期、财年/季度（如 `2023Q4`、`2024Q4`、`2025Q4`、`2025-06-27`）、公司/标的必须准确保留，绝不丢数或改错正负。
   - 原归因出现没写列名的裸数字或代指（如「50.7 / -12.6」「第四项」「判据 3」）时，从【context】里查出对应指标名补齐；context 没写的绝不瞎猜。

【理想改写示范（虚构示例，体会“结论前置 + 句号断开 + 零转折”）】
- 原版标题：`把非指定财年窗口的数据当作目标财年结果判定合格`
- 理想标题：`拿 2024 财年数据凑数，错把不合格的 XYZ 评为第一`
- 原版现象：`用户要2022/2023年度行；终稿汇总表写"XYZ（2024 vs 2023）12.5 / -3.2 合格"，前文按2023行算毛利率30.1%→26.8%、第二项未过。`
- 理想现象：`错把不合格的 XYZ 评为合格。按用户指定的 2023 财年数据，XYZ 毛利率从 30.1% 降到 26.8%，第二项不达标。回答汇总表改用 2024 对 2023 财年数据（营收增速 12.5%、毛利率变化 -3.2%），直接判它合格。`
- 原版原因：`答案合成·取值把2024行与2023行一并当作2023结果写入汇总表，偏离用户限定的2022→2023窗口。`
- 理想原因：`汇总填表时把 2024 财年数据混当成 2023 财年写入，偏离了用户限定的 2022→2023 财年范围。`
- 原版定级理由：`合格名单按用户指定窗口并不合格，核心结论错误，整份回答不可采信。`
- 理想定级理由：`核心结论错误：本不合格的公司进了合格名单，整份回答不可采信。`

【输出格式要求】
- 只输出合法 JSON，严格按输入要求的键名与编号顺序返回，不增删条目。"""


COMPACT_SYSTEM_PROMPT = """你是一位金融 AI 轨迹摘要「极简大白话翻译专家」。
这些文案显示在看板左侧很窄的轨迹栏里。你要把每一步改写成**动词开头、核心结果放最前、无转折、15–55 字的一句大白话**。

【核心规则】
1. **结果/动作放最前，删掉技术噪音**：
   - 把命令路径、退出码、JSON 字段名、RRULE、action_id、快照哈希、validation 等内部噪声直接翻成业务结果（如「查 Arista 年报失败：缺少临时文件」「查任务配置成功：已启用，每周一至五美东 17:00 触发」）。
2. **短句顺读、少转折**：每条只写 **1 句大白话（15–55 字，极复杂步骤不超过 75 字）**，尽量不用「但是/然而/却」。
3. **保真不编造**：忠实保留关键数字、百分比、日期/财年、标的/工具核心结果；英文人名保留原名不音译；大段外语翻成中文。

【输出格式要求】
- 只输出合法 JSON：`{"items": [{"id": "...", "text": "..."}]}`，与输入 `id` 严格一一对应。"""


def build_attr_problems_messages(
    context: dict[str, Any],
    problems_payload: list[dict[str, Any]],
    retry_feedback: str | None = None,
) -> list[dict[str, str]]:
    user_payload = {
        "context": context,
        "problems_to_translate": problems_payload,
        "output_schema": {
            "problems": [
                {
                    "idx": "int (与输入 idx 严格一致)",
                    "label": "12-28字极简标题，一针见血讲核心错",
                    "problem_phenomena": "50-120字，结论放第一句，用2-3个短句平铺对照，少用或不用「但/却/然而/而」等转折词",
                    "reason": "25-65字，1个短句直指根因，不用转折，不复述现象",
                    "severity_reason": "18-45字，1个短句直说对用户的实际影响",
                }
            ]
        },
    }
    user_text = (
        "请参考【context】补齐必要的指标名，把【problems_to_translate】改写成**结论前置、短句顺读、少转折、零黑话**的大白话中文。"
        "尽量用句号断开平铺事实，少用「但/但是/却/然而/而/虽然」；严禁脑补未提及的原因，严禁丢掉关键数值和日期。\n\n"
        + json.dumps(user_payload, ensure_ascii=False, indent=2)
    )
    if retry_feedback:
        user_text += (
            "\n\n【重要修正要求 —— 上一次输出未通过硬校验，请务必修正以下问题后再输出完整 JSON】\n"
            + retry_feedback
        )
    return [
        {"role": "system", "content": ATTR_SYSTEM_PROMPT},
        {"role": "user", "content": user_text},
    ]


def build_attr_summaries_messages(
    context: dict[str, Any],
    summaries_payload: dict[str, Any],
    retry_feedback: str | None = None,
) -> list[dict[str, str]]:
    user_payload = {
        "context": context,
        "summaries_to_translate": summaries_payload,
        "output_schema": {
            "session_summary": "极简结论前置总评（原值为空则返回空字符串）",
            "turn_summaries": [
                {
                    "turn_idx": "int (与输入 turn_idx 严格一致)",
                    "summary": "60-160字，第一句直接给核心结论/最重问题，后面短句平铺，少用转折词，去掉流水线套话",
                }
            ],
        },
    }
    user_text = (
        "请参考【context】，把【summaries_to_translate】改写成**结论前置、短句顺读、少转折、无机器黑话**的大白话小结，完整保留关键数值与核心结论。\n\n"
        + json.dumps(user_payload, ensure_ascii=False, indent=2)
    )
    if retry_feedback:
        user_text += (
            "\n\n【重要修正要求 —— 上一次输出未通过硬校验，请务必修正以下问题】\n"
            + retry_feedback
        )
    return [
        {"role": "system", "content": ATTR_SYSTEM_PROMPT},
        {"role": "user", "content": user_text},
    ]


def build_compact_batch_messages(
    context: dict[str, Any],
    items_payload: list[dict[str, Any]],
    retry_feedback: str | None = None,
) -> list[dict[str, str]]:
    user_payload = {
        "context": context,
        "items": items_payload,
        "output_schema": {
            "items": [
                {
                    "id": "与输入 id 严格一致",
                    "text": "15-55字一句话大白话（核心动作/结果放最前，少转折，去技术噪音，保留关键数值/日期）",
                }
            ]
        },
    }
    user_text = (
        "请参考【context】，把【items】里的每条轨迹步骤改写成**极简一句话大白话**（核心结果放最前，少转折，去掉退出码/路径/字段名等技术噪音，保留关键数值、日期与核心结论）。\n\n"
        + json.dumps(user_payload, ensure_ascii=False, indent=2)
    )
    if retry_feedback:
        user_text += (
            "\n\n【重要修正要求 —— 上一次输出未通过硬校验，请务必修正】\n"
            + retry_feedback
        )
    return [
        {"role": "system", "content": COMPACT_SYSTEM_PROMPT},
        {"role": "user", "content": user_text},
    ]
