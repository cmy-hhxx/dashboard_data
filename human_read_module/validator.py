"""Hard accuracy guardrails for human-readable translations (v1.2).

Layer 1: Structural schema & index integrity (enforced alongside code-level frozen deepcopy).
Layer 2: Critical numeric / percentage / fiscal-period / date preservation check
         (with Chinese unit equivalence like 44062000000.0 <-> 440.62亿 and negative-verb equivalence).
Layer 3: Conciseness & sanity checks (non-empty, not bloated).
"""
from __future__ import annotations

import re
from typing import Any

DATE_RE = re.compile(r"\b(?:19|20)\d{2}[-/]\d{1,2}[-/]\d{1,2}\b")
FISCAL_RE = re.compile(r"\b(?:(?:19|20)\d{2}Q[1-4]|FY\s?(?:19|20)?\d{2}|Q[1-4]\s?(?:19|20)\d{2})\b", re.IGNORECASE)
MSG_INDEX_RE = re.compile(
    r"(?:\b(?:msg|message)\s*|消息\s*)\d+(?:\s*[/,、和与-]\s*(?:(?:msg|message)\s*|消息\s*)?\d+)*",
    re.IGNORECASE,
)
# Match numbers including US thousands (1,000 / 12,345.67) and EU thousands (10.000),
# WITHOUT gluing two list numbers separated by a comma like "20,50".
NUMBER_RE = re.compile(r"(?<![A-Za-z0-9_])([+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?%?|[+-]?\d+(?:\.\d+)?%?)(?![A-Za-z0-9_])")

TRIVIAL_INTS = {"0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"}

CHINESE_DIGITS = {
    "0": "零", "1": "一", "2": "二", "3": "三", "4": "四",
    "5": "五", "6": "六", "7": "七", "8": "八", "9": "九", "10": "十",
}

NEG_VERBS = ("跌", "下跌", "暴跌", "回撤", "降", "下降", "降至", "降到", "减少", "缩减", "下滑", "偏低", "负")


def _normalize_text_for_num_search(text: str) -> str:
    return (
        text.replace("％", "%")
        .replace("−", "-")
        .replace("–", "-")
        .replace("—", "-")
    )


def _format_scaled_variants(val: float) -> set[str]:
    """Generate natural Chinese unit equivalents for large raw numbers (亿 / 万 / 百万 / B)."""
    out: set[str] = set()
    av = abs(val)
    sign = "-" if val < 0 else ""

    def add_scaled(scaled: float, unit: str):
        for fmt in (f"{scaled:.2f}", f"{scaled:.1f}", f"{scaled:.3f}"):
            s = fmt.rstrip("0").rstrip(".")
            if s:
                out.add(f"{sign}{s}{unit}")
                out.add(f"{sign}{s} {unit}")

    if av >= 1e12:  # 万亿 / T (e.g., 4978144265920.0 -> 4.98万亿 / 4.98T)
        add_scaled(av / 1e12, "万亿")
        add_scaled(av / 1e12, "T")
        add_scaled(av / 1e8, "亿")
    elif av >= 1e8:  # 亿 (e.g., 44062000000 -> 440.62亿, 7003100000 -> 70.03亿)
        add_scaled(av / 1e8, "亿")
        add_scaled(av / 1e6, "百万")
        add_scaled(av / 1e9, "B")
    elif av >= 1e6:  # 百万 / 万 / 亿 / M (e.g., 1,000,000 -> 100万 / 1百万 / 1M)
        add_scaled(av / 1e8, "亿")
        add_scaled(av / 1e6, "百万")
        add_scaled(av / 1e6, "M")
        add_scaled(av / 1e4, "万")
    elif av >= 1e4:
        add_scaled(av / 1e4, "万")
        add_scaled(av / 1e3, "k")
        add_scaled(av / 1e3, "K")
    return out


def _numeric_variants(raw_tok: str) -> tuple[list[str], str | None]:
    """Return (direct surface variants, unsigned core if negative so negative-verb matching can apply)."""
    tok = raw_tok.strip()
    variants = {tok}
    no_plus = tok[1:] if tok.startswith("+") else tok
    variants.add(no_plus)

    has_pct = no_plus.endswith("%")
    core = no_plus[:-1] if has_pct else no_plus
    variants.add(core)

    # European thousands separator (e.g., 10.000 -> 10,000 / 10000 / 1万)
    if re.fullmatch(r"-?\d{1,3}(?:\.\d{3})+", core):
        plain = core.replace(".", "")
        variants.add(plain)
        variants.add(f"{int(plain):,}")
        variants |= _format_scaled_variants(float(plain))
        n = abs(int(plain))
        if n >= 10000 and n % 10000 == 0 and n // 10000 <= 10:
            variants.add(f"{CHINESE_DIGITS[str(n // 10000)]}万")

    # US thousands separator with optional decimals (e.g., 10,000 or -229,140,841.4484)
    if re.fullmatch(r"-?\d{1,3}(?:,\d{3})+(?:\.\d+)?", core):
        plain = core.replace(",", "")
        variants.add(plain)
        try:
            fval = float(plain)
            variants |= _format_scaled_variants(fval)
            if "." not in plain:
                n = abs(int(plain))
                if n >= 10000 and n % 10000 == 0 and n // 10000 <= 10:
                    variants.add(f"{CHINESE_DIGITS[str(n // 10000)]}万")
        except ValueError:
            pass

    # Plain float / int (e.g., 44062000000.0 -> 440.62亿, 59081 -> 59,081, 6.40% -> 6.4%)
    if re.fullmatch(r"-?\d+(?:\.\d+)?", core):
        if "." in core:
            stripped = core.rstrip("0").rstrip(".")
            if stripped:
                variants.add(stripped)
                if has_pct:
                    variants.add(stripped + "%")
        else:
            try:
                ival = int(core)
                if abs(ival) >= 1000:
                    variants.add(f"{ival:,}")
            except ValueError:
                pass
        try:
            fval = float(core)
            variants |= _format_scaled_variants(fval)
        except ValueError:
            pass

    if core.startswith("-"):
        pos_core = core[1:]
        signed = {v for v in variants if v.startswith("-")}
        signed.add("负" + pos_core)
        if has_pct:
            signed.add("负" + pos_core + "%")
        return sorted(signed, key=len, reverse=True), (pos_core + ("%" if has_pct else ""))

    return sorted(variants, key=len, reverse=True), None


def extract_critical_tokens(text: str) -> list[str]:
    if not text:
        return []
    norm = _normalize_text_for_num_search(text)
    tokens: list[str] = []
    seen: set[str] = set()

    def add(tok: str):
        k = tok.upper()
        if k not in seen:
            seen.add(k)
            tokens.append(tok)

    for m in DATE_RE.finditer(norm):
        add(m.group(0))
    for m in FISCAL_RE.finditer(norm):
        add(m.group(0))

    masked = DATE_RE.sub(" ", norm)
    masked = FISCAL_RE.sub(" ", masked)
    masked = MSG_INDEX_RE.sub(" ", masked)

    for m in NUMBER_RE.finditer(masked):
        tok = m.group(1)
        bare = tok.lstrip("+-").rstrip("%")
        if bare in TRIVIAL_INTS and "%" not in tok and "." not in tok and not tok.startswith("-"):
            continue
        # Skip raw internal negative error codes (e.g. -3222, -2311, -2047, -1)
        if re.fullmatch(r"-(?:1|\d{4,5})", tok):
            continue
        # Skip raw 8-digit report dates like 20241231 / 20250427 (often nicely written as 2024年/2025年4月)
        if re.fullmatch(r"(?:19|20)\d{6}", bare):
            continue
        add(tok)
    return tokens


def _match_negative_verb(norm_trans: str, pos_str: str) -> bool:
    """Allow e.g. '-17.4%' to match '下跌 17.4%' or '回撤17.4%' while rejecting '+17.4%'."""
    pos_bare = pos_str.rstrip("%")
    pattern = r"(?:" + "|".join(re.escape(v) for v in NEG_VERBS) + r")\s*(?:约|近|达|了)?\s*" + re.escape(pos_bare)
    return bool(re.search(pattern, norm_trans))


def check_token_preservation(orig_text: str, translated_text: str) -> list[str]:
    if not orig_text or not orig_text.strip():
        return []
    norm_trans = _normalize_text_for_num_search(translated_text or "")
    norm_trans_nospace = norm_trans.replace(" ", "")
    norm_trans_upper = norm_trans_nospace.upper()
    missing: list[str] = []

    for tok in extract_critical_tokens(orig_text):
        if FISCAL_RE.fullmatch(tok):
            up = tok.upper().replace(" ", "")
            ok = up in norm_trans_upper
            if not ok and up.startswith("FY"):
                yr = up[2:]
                if len(yr) == 4 and (f"{yr}财年" in norm_trans_nospace or yr in norm_trans):
                    ok = True
                elif len(yr) == 2 and (f"20{yr}财年" in norm_trans_nospace or f"20{yr}" in norm_trans):
                    ok = True
            if not ok:
                m_q = re.fullmatch(r"((?:19|20)\d{2})Q([1-4])", up)
                m_q2 = re.fullmatch(r"Q([1-4])((?:19|20)\d{2})", up)
                if m_q:
                    yr, q = m_q.group(1), m_q.group(2)
                    q_zh = CHINESE_DIGITS.get(q, q)
                    if any(v in norm_trans_nospace for v in (f"{yr}财年", f"{yr}年Q{q}", f"{yr}年第{q_zh}季", f"{yr}年{q_zh}季", f"{yr}年")):
                        ok = True
                elif m_q2:
                    q, yr = m_q2.group(1), m_q2.group(2)
                    q_zh = CHINESE_DIGITS.get(q, q)
                    if any(v in norm_trans_nospace for v in (f"{yr}Q{q}", f"{yr}年Q{q}", f"{yr}年第{q_zh}季", f"{yr}年{q_zh}季", f"Q{q}")):
                        ok = True
            if not ok:
                missing.append(tok)
            continue

        if DATE_RE.fullmatch(tok):
            parts = re.split(r"[-/]", tok)
            alt1 = f"{parts[0]}年{int(parts[1])}月{int(parts[2])}日"
            alt2 = f"{parts[0]}年{parts[1]}月{parts[2]}日"
            if tok not in norm_trans and alt1 not in norm_trans_nospace and alt2 not in norm_trans_nospace:
                missing.append(tok)
            continue

        variants, neg_pos = _numeric_variants(tok)
        if any(v in norm_trans or v.replace(" ", "") in norm_trans_nospace for v in variants):
            continue
        # Handle comma-separated parameter lists like "50,200" (50-day & 200-day MA) where
        # both numbers appear separately in the translated text (e.g., "50日、200日均线").
        if re.fullmatch(r"\d{1,3},\d{3}", tok):
            a, b = tok.split(",", 1)
            if a in norm_trans and b in norm_trans:
                continue
        if neg_pos and _match_negative_verb(norm_trans, neg_pos):
            continue
        missing.append(tok)
    return missing


def validate_attr_problems(
    orig_problems: list[dict[str, Any]],
    translated_result: Any,
) -> list[str]:
    errors: list[str] = []
    if not isinstance(translated_result, dict) or not isinstance(translated_result.get("problems"), list):
        return ["输出 JSON 缺少 problems 数组"]

    by_idx: dict[int, dict[str, Any]] = {}
    for item in translated_result["problems"]:
        if isinstance(item, dict) and isinstance(item.get("idx"), int):
            by_idx[item["idx"]] = item

    for orig in orig_problems:
        idx = orig["idx"]
        tr = by_idx.get(idx)
        if not tr:
            errors.append(f"缺少 idx={idx} 的翻译结果")
            continue
        for field in ("label", "problem_phenomena", "reason", "severity_reason"):
            o_val = (orig.get(field) or "").strip()
            t_val = tr.get(field)
            if o_val and (not isinstance(t_val, str) or not t_val.strip()):
                errors.append(f"idx={idx}.{field} 原文非空但翻译为空")
                continue
            if not o_val:
                continue
            t_str = t_val.strip()
            if field == "label" and len(t_str) > 42:
                errors.append(f"idx={idx}.label 过长（{len(t_str)}字，应压缩至 12-32 字内）")
            elif field == "reason" and len(t_str) > max(120, int(len(o_val) * 1.6)):
                errors.append(f"idx={idx}.reason 过长（{len(t_str)}字，请精炼成 1 句话直指根因）")
            elif field == "severity_reason" and len(t_str) > max(90, int(len(o_val) * 1.6)):
                errors.append(f"idx={idx}.severity_reason 过长（{len(t_str)}字，请精炼成 1 句话）")

        # Strict numeric/date preservation on problem_phenomena and reason:
        # (severity_reason is allowed to concisely state user impact without parroting raw P4 fallback values)
        o_ph = (orig.get("problem_phenomena") or "").strip()
        t_ph = (tr.get("problem_phenomena") or "").strip()
        if o_ph:
            missing_ph = check_token_preservation(o_ph, t_ph)
            if missing_ph:
                errors.append(f"idx={idx}.problem_phenomena 遗漏或改写了关键数值/日期口径：{', '.join(missing_ph[:6])}")

        o_core = "\n".join((orig.get(f) or "").strip() for f in ("problem_phenomena", "reason"))
        t_core = "\n".join((tr.get(f) or "").strip() for f in ("label", "problem_phenomena", "reason", "severity_reason"))
        missing_core = check_token_preservation(o_core, t_core)
        if missing_core:
            errors.append(f"idx={idx} 遗漏了现象/原因中的关键数值/日期口径：{', '.join(missing_core[:6])}")
    return errors


def validate_attr_summaries(
    orig_summaries: dict[str, Any],
    translated_result: Any,
) -> list[str]:
    errors: list[str] = []
    if not isinstance(translated_result, dict):
        return ["输出不是合法 JSON 对象"]

    orig_ss = (orig_summaries.get("session_summary") or "").strip()
    if orig_ss:
        tr_ss = translated_result.get("session_summary")
        if not isinstance(tr_ss, str) or not tr_ss.strip():
            errors.append("session_summary 原文非空但翻译为空")
        else:
            missing = check_token_preservation(orig_ss, tr_ss)
            if missing:
                errors.append(f"session_summary 遗漏关键数值/口径：{', '.join(missing[:6])}")

    orig_turns = orig_summaries.get("turn_summaries") or []
    tr_turns = translated_result.get("turn_summaries")
    if orig_turns and not isinstance(tr_turns, list):
        return errors + ["缺少 turn_summaries 数组"]

    by_ti = {}
    for item in tr_turns or []:
        if isinstance(item, dict) and isinstance(item.get("turn_idx"), int):
            by_ti[item["turn_idx"]] = item

    for ot in orig_turns:
        ti = ot["turn_idx"]
        o_val = (ot.get("summary") or "").strip()
        if not o_val:
            continue
        tr = by_ti.get(ti)
        if not tr or not isinstance(tr.get("summary"), str) or not tr["summary"].strip():
            errors.append(f"turn_idx={ti}.summary 翻译缺失")
            continue
        # Summary is a high-level overview (individual problem cards already undergo strict
        # token checks). Ignore internal negative error codes like -3222 / -2311 and allow
        # concise summaries as long as major factual tokens aren't wholesale dropped.
        raw_missing = check_token_preservation(o_val, tr["summary"])
        filtered = [
            tok for tok in raw_missing
            if not re.fullmatch(r"-\d{3,5}", tok)
        ]
        orig_tokens = [
            tok for tok in extract_critical_tokens(o_val)
            if not re.fullmatch(r"-\d{3,5}", tok)
        ]
        if filtered and (len(orig_tokens) <= 4 or len(filtered) > max(2, len(orig_tokens) // 3)):
            errors.append(f"turn_idx={ti}.summary 遗漏关键数值/口径：{', '.join(filtered[:6])}")
    return errors


def validate_compact_batch(
    orig_items: list[dict[str, Any]],
    translated_result: Any,
) -> list[str]:
    errors: list[str] = []
    if not isinstance(translated_result, dict) or not isinstance(translated_result.get("items"), list):
        return ["输出 JSON 缺少 items 数组"]

    by_id: dict[str, str] = {}
    for it in translated_result["items"]:
        if isinstance(it, dict) and isinstance(it.get("id"), str) and isinstance(it.get("text"), str):
            by_id[it["id"]] = it["text"].strip()

    for orig in orig_items:
        oid = orig["id"]
        o_val = (orig.get("text") or "").strip()
        t_val = by_id.get(oid, "")
        if o_val and not t_val:
            errors.append(f"compact item {oid} 翻译缺失")
            continue
        if not o_val:
            continue
        if len(t_val) > max(130, int(len(o_val) * 1.4)):
            errors.append(f"compact item {oid} 译文过长（{len(t_val)}字），请压缩为 1 句精炼大白话")
        # Compact items are 1-line sidebar summaries; only strictly require percentages & fiscal
        # periods (not every raw 14-digit preview float or long date range in a sidebar breadcrumb).
        missing = check_token_preservation(o_val, t_val)
        strict_missing = [
            tok for tok in missing
            if ("%" in tok or FISCAL_RE.fullmatch(tok))
        ]
        if strict_missing and len(strict_missing) <= 4:
            errors.append(f"compact item {oid} 遗漏关键百分比/财年：{', '.join(strict_missing[:4])}")
    return errors
