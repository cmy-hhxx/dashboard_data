"""Server-side cached recall index: uncapped paginated session recall and bounded (<= 500) slices.

Replaces downloading multi-ten-MB ``samples-<product>.json`` + ``labels-<product>.json``
into the browser on every recall jump, filter, sunburst galaxy open, trend drawer,
and compare sibling lookup.
"""
from __future__ import annotations

from collections import OrderedDict
import json
import math
import os
import threading

RECALL_CAP = 500
_ORDER_CACHE_MAX = 16
_FACET_CACHE_MAX = 32
SEV = ("P0", "P1", "P2", "P3", "P4")
WORST = ("P0", "P1", "P2", "P3", "P4", "none")
WORST_IDX = {w: i for i, w in enumerate(WORST)}
USER_TYPE_KEYS = frozenset(("real", "test", "internal", "unknown"))


def _match_model_family(row_model: str | None, query_model: str | None) -> bool:
    qm = str(query_model or "").strip().lower()
    if not qm or qm == "all":
        return True
    rm = str(row_model or "").strip().lower()
    return rm == qm or rm.startswith(qm)


def _row_has_sev(row: dict, sev: str) -> bool:
    if not sev:
        return True
    sv = row.get("sv")
    if isinstance(sv, list) and len(sv) >= 5:
        if sev == "none":
            return not any(int(v or 0) > 0 for v in sv[:5])
        idx = WORST_IDX.get(sev, -1)
        return 0 <= idx < 5 and int(sv[idx] or 0) > 0
    return (row.get("w") or "none") == sev


def _row_mechs(row: dict) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for path in row.get("pt") or ():
        parts = str(path).split(".")
        if len(parts) >= 2 and parts[1] and parts[1] not in seen:
            seen.add(parts[1])
            out.append(parts[1])
    return out


def sev_idx(w) -> int:
    return WORST_IDX.get(w, 5)


def ut_of(row: dict) -> str:
    ut = row.get("ut")
    return ut if ut in USER_TYPE_KEYS else "unknown"


def is_lost_row(row: dict) -> bool:
    return bool(row.get("ul") or row.get("sp") == "lost")


def scene_of(row: dict) -> str:
    return row.get("sc") or row.get("task") or "未接入分类体系"


def sub_of(row: dict) -> str:
    return row.get("sub") or ""


def _session_key(row: dict) -> str:
    return f"{row.get('sp') or ''}|{row.get('m') or ''}|{row.get('sid') or row.get('s') or ''}"


def _group_sessions(rows: list[dict]) -> tuple[list[dict], dict[str, dict], dict[str, dict]]:
    """Mirror ``samples.js`` ``groupSessions(rows)`` with O(1) lookup maps and search index."""
    groups: dict[str, dict] = {}
    models_by_sid: dict[str, set[str]] = {}
    for r in rows:
        sid = r.get("sid")
        if sid:
            m = r.get("m")
            if m:
                models_by_sid.setdefault(str(sid), set()).add(m)
        key = _session_key(r)
        g = groups.get(key)
        if g is None:
            g = {
                "key": key,
                "s": key,
                "rows": [],
                "sid": sid,
                "m": r.get("m"),
                "sp": r.get("sp"),
                "w": "none",
                "n": 0,
                "tr": 0,
                "sv": [0, 0, 0, 0, 0],
                "hasSv": True,
                "pt": set(),
                "st": set(),
                "tg": set(),
                "lb": [],
                "lb_seen": set(),
                "tid": "",
                "case": "",
                "task": "",
                "sub": "",
                "skill": "",
                "sc": "",
                "lang": r.get("lang"),
                "uid": "",
                "ut": "",
                "ul": 0,
            }
            groups[key] = g
        g["rows"].append(r)
        g["n"] += int(r.get("n") or 0)
        g["tr"] += int(r.get("tr") or 1)
        sv = r.get("sv")
        if isinstance(sv, list) and len(sv) >= 5:
            for i in range(5):
                g["sv"][i] += int(sv[i] or 0)
        else:
            g["hasSv"] = False
        rw = r.get("w")
        if rw in WORST_IDX and (g["w"] == "none" or WORST_IDX[rw] < WORST_IDX[g["w"]]):
            g["w"] = rw
        for x in r.get("pt") or ():
            g["pt"].add(x)
        for x in r.get("st") or ():
            g["st"].add(x)
        for x in r.get("tg") or ():
            g["tg"].add(x)
        lb = r.get("lb")
        if lb and lb not in g["lb_seen"]:
            g["lb_seen"].add(lb)
            g["lb"].append(lb)
        if not g["tid"] and r.get("tid"):
            g["tid"] = r["tid"]
        if not g["case"] and r.get("case"):
            g["case"] = r["case"]
        if not g["task"] and r.get("task"):
            g["task"] = r["task"]
        if not g["sub"] and r.get("sub"):
            g["sub"] = r["sub"]
        if not g["skill"] and r.get("skill"):
            g["skill"] = r["skill"]
        if not g["sc"] and r.get("sc"):
            g["sc"] = r["sc"]
        if not g["uid"] and r.get("uid"):
            g["uid"] = r["uid"]
        if not g["ut"] and r.get("ut"):
            g["ut"] = r["ut"]
        if r.get("ul"):
            g["ul"] = 1

    sessions: list[dict] = []
    by_key: dict[str, dict] = {}
    by_slug: dict[str, dict] = {}
    for g in groups.values():
        g_rows = sorted(
            g["rows"],
            key=lambda x: (str(x.get("d") or ""), str(x.get("tid") or ""), str(x.get("s") or "")),
        )
        last = g_rows[-1]
        if g["hasSv"]:
            counted_w = "none"
            for i, s_name in enumerate(SEV):
                if g["sv"][i] > 0:
                    counted_w = s_name
                    break
            sv_out = g["sv"]
        else:
            counted_w = g["w"]
            sv_out = last.get("sv") if isinstance(last.get("sv"), list) else None

        lb_text = "｜".join(g["lb"])
        dates = {str(x.get("d") or "") for x in g_rows if x.get("d")}
        # Pre-built lowercase search blob mirrors samples.js `hit(r)`.
        parts = [
            last.get("q"), lb_text, g["key"], g["sid"], g["tid"],
            g["case"], g["task"], g["sub"], g["skill"],
        ]
        for x in g_rows:
            parts.extend((
                x.get("q"), x.get("sid"), x.get("tid"), x.get("case"),
                x.get("task"), x.get("sub"), x.get("skill"), x.get("s"),
            ))
        search_blob = "\n".join(str(v).lower() for v in parts if v)
        sid = g["sid"]
        peer_models = sorted(models_by_sid.get(str(sid), ())) if sid else []

        sess = {
            "key": g["key"],
            "s": g["key"],
            "sid": sid,
            "m": g["m"],
            "sp": g["sp"],
            "q": last.get("q") or "",
            "d": last.get("d") or "",
            "w": counted_w,
            "n": g["n"],
            "tr": g["tr"],
            "sv": sv_out,
            "task": g["task"],
            "sub": g["sub"],
            "sc": g["sc"],
            "ut": g["ut"],
            "ul": g["ul"],
            "lang": g["lang"],
            "pm": peer_models if len(peer_models) > 1 else None,
            "rows": [
                {
                    "s": x.get("s"),
                    "d": x.get("d") or "",
                    **({"tid": x["tid"]} if x.get("tid") else {}),
                    **({"tr": x["tr"]} if x.get("tr") and x.get("tr") != 1 else {}),
                    **({"w": x["w"]} if x.get("w") and x.get("w") != "none" else {}),
                    **({"sv": x["sv"]} if isinstance(x.get("sv"), list) and any(x["sv"]) else {}),
                }
                for x in g_rows
            ],
            # Internal server-only fields (stripped on wire serialization)
            "_st": g["st"],
            "_pt": g["pt"],
            "_dates": dates,
            "_search": search_blob,
            "_scene": g["sc"] or g["task"] or "未接入分类体系",
            "_ut": g["ut"] if g["ut"] in USER_TYPE_KEYS else "unknown",
            "_lost": bool(g["ul"] or g["sp"] == "lost"),
        }
        sessions.append(sess)
        by_key[g["key"]] = sess
        for x in g_rows:
            slug = x.get("s")
            if slug and slug not in by_slug:
                by_slug[slug] = sess
    return sessions, by_key, by_slug


def _public_session(sess: dict) -> dict:
    out = {
        "key": sess["key"],
        "s": sess["s"],
        "sid": sess["sid"],
        "m": sess["m"],
        "sp": sess["sp"],
        "q": sess["q"],
        "d": sess["d"],
        "w": sess["w"],
        "n": sess["n"],
        "tr": sess["tr"],
        "sv": sess["sv"],
        "task": sess["task"],
        "sub": sess["sub"],
        "sc": sess["sc"],
        "ut": sess["ut"],
        "ul": sess["ul"],
        "lang": sess["lang"],
        "rows": sess["rows"],
    }
    if sess.get("pm"):
        out["pm"] = sess["pm"]
    return out


def _severity_hit(sess: dict, w: str) -> bool:
    if not w:
        return True
    sv = sess.get("sv")
    has_counts = isinstance(sv, list) and len(sv) >= 5
    if w == "none":
        return (not any(int(n or 0) > 0 for n in sv[:5])) if has_counts else sess.get("w") == "none"
    idx = WORST_IDX.get(w, -1)
    if 0 <= idx < 5:
        return (int(sv[idx] or 0) > 0) if has_counts else sess.get("w") == w
    return False


def _cascade_hit(sess: dict, f: dict, omit: frozenset[str] = frozenset()) -> bool:
    if "scene" not in omit and f["scene"] and sess["_scene"] != f["scene"]:
        return False
    if "sub" not in omit and f["sub"] and (sess.get("sub") or "") != f["sub"]:
        return False
    if "stage" not in omit and f["stage"] and f["stage"] not in sess["_st"]:
        return False
    if "mech" not in omit and f["mech"]:
        st_prefix = f"{f['stage']}." if f["stage"] else ""
        mech = f["mech"]
        hit = False
        for path in sess["_pt"]:
            parts = path.split(".")
            if len(parts) >= 2 and parts[1] == mech and (not st_prefix or path.startswith(st_prefix)):
                hit = True
                break
        if not hit:
            return False
    if "pattern" not in omit and f["pattern"]:
        pat = f["pattern"]
        pat_dot = pat + "."
        if not any(x == pat or x.startswith(pat_dot) for x in sess["_pt"]):
            return False
    return True


def _list_hit(sess: dict, f: dict, omit: frozenset[str] = frozenset()) -> bool:
    if not _severity_hit(sess, f["w"]):
        return False
    if f["split"]:
        if f["split"] == "lost":
            if not sess["_lost"]:
                return False
        elif sess.get("sp") != f["split"]:
            return False
    if f["model"] and sess.get("m") != f["model"]:
        return False
    if f["ut"] and sess["_ut"] != f["ut"]:
        return False
    return _cascade_hit(sess, f, omit)


def _compute_facets(sessions: list[dict], f: dict) -> dict:
    omit_scene = frozenset(("scene", "sub", "stage", "mech", "pattern"))
    omit_cluster = frozenset(("stage", "mech", "pattern"))
    scenes: dict[str, set[str]] = {}
    stages: set[str] = set()
    mechs: set[str] = set()
    patterns: set[str] = set()
    for sess in sessions:
        if _list_hit(sess, f, omit_scene):
            sc = sess["_scene"]
            subs = scenes.setdefault(sc, set())
            if sess["sub"]:
                subs.add(sess["sub"])
        if _list_hit(sess, f, omit_cluster):
            stages.update(sess["_st"])
            for path in sess["_pt"]:
                patterns.add(path)
                parts = path.split(".")
                if len(parts) >= 2:
                    mechs.add(f"{parts[0]}.{parts[1]}")
    return {
        "scenes": {k: sorted(v) for k, v in sorted(scenes.items())},
        "stages": sorted(stages),
        "mechs": sorted(mechs),
        "patterns": sorted(patterns),
    }


def _compact_case_item(row: dict) -> dict:
    return {
        "s": row.get("s"),
        "w": sev_idx(row.get("w")),
        "n": int(row.get("n") or 0),
        "q": row.get("q") or "",
        "m": row.get("m"),
        "sp": row.get("sp"),
        "d": row.get("d") or "",
    }


def _date_desc_key(d: str) -> tuple[int, ...]:
    # Negate ordinals so ascending sort places newer YYYY-MM-DD dates first.
    return tuple(-ord(ch) for ch in (d or ""))


class RecallEntry:
    """In-memory indexed snapshot of one product's ``samples-<product>.json`` (+ labels)."""

    def __init__(self, product: str, key: tuple, etag: str, payload: dict):
        prod = (payload.get("products") or {}).get(product) or {}
        rows = prod.get("rows") or []
        self.product = product
        self.key = key
        self.etag = etag
        self.generated_at = payload.get("generated_at")
        self.available = payload.get("available") or [product]
        self.models = prod.get("models") or []
        self.splits = prod.get("splits") or []
        self.rows = rows

        self.by_slug: dict[str, dict] = {}
        self.by_tid: dict[str, list[dict]] = {}
        self.by_sid: dict[str, list[dict]] = {}
        self.by_date: dict[str, list[dict]] = {}
        self.by_sev: dict[str, list[dict]] = {w: [] for w in WORST}
        self.by_mech: dict[str, list[dict]] = {}
        self.by_stage: dict[str, list[dict]] = {}
        self.by_model: dict[str, list[dict]] = {}

        for r in rows:
            sid = r.get("sid")
            if sid:
                self.by_sid.setdefault(str(sid), []).append(r)

        self.sorted_rows = sorted(
            rows,
            key=lambda r: (sev_idx(r.get("w")), -int(r.get("n") or 0), _date_desc_key(r.get("d") or "")),
        )
        for r in self.sorted_rows:
            slug = r.get("s")
            if slug:
                self.by_slug[slug] = r
            tid = r.get("tid")
            if tid:
                self.by_tid.setdefault(str(tid), []).append(r)
            d = r.get("d")
            if d:
                self.by_date.setdefault(str(d), []).append(r)
            m = r.get("m") or ""
            self.by_model.setdefault(m, []).append(r)

            sv = r.get("sv")
            if isinstance(sv, list) and len(sv) >= 5:
                hit_any = False
                for i, s_name in enumerate(SEV):
                    if int(sv[i] or 0) > 0:
                        self.by_sev[s_name].append(r)
                        hit_any = True
                if not hit_any:
                    self.by_sev["none"].append(r)
            else:
                rw = r.get("w") or "none"
                self.by_sev.setdefault(rw if rw in WORST_IDX else "none", []).append(r)

            mechs = _row_mechs(r)
            if mechs:
                for mech_id in mechs:
                    self.by_mech.setdefault(mech_id, []).append(r)
            elif int(r.get("n") or 0) > 0:
                self.by_mech.setdefault("~un", []).append(r)

            stages_seen: set[str] = set()
            for s in r.get("st") or ():
                if s and s not in stages_seen:
                    stages_seen.add(s)
                    self.by_stage.setdefault(s, []).append(r)
            for path in r.get("pt") or ():
                s = str(path).split(".")[0]
                if s and s not in stages_seen:
                    stages_seen.add(s)
                    self.by_stage.setdefault(s, []).append(r)

        self.sorted_dates = sorted(self.by_date.keys())
        self.sessions, self.session_by_key, self.session_by_slug = _group_sessions(rows)
        self.session_pos: dict[str, int] = {s["key"]: i for i, s in enumerate(self.sessions)}
        self._query_lock = threading.Lock()
        self._order_cache: OrderedDict[tuple, list[dict]] = OrderedDict()
        self._facet_cache: OrderedDict[tuple, dict] = OrderedDict()
        empty_f = {k: "" for k in ("q", "w", "split", "model", "ut", "date", "scene", "sub", "stage", "mech", "pattern")}
        self.default_facets = _compute_facets(self.sessions, empty_f)

    def _ordered_sessions(self, f: dict[str, str], sort_by: str) -> list[dict]:
        sort_key = sort_by if sort_by in ("n", "date") else "sev"
        needle = f["q"].lower()
        has_filter = bool(needle or any(f[k] for k in ("w", "split", "model", "ut", "date", "scene", "sub", "stage", "mech", "pattern")))
        if not has_filter and sort_key == "sev":
            return self.sessions
        cache_key = (
            needle, f["w"], f["split"], f["model"], f["ut"], f["date"],
            f["scene"], f["sub"], f["stage"], f["mech"], f["pattern"], sort_key,
        )
        with self._query_lock:
            hit = self._order_cache.get(cache_key)
            if hit is not None:
                self._order_cache.move_to_end(cache_key)
                return hit

        date_val = f["date"]
        if not has_filter:
            matched_list = self.sessions
        else:
            matched_list = [
                sess for sess in self.sessions
                if _list_hit(sess, f)
                and (not date_val or date_val in sess["_dates"])
                and (not needle or needle in sess["_search"])
            ]

        if sort_key == "n":
            ordered = sorted(matched_list, key=lambda x: x["n"], reverse=True)
        elif sort_key == "date":
            ordered = sorted(matched_list, key=lambda x: x["d"], reverse=True)
        else:
            ordered = matched_list

        with self._query_lock:
            self._order_cache[cache_key] = ordered
            self._order_cache.move_to_end(cache_key)
            while len(self._order_cache) > _ORDER_CACHE_MAX:
                self._order_cache.popitem(last=False)
        return ordered

    def _facets_for(self, f: dict[str, str]) -> dict:
        cache_key = (f["w"], f["split"], f["model"], f["ut"], f["scene"], f["sub"])
        if not any(cache_key):
            return self.default_facets
        with self._query_lock:
            hit = self._facet_cache.get(cache_key)
            if hit is not None:
                self._facet_cache.move_to_end(cache_key)
                return hit

        facets = _compute_facets(self.sessions, f)
        with self._query_lock:
            self._facet_cache[cache_key] = facets
            self._facet_cache.move_to_end(cache_key)
            while len(self._facet_cache) > _FACET_CACHE_MAX:
                self._facet_cache.popitem(last=False)
        return facets

    def query_sessions(self, q: dict[str, str]) -> dict:
        f = {
            "q": (q.get("q") or "").strip(),
            "w": q.get("w") or "",
            "split": q.get("split") or "",
            "model": q.get("model") or "",
            "ut": q.get("ut") or "",
            "date": q.get("date") or "",
            "scene": q.get("scene") or "",
            "sub": q.get("sub") or "",
            "stage": q.get("stage") or "",
            "mech": q.get("mech") or "",
            "pattern": q.get("pattern") or "",
        }
        sort_by = q.get("sort") or "sev"
        try:
            size = max(1, min(100, int(q.get("size") or "50")))
        except ValueError:
            size = 50
        try:
            page = max(1, int(q.get("page") or "1"))
        except ValueError:
            page = 1
        wanted = (q.get("case") or "").strip()
        locate = q.get("locate") == "1"
        want_facets = q.get("facets") != "0"

        ordered = self._ordered_sessions(f, sort_by)
        matched_total = len(ordered)
        recalled = matched_total
        pages = max(1, math.ceil(matched_total / size))

        target_sess = None
        target_page = None
        if wanted:
            target_sess = self.session_by_key.get(wanted) or self.session_by_slug.get(wanted)
            if target_sess is not None:
                tkey = target_sess["key"]
                if not any(f.values()) and sort_by not in ("n", "date"):
                    idx = self.session_pos.get(tkey)
                    if idx is not None:
                        target_page = (idx // size) + 1
                else:
                    for idx, sess in enumerate(ordered):
                        if sess["key"] == tkey:
                            target_page = (idx // size) + 1
                            break
                if locate and target_page is not None:
                    page = target_page

        page = max(1, min(pages, page))
        start = (page - 1) * size
        page_rows = [_public_session(sess) for sess in ordered[start:start + size]]

        resp = {
            "product": self.product,
            "generated_at": self.generated_at,
            "available": self.available,
            "models": self.models,
            "splits": self.splits,
            "total_sessions": len(self.sessions),
            "matched": matched_total,
            "recalled": recalled,
            "cap": None,
            "capped": False,
            "page": page,
            "size": size,
            "pages": pages,
            "rows": page_rows,
        }
        if target_sess is not None:
            resp["target"] = _public_session(target_sess)
            resp["target_page"] = target_page
        if want_facets:
            resp["facets"] = self._facets_for(f)
        return resp

    def query_galaxy(self, q: dict[str, str]) -> dict:
        card = q.get("card") or ""
        try:
            cap = max(1, min(RECALL_CAP, int(q.get("cap") or str(RECALL_CAP))))
        except ValueError:
            cap = RECALL_CAP
        unified = q.get("unified") == "1"

        def ver_key(r: dict) -> str:
            return str(r.get("m") or "") if unified else f"{r.get('sp') or ''}|{r.get('m') or ''}"

        group_totals: dict[str, int] = {}
        group_samples: dict[str, list[dict]] = {}
        parts = [0, 0, 0, 0, 0, 0]
        total_matched = 0
        needs_sort = False

        def record(gkey: str, r: dict, keep_all: bool = False) -> None:
            nonlocal total_matched
            group_totals[gkey] = group_totals.get(gkey, 0) + 1
            bucket = group_samples.get(gkey)
            if bucket is None:
                group_samples[gkey] = [r]
            elif keep_all or len(bucket) < cap:
                bucket.append(r)
            parts[sev_idx(r.get("w"))] += 1
            total_matched += 1

        if card == "vol":
            model = q.get("model") or ""
            task = q.get("task") or ""
            others = set()
            if q.get("others"):
                try:
                    others = set(json.loads(q["others"]))
                except ValueError:
                    others = set()
            candidates = (
                self.by_model[model]
                if model and model in self.by_model
                else (
                    [r for r in self.sorted_rows if _match_model_family(r.get("m"), model)]
                    if model
                    else self.sorted_rows
                )
            )
            for r in candidates:
                rtask = r.get("task") or "未接入分类体系"
                if task:
                    if rtask != task:
                        continue
                elif others and rtask in others:
                    continue
                gkey = (r.get("sub") or r.get("sc") or r.get("task") or "未接入分类体系") if (task or others) else (r.get("task") or r.get("sc") or "未接入分类体系")
                record(gkey, r)
        elif card == "eval":
            d0 = q.get("d0") or ""
            d1 = q.get("d1") or ""
            model = q.get("model") or "all"
            if d0 and d0 == d1:
                candidates = self.by_date.get(d0, ())
            else:
                date_list = [d for d in self.sorted_dates if (not d0 or d >= d0) and (not d1 or d <= d1)]
                needs_sort = len(date_list) > 1
                candidates = [r for d in date_list for r in self.by_date.get(d, ())]
            for r in candidates:
                if model != "all" and not _match_model_family(r.get("m"), model):
                    continue
                record(ver_key(r), r, keep_all=needs_sort)
        elif card == "attr":
            model = q.get("model") or ""
            sev = q.get("sev") or ""
            mech = q.get("mech") or ""
            role = q.get("role") or ""
            version = q.get("version") or ""

            def stage_for_mech(r: dict, target_mech: str) -> str:
                stage = next((str(p).split(".")[0] for p in (r.get("pt") or ()) if len(str(p).split(".")) >= 2 and str(p).split(".")[1] == target_mech), "")
                if stage:
                    return stage
                st_list = r.get("st") or ()
                return st_list[0] if st_list else "~un"

            def model_rows() -> list[dict]:
                if not model or model == "all":
                    return self.sorted_rows
                if model in self.by_model:
                    return self.by_model[model]
                return [r for r in self.sorted_rows if _match_model_family(r.get("m"), model)]

            if model or sev or mech:
                if sev and mech:
                    b_sev = self.by_sev.get(sev, ())
                    b_mech = self.by_mech.get(mech, ())
                    if len(b_sev) <= len(b_mech):
                        for r in b_sev:
                            if model and not _match_model_family(r.get("m"), model):
                                continue
                            mechs = _row_mechs(r)
                            hit = (not mechs and int(r.get("n") or 0) > 0) if mech == "~un" else (mech in mechs)
                            if not hit:
                                continue
                            record(stage_for_mech(r, mech), r)
                    else:
                        for r in b_mech:
                            if (model and not _match_model_family(r.get("m"), model)) or not _row_has_sev(r, sev):
                                continue
                            record(stage_for_mech(r, mech), r)
                elif model and sev:
                    b_mod = model_rows()
                    b_sev = self.by_sev.get(sev, ())
                    if len(b_mod) <= len(b_sev):
                        for r in b_mod:
                            if not _row_has_sev(r, sev):
                                continue
                            mechs = _row_mechs(r)
                            record(mechs[0] if mechs else "~un", r)
                    else:
                        for r in b_sev:
                            if not _match_model_family(r.get("m"), model):
                                continue
                            mechs = _row_mechs(r)
                            record(mechs[0] if mechs else "~un", r)
                elif sev:
                    for r in self.by_sev.get(sev, ()):
                        mechs = _row_mechs(r)
                        record(mechs[0] if mechs else "~un", r)
                elif mech:
                    for r in self.by_mech.get(mech, ()):
                        rw = r.get("w")
                        record(rw if rw in WORST_IDX else "none", r)
                else:
                    for r in model_rows():
                        if int(r.get("n") or 0) <= 0:
                            continue
                        rw = r.get("w")
                        record(rw if rw in WORST_IDX else "none", r)
            else:
                for r in self.sorted_rows:
                    roles = r.get("r") or []
                    if role:
                        if role not in roles:
                            continue
                        gkey = ver_key(r)
                    else:
                        if not roles or ver_key(r) != version:
                            continue
                        gkey = str(roles[0])
                    record(gkey, r)
        elif card == "clu":
            prefix = q.get("prefix") or ""
            prefix_dot = prefix + "."
            stage_id = prefix.split(".", 1)[0] if prefix else ""
            candidates = self.by_stage.get(stage_id, ()) if stage_id else self.sorted_rows
            kids: list[str] = []
            if q.get("kids"):
                try:
                    kids = [str(k) for k in json.loads(q["kids"])]
                except ValueError:
                    kids = []
            kid_dots = [(k, k + ".") for k in kids]
            for r in candidates:
                pt = r.get("pt") or ()
                if not any(x == prefix or x.startswith(prefix_dot) for x in pt):
                    continue
                gkey = prefix
                if kid_dots:
                    matched_kid = None
                    for k, kdot in kid_dots:
                        if any(x == k or x.startswith(kdot) for x in pt):
                            matched_kid = k
                            break
                    gkey = matched_kid if matched_kid is not None else "~"
                record(gkey, r)

        if needs_sort:
            for items in group_samples.values():
                items.sort(key=lambda r: (sev_idx(r.get("w")), -int(r.get("n") or 0), _date_desc_key(r.get("d") or "")))

        ordered_groups = sorted(group_totals.items(), key=lambda pair: pair[1], reverse=True)

        quotas: dict[str, int] = {}
        if total_matched <= cap:
            for gkey, tot in ordered_groups:
                quotas[gkey] = tot
        else:
            assigned = 0
            for gkey, tot in ordered_groups:
                take = min(tot, max(1, round(cap * tot / total_matched)))
                quotas[gkey] = take
                assigned += take
            # Trim or top-up largest clusters so total == cap.
            idx = 0
            while assigned > cap and ordered_groups:
                gkey, _ = ordered_groups[idx % len(ordered_groups)]
                if quotas[gkey] > 1:
                    quotas[gkey] -= 1
                    assigned -= 1
                idx += 1
                if idx > len(ordered_groups) * 4:
                    break
            idx = 0
            while assigned < cap and ordered_groups:
                gkey, tot = ordered_groups[idx % len(ordered_groups)]
                if quotas[gkey] < tot:
                    quotas[gkey] += 1
                    assigned += 1
                idx += 1
                if idx > len(ordered_groups) * 4:
                    break

        out_groups = []
        recalled = 0
        for gkey, tot in ordered_groups:
            take = quotas.get(gkey, 0)
            sliced = [_compact_case_item(r) for r in group_samples[gkey][:take]]
            recalled += len(sliced)
            out_groups.append({"key": gkey, "total": tot, "items": sliced})

        return {
            "product": self.product,
            "generated_at": self.generated_at,
            "total": total_matched,
            "recalled": recalled,
            "cap": cap,
            "capped": total_matched > cap,
            "parts": parts,
            "groups": out_groups,
        }

    def query_trend(self, q: dict[str, str]) -> dict:
        date = q.get("date") or ""
        node = q.get("node") or ""
        node_dot = node + "." if node else ""
        models = set(m for m in (q.get("models") or "").split(",") if m)
        uts = set(u for u in (q.get("uts") or "").split(",") if u)
        scenes = None
        if q.get("scenes"):
            try:
                raw_scenes = json.loads(q["scenes"])
                if isinstance(raw_scenes, list):
                    scenes = {(str(pair[0]), str(pair[1])) for pair in raw_scenes if isinstance(pair, list) and len(pair) >= 2}
            except ValueError:
                scenes = None
        try:
            mildest = int(q.get("mildest") or "-1")
        except ValueError:
            mildest = -1
        try:
            offset = max(0, int(q.get("offset") or "0"))
        except ValueError:
            offset = 0
        try:
            limit = max(1, min(200, int(q.get("limit") or "60")))
        except ValueError:
            limit = 60
        try:
            cap = max(1, min(RECALL_CAP, int(q.get("cap") or str(RECALL_CAP))))
        except ValueError:
            cap = RECALL_CAP

        day_rows = self.by_date.get(date, []) if date else []
        candidates = 0
        pool = []
        for r in day_rows:
            if models and r.get("m") not in models:
                continue
            if uts and (r.get("ut") or "unknown") not in uts:
                continue
            if scenes is not None:
                rtask = r.get("task") or r.get("sc") or r.get("skill") or "未接入分类体系"
                rsub = r.get("sub") or ""
                if (rtask, rsub) not in scenes:
                    continue
            if node and not any(p == node or p.startswith(node_dot) for p in (r.get("pt") or ())):
                continue
            candidates += 1
            if mildest >= 0:
                widx = WORST_IDX.get(r.get("w"), -1)
                if widx >= 0 and widx > mildest:
                    continue
            pool.append(r)

        total_pool = len(pool)
        bounded = pool[:cap]
        page = bounded[offset:offset + limit]
        return {
            "product": self.product,
            "generated_at": self.generated_at,
            "candidates": candidates,
            "total": total_pool,
            "recalled": len(bounded),
            "cap": cap,
            "capped": total_pool > cap,
            "offset": offset,
            "limit": limit,
            "has_more": offset + len(page) < len(bounded),
            "rows": [
                {
                    "s": r.get("s"),
                    "w": r.get("w"),
                    "n": int(r.get("n") or 0),
                    "q": r.get("q") or "",
                    "m": r.get("m"),
                    "sp": r.get("sp"),
                    "d": r.get("d") or "",
                }
                for r in page
            ],
        }

    def query_session(self, q: dict[str, str]) -> dict:
        sid = (q.get("sid") or "").strip()
        model = q.get("m") or ""
        split = q.get("sp") or ""
        if not sid:
            return {"product": self.product, "rows": []}
        hits = []
        for r in self.by_sid.get(sid, []):
            if model and r.get("m") and r.get("m") != model:
                continue
            if split and r.get("sp") and r.get("sp") != split:
                continue
            hits.append({
                "s": r.get("s"),
                "sid": r.get("sid"),
                "m": r.get("m"),
                "sp": r.get("sp"),
                "d": r.get("d") or "",
            })
            if len(hits) >= RECALL_CAP:
                break
        return {"product": self.product, "generated_at": self.generated_at, "rows": hits}

    def lookup(self, slugs: list[str], tids: list[str], cap: int = RECALL_CAP) -> dict:
        cap = max(1, min(RECALL_CAP, int(cap or RECALL_CAP)))
        seen: set[str] = set()
        out: list[dict] = []
        for slug in slugs or ():
            if len(out) >= cap:
                break
            r = self.by_slug.get(str(slug))
            if r and r.get("s") not in seen:
                seen.add(r["s"])
                out.append(r)
        for tid in tids or ():
            if len(out) >= cap:
                break
            for r in self.by_tid.get(str(tid), ()):
                if len(out) >= cap:
                    break
                s = r.get("s")
                if s and s not in seen:
                    seen.add(s)
                    out.append(r)
        return {
            "product": self.product,
            "generated_at": self.generated_at,
            "cap": cap,
            "rows": [
                {
                    "s": r.get("s"),
                    "tid": r.get("tid"),
                    "w": r.get("w"),
                    "n": int(r.get("n") or 0),
                    "q": r.get("q") or "",
                    "m": r.get("m"),
                    "sp": r.get("sp"),
                    "d": r.get("d") or "",
                }
                for r in out
            ],
        }


class RecallStore:
    """Thread-safe mtime-cached loader for ``samples-<product>.json`` + ``labels-<product>.json``."""

    def __init__(self, max_products: int = 2):
        self._lock = threading.Lock()
        self._prod_locks: dict[str, threading.Lock] = {}
        self._cache: dict[str, RecallEntry] = {}
        self._max = max_products

    def _lock_for(self, product: str) -> threading.Lock:
        with self._lock:
            lock = self._prod_locks.get(product)
            if lock is None:
                lock = threading.Lock()
                self._prod_locks[product] = lock
            return lock

    def get(self, static_dir: str, product: str) -> RecallEntry | None:
        samples_path = os.path.join(static_dir, f"samples-{product}.json")
        labels_path = os.path.join(static_dir, f"labels-{product}.json")
        try:
            st = os.stat(samples_path)
        except OSError:
            return None
        try:
            lst = os.stat(labels_path)
            lkey = (lst.st_mtime_ns, lst.st_size)
        except OSError:
            lkey = (0, 0)
        key = (static_dir, st.st_mtime_ns, st.st_size, lkey[0], lkey[1])

        with self._lock:
            hit = self._cache.get(product)
            if hit is not None and hit.key == key:
                return hit

        with self._lock_for(product):
            with self._lock:
                hit = self._cache.get(product)
                if hit is not None and hit.key == key:
                    return hit
            try:
                with open(samples_path, encoding="utf-8") as fh:
                    payload = json.load(fh)
            except (OSError, ValueError):
                return None
            if lkey[1] > 0:
                try:
                    with open(labels_path, encoding="utf-8") as fh:
                        labels = (json.load(fh) or {}).get("labels") or []
                    rows = ((payload.get("products") or {}).get(product) or {}).get("rows") or []
                    for i, label in enumerate(labels):
                        if label and i < len(rows):
                            rows[i]["lb"] = label
                except (OSError, ValueError):
                    pass
            etag = f'"rc-{st.st_mtime_ns:x}-{st.st_size:x}-{lkey[0]:x}"'
            entry = RecallEntry(product, key, etag, payload)
            with self._lock:
                if len(self._cache) >= self._max and product not in self._cache:
                    self._cache.clear()
                self._cache[product] = entry
            return entry

    def clear(self) -> None:
        with self._lock:
            self._cache.clear()
