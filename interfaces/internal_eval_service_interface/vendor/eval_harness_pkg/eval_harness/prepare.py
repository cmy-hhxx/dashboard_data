"""Data cleaning and preparation pipeline for eval_harness_pkg.

Cleans raw JSONL (plain, .gz, or .zst; single file or directory):
  1. Strips UTF-8 BOM/CRLF and drops blank lines.
  2. Splits multi-trace session lines into one trace per line (optional).
  3. Repairs missing user questions for v2_observations traces from meta.question
     or message_pool (while preserving lf_plugin_v2 captured questions intact).
  4. Infers missing batch_id from date-prefixed filenames or default_batch_id.
  5. Validates every record with the bundled evaluator's exact admission rules
     and optionally applies lossless prompt-snapshot slimming.
"""

from __future__ import annotations

import copy
import gzip
import io
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Iterator

from .config import EvalConfig, load_config
from .runner import EvalRunError, bundle_dir, check_node_runtime

_LEADING_STAMP = re.compile(r"^\[\d{4}-\d{2}-\d{2}T[^\]]{1,40}\]\s*")
_DATE_FILENAME = re.compile(r"^(\d{4}-\d{2}-\d{2})(?:$|[-_])")


def _content_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(_content_text(item) for item in value if isinstance(item, (str, dict)))
    if isinstance(value, dict):
        text = value.get("text")
        return "" if text is None else str(text)
    return ""


def _structured_question(content: Any) -> bool:
    if isinstance(content, dict):
        return (
            isinstance(content.get("query"), str)
            and bool(content["query"].strip())
            and isinstance(content.get("datajson"), str)
            and isinstance(content.get("contentConfigComefrom"), str)
        )
    if isinstance(content, list) and content:
        return all(
            isinstance(item, dict)
            and isinstance(item.get("header"), str)
            and isinstance(item.get("selected"), list)
            and all(isinstance(v, str) for v in item["selected"])
            for item in content
        )
    return False


def _has_question(content: Any) -> bool:
    if _structured_question(content):
        return True
    target = content[:1] if isinstance(content, list) else content
    return bool(_content_text(target).strip())


def _last_user_content(messages: list[Any]) -> Any:
    for msg in reversed(messages):
        if not isinstance(msg, dict):
            continue
        if msg.get("role") == "user" or (msg.get("role") is None and msg.get("type") == "user_question"):
            return msg.get("content")
    return None


def _meta_question(row: dict[str, Any], trace: dict[str, Any]) -> str | None:
    for source in (trace.get("meta"), row.get("meta")):
        if not isinstance(source, dict):
            continue
        text = source.get("question")
        if isinstance(text, str) and text.strip():
            return text.strip()
    return None


def _pooled_question(trace: dict[str, Any]) -> dict[str, Any] | None:
    pool = trace.get("message_pool")
    if not isinstance(pool, list):
        return None
    for msg in reversed(pool):
        if not isinstance(msg, dict) or msg.get("role") != "user":
            continue
        content = msg.get("content")
        if not _has_question(content):
            continue
        if isinstance(content, str):
            content = _LEADING_STAMP.sub("", content)
            if not content.strip():
                continue
        return {"role": "user", "type": "user_question", "content": content}
    return None


def repair_question_in_row(row: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    """Recover missing user_question from meta.question or message_pool when safe.

    Records collected by `lf_plugin_v2` are left untouched so the evaluator's
    non-mutating captured-question coordinate resolver handles them directly.
    """
    meta = row.get("meta") if isinstance(row.get("meta"), dict) else {}
    if meta.get("fetched_by") == "lf_plugin_v2":
        return row, False

    is_session = isinstance(row.get("traces"), list)
    traces = row["traces"] if is_session else [row]
    fixed: dict[str, Any] | None = None

    for idx, trace in enumerate(traces):
        if not isinstance(trace, dict):
            return row, False
        messages = trace.get("messages")
        if not isinstance(messages, list) or not messages:
            return row, False
        content = _last_user_content(messages)
        if content is not None and _has_question(content):
            continue
        q_text = _meta_question(row, trace)
        recovered = {"role": "user", "type": "user_question", "content": q_text} if q_text else _pooled_question(trace)
        if not recovered:
            return row, False
        if fixed is None:
            fixed = copy.deepcopy(row)
        target = fixed["traces"][idx] if is_session else fixed
        if content is None:
            target["messages"] = [recovered] + target["messages"]
        else:
            for msg in reversed(target["messages"]):
                if not isinstance(msg, dict):
                    continue
                if msg.get("role") == "user" or (msg.get("role") is None and msg.get("type") == "user_question"):
                    msg["content"] = recovered["content"]
                    break
    return (fixed, True) if fixed is not None else (row, False)


def _discover_raw_files(source: Path) -> list[Path]:
    if source.is_file():
        return [source]
    if not source.is_dir():
        raise FileNotFoundError(f"Prepare raw_input not found: {source}")
    files = sorted(
        p for p in source.rglob("*")
        if p.is_file() and (p.name.endswith(".jsonl") or p.name.endswith(".jsonl.gz") or p.name.endswith(".jsonl.zst"))
    )
    if not files:
        raise FileNotFoundError(f"No .jsonl / .jsonl.gz / .jsonl.zst files found under: {source}")
    return files


def _iter_raw_lines(file: Path) -> Iterator[bytes]:
    name = file.name.lower()
    if name.endswith(".gz"):
        with gzip.open(file, "rb") as handle:
            yield from handle
        return
    if name.endswith(".zst"):
        # Support Python 3.14 stdlib compression.zstd, python-zstandard, or system zstd CLI.
        try:
            from compression import zstd  # type: ignore

            with zstd.open(file, "rb") as handle:
                yield from handle
            return
        except ImportError:
            pass
        try:
            import zstandard  # type: ignore

            with file.open("rb") as raw_handle:
                reader = zstandard.ZstdDecompressor().stream_reader(raw_handle)
                for line in io.BufferedReader(reader):
                    yield line
            return
        except ImportError:
            pass
        zstd_bin = shutil.which("zstd")
        if not zstd_bin:
            raise RuntimeError("Reading .zst requires Python 3.14+, `zstandard`, or the `zstd` CLI")
        proc = subprocess.Popen([zstd_bin, "-dc", str(file)], stdout=subprocess.PIPE)
        assert proc.stdout is not None
        try:
            yield from proc.stdout
        finally:
            proc.stdout.close()
            code = proc.wait()
            if code != 0:
                raise RuntimeError(f"zstd decompression failed for {file} (exit {code})")
        return
    with file.open("rb") as handle:
        yield from handle


def _filename_batch(file: Path) -> str | None:
    stem = file.name
    for suffix in (".jsonl.zst", ".jsonl.gz", ".jsonl"):
        if stem.lower().endswith(suffix):
            stem = stem[: -len(suffix)]
            break
    return stem if _DATE_FILENAME.match(stem) else None


def prepare_eval(
    config: str | Path | dict[str, Any] | EvalConfig,
    *,
    raw_input: str | Path | None = None,
    output: str | Path | None = None,
    audit_output: str | Path | None = None,
    slim: bool | None = None,
    verify_slim: bool | None = None,
    fail_on_reject: bool | None = None,
) -> dict[str, Any]:
    """Clean, repair, slim, and validate raw JSONL into evaluation-ready JSONL."""
    cfg = config if isinstance(config, EvalConfig) else load_config(config, require_api=False)
    prep = cfg.prepare

    source_path = Path(raw_input).expanduser().resolve() if raw_input is not None else prep.raw_input
    if source_path is None:
        raise ValueError("Missing raw input path: set prepare.raw_input in config.yaml or pass --raw-input")
    target_path = Path(output).expanduser().resolve() if output is not None else (prep.output or cfg.input_path)
    audit_path = Path(audit_output).expanduser().resolve() if audit_output is not None else prep.audit_output
    if source_path == target_path:
        raise ValueError("prepare raw_input and output must be different paths")

    node_bin = check_node_runtime()
    engine = bundle_dir() / "engine.mjs"
    if not engine.is_file():
        raise FileNotFoundError(f"Bundled evaluation engine missing: {engine}")

    raw_files = _discover_raw_files(source_path)
    do_slim = prep.slim if slim is None else slim
    do_verify = prep.verify_slim if verify_slim is None else verify_slim
    do_fail_on_reject = prep.fail_on_reject if fail_on_reject is None else fail_on_reject

    repaired_count = 0
    split_count = 0
    raw_lines = 0

    with tempfile.TemporaryDirectory(prefix="eval-prepare-") as tmp_dir:
        tmp = Path(tmp_dir)
        staged_input = tmp / "staged.jsonl"
        spec_file = tmp / "prepare-spec.json"

        with staged_input.open("wb") as sink:
            for file in raw_files:
                file_batch = _filename_batch(file)
                for idx, raw_bytes in enumerate(_iter_raw_lines(file), 1):
                    raw_lines += 1
                    if idx == 1 and raw_bytes.startswith(b"\xef\xbb\xbf"):
                        raw_bytes = raw_bytes[3:]
                    stripped = raw_bytes.rstrip(b"\r\n")
                    if not stripped.strip():
                        continue
                    try:
                        text = stripped.decode("utf-8")
                        row = json.loads(text)
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        # Pass broken lines through so the TS validator classifies & logs exact reasons.
                        sink.write(stripped + b"\n")
                        continue
                    if not isinstance(row, dict):
                        sink.write(stripped + b"\n")
                        continue

                    candidates = [row]
                    if prep.split_traces and isinstance(row.get("traces"), list) and len(row["traces"]) > 1:
                        split_count += len(row["traces"]) - 1
                        candidates = [{**row, "traces": [trace]} for trace in row["traces"]]

                    for item in candidates:
                        changed = False
                        if prep.repair_question:
                            item, repaired = repair_question_in_row(item)
                            if repaired:
                                repaired_count += 1
                                changed = True
                        meta = item.get("meta") if isinstance(item.get("meta"), dict) else {}
                        if file_batch and not item.get("batch_id") and not meta.get("batch_id"):
                            item = {**item, "batch_id": file_batch}
                            changed = True
                        if changed or len(candidates) > 1:
                            sink.write(json.dumps(item, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n")
                        else:
                            sink.write(stripped + b"\n")

        spec = {
            "input": str(staged_input),
            "output": str(target_path),
            **({"audit_output": str(audit_path)} if audit_path else {}),
            "slim": do_slim,
            "verify_slim": do_verify,
            "default_batch_id": prep.default_batch_id,
            "version": prep.version,
            "max_message_bytes": prep.max_message_bytes,
            "max_line_bytes": prep.max_line_bytes,
            "fail_on_reject": do_fail_on_reject,
        }
        spec_file.write_text(json.dumps(spec, ensure_ascii=False), encoding="utf-8")

        proc = subprocess.run(
            [node_bin, str(engine), "prepare", "--spec", str(spec_file)],
            capture_output=True,
            text=True,
        )
        if proc.returncode not in (0, 2):
            raise EvalRunError(proc.stderr.strip() or proc.stdout.strip() or f"prepare failed with exit {proc.returncode}", proc.returncode)
        report = json.loads(proc.stdout)
        report["raw_files"] = len(raw_files)
        report["raw_lines"] = raw_lines
        report["repaired_questions"] = repaired_count
        report["split_extra_traces"] = split_count
        if proc.returncode == 2:
            raise EvalRunError(
                f"Prepared with {report['rejected']} rejected case(s); inspect audit output or fix input",
                returncode=2,
                summary=report,
            )
        return report
