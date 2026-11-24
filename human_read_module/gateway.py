"""OpenAI-compatible HTTP client for the internal AI gateway (stdlib only, zero extra deps)."""
from __future__ import annotations

import json
import re
import threading
import time
import urllib.error
import urllib.request
from typing import Any

from .config import GatewayConfig
from .runtime_config import is_paused, live_target_rpm

FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)
RETRY_AFTER_RE = re.compile(r"Try again in\s+(\d+(?:\.\d+)?)\s*s", re.IGNORECASE)

# Shared adaptive 429 cooldown + smooth token-bucket RPM pacer across threads
_COOLDOWN_LOCK = threading.Lock()
_COOLDOWN_UNTIL = 0.0
_PACE_LOCK = threading.Lock()
_NEXT_SLOT = 0.0


def _acquire_rate_slot(fallback_rpm: int):
    """Smoothly space outgoing requests using hot-reloaded target_rpm & pause flag."""
    global _NEXT_SLOT
    while is_paused():
        time.sleep(2.0)
    target_rpm = live_target_rpm(fallback_rpm)
    if target_rpm <= 0:
        return
    interval = 60.0 / float(target_rpm)
    with _PACE_LOCK:
        now = time.monotonic()
        if _NEXT_SLOT < now:
            _NEXT_SLOT = now
        slot = _NEXT_SLOT
        _NEXT_SLOT += interval
    wait = slot - time.monotonic()
    if wait > 0:
        time.sleep(wait)


def _wait_if_cooling_down():
    with _COOLDOWN_LOCK:
        until = _COOLDOWN_UNTIL
    now = time.monotonic()
    if until > now:
        time.sleep(until - now)


def _trigger_cooldown(seconds: float):
    global _COOLDOWN_UNTIL
    target = time.monotonic() + seconds
    with _COOLDOWN_LOCK:
        if target > _COOLDOWN_UNTIL:
            _COOLDOWN_UNTIL = target


def parse_json_response(text: str) -> Any:
    """Parse strict JSON from an LLM reply, tolerating optional markdown code fences."""
    s = (text or "").strip()
    if not s:
        raise ValueError("Empty model response")
    if s.startswith("```"):
        s = FENCE_RE.sub("", s).strip()
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        # Try extracting the outermost JSON object
        start = s.find("{")
        end = s.rfind("}")
        if start >= 0 and end > start:
            return json.loads(s[start : end + 1])
        raise


class GatewayClient:
    def __init__(self, cfg: GatewayConfig | None = None):
        self.cfg = cfg or GatewayConfig()
        base = self.cfg.base_url.rstrip("/")
        self.url = base if base.endswith("/chat/completions") else f"{base}/v1/chat/completions"

    def chat_json(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> tuple[Any, dict[str, Any]]:
        payload = {
            "model": self.cfg.model,
            "messages": messages,
            "temperature": self.cfg.temperature if temperature is None else temperature,
            "max_tokens": self.cfg.max_tokens if max_tokens is None else max_tokens,
            "response_format": {"type": "json_object"},
        }
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.cfg.api_key}",
        }

        last_err: Exception | None = None
        for attempt in range(self.cfg.max_retries + 1):
            _wait_if_cooling_down()
            _acquire_rate_slot(self.cfg.target_rpm)
            t0 = time.monotonic()
            req = urllib.request.Request(self.url, data=body, headers=headers, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=self.cfg.timeout_s) as resp:
                    raw = resp.read().decode("utf-8")
                data = json.loads(raw)
                choice = (data.get("choices") or [{}])[0]
                content = (choice.get("message") or {}).get("content") or ""
                parsed = parse_json_response(content)
                meta = {
                    "elapsed_s": round(time.monotonic() - t0, 2),
                    "usage": data.get("usage") or {},
                    "model": data.get("model") or self.cfg.model,
                    "finish_reason": choice.get("finish_reason"),
                }
                return parsed, meta
            except urllib.error.HTTPError as exc:
                err_body = ""
                try:
                    err_body = exc.read().decode("utf-8", errors="replace")[:500]
                except Exception:
                    pass
                # If gateway rejects response_format=json_object, drop it and retry immediately
                if exc.code == 400 and "response_format" in err_body and "response_format" in payload:
                    payload.pop("response_format", None)
                    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                    continue
                last_err = RuntimeError(f"HTTP {exc.code}: {err_body}")
                if exc.code in (429, 500, 502, 503, 504) and attempt < self.cfg.max_retries:
                    if exc.code == 429:
                        m_ra = RETRY_AFTER_RE.search(err_body)
                        hint_s = float(m_ra.group(1)) if m_ra else 5.0
                        cd_s = min(65.0, max(5.0, hint_s + 2.0))
                        _trigger_cooldown(cd_s)
                        delay = min(65.0, max(cd_s, 4.0 * (attempt + 1)))
                    else:
                        delay = min(20.0, 1.5 * (2 ** attempt))
                    time.sleep(delay)
                    continue
                raise last_err from exc
            except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
                last_err = exc
                if attempt < self.cfg.max_retries:
                    time.sleep(min(15.0, 1.5 * (2 ** attempt)))
                    continue
                raise RuntimeError(f"Gateway request failed after retries: {exc}") from exc

        raise RuntimeError(f"Gateway request failed: {last_err}")
