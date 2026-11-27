"""Append-Only Multi-Frame Zstd (.jsonl.zst) Pack Engine.

Protocol (1 record = 1 Zstd frame):
- Every JSONL record (`json_bytes + b"\\n"`) is compressed as an independent
  Zstd frame with checksum + content size enabled.
- Concatenated frames form a 100% standard `.jsonl.zst` stream (`zstd -dc`
  outputs plain JSONL with zero special tooling).
- Random access reads any single record in O(1) via `os.pread(fd, length, offset)`
  with zero read amplification.
- Sequential tail scanning (`iter_frames`) decodes exact frame boundaries from
  any committed byte offset, enabling idempotent `reconcile_tails()` recovery
  after a PostgreSQL crash or PITR rollback.
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

import zstandard as zstd

import json as _stdlib_json

try:
    import orjson

    def _sanitize_utf8(obj: Any) -> Any:
        if isinstance(obj, str):
            return obj.replace("\x00", "").encode("utf-8", errors="replace").decode("utf-8")
        if isinstance(obj, list):
            return [_sanitize_utf8(x) for x in obj]
        if isinstance(obj, dict):
            return {_sanitize_utf8(k): _sanitize_utf8(v) for k, v in obj.items()}
        return obj

    def json_dumps_bytes(obj: Any) -> bytes:
        try:
            return orjson.dumps(obj)
        except (TypeError, ValueError):
            return _stdlib_json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8", errors="replace")

    def json_loads_bytes(raw: bytes) -> Any:
        try:
            return orjson.loads(raw)
        except ValueError:
            # Fallback for legacy lines containing NaN/Infinity or lone UTF-16 surrogates
            return _sanitize_utf8(_stdlib_json.loads(raw.decode("utf-8", errors="replace")))

except ImportError:

    def json_dumps_bytes(obj: Any) -> bytes:
        return _stdlib_json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8", errors="replace")

    def json_loads_bytes(raw: bytes) -> Any:
        return _stdlib_json.loads(raw.decode("utf-8", errors="replace"))


ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"


@dataclass(frozen=True, slots=True)
class FramePointer:
    rel_path: str
    offset: int
    length: int
    raw_bytes: int


@dataclass(frozen=True, slots=True)
class ScannedFrame:
    offset: int
    length: int
    raw_bytes: int
    payload: bytes


def make_compressor(level: int = 6) -> zstd.ZstdCompressor:
    return zstd.ZstdCompressor(level=level, write_checksum=True, write_content_size=True)


def compress_record_line(
    record: dict[str, Any] | bytes,
    *,
    cctx: zstd.ZstdCompressor | None = None,
    level: int = 6,
) -> tuple[bytes, int]:
    """Encode a dict or raw JSON line bytes into one self-contained Zstd frame."""
    if isinstance(record, bytes):
        raw = record if record.endswith(b"\n") else record + b"\n"
    else:
        raw = json_dumps_bytes(record) + b"\n"
    comp = cctx or make_compressor(level)
    frame = comp.compress(raw)
    return frame, len(raw)


def decompress_frame(frame_bytes: bytes, *, dctx: zstd.ZstdDecompressor | None = None) -> bytes:
    dec = dctx or zstd.ZstdDecompressor()
    return dec.decompress(frame_bytes)


def pread_frame(path: Path, offset: int, length: int, *, dctx: zstd.ZstdDecompressor | None = None) -> bytes:
    """O(1) random read of a single Zstd frame via POSIX pread."""
    fd = os.open(str(path), os.O_RDONLY)
    try:
        chunks = []
        remaining = length
        pos = offset
        while remaining > 0:
            chunk = os.pread(fd, remaining, pos)
            if not chunk:
                raise EOFError(f"Truncated Zstd frame in {path} at offset={offset} len={length}")
            chunks.append(chunk)
            pos += len(chunk)
            remaining -= len(chunk)
        frame = b"".join(chunks) if len(chunks) > 1 else chunks[0]
    finally:
        os.close(fd)
    return decompress_frame(frame, dctx=dctx)


def pread_json(path: Path, offset: int, length: int, *, dctx: zstd.ZstdDecompressor | None = None) -> Any:
    raw = pread_frame(path, offset, length, dctx=dctx)
    return json_loads_bytes(raw)


def iter_frames(
    path: Path,
    *,
    start_offset: int = 0,
    chunk_size: int = 1 << 20,
    ignore_truncated_tail: bool = True,
) -> Iterator[ScannedFrame]:
    """Yield every valid Zstd frame starting at `start_offset` with exact byte bounds.

    Uses `decompressobj().eof` + `unused_data` so frame boundaries are exact
    regardless of payload contents. If a crash left an incomplete trailing frame
    and `ignore_truncated_tail=True`, stops cleanly at the last valid frame.
    """
    dctx = zstd.ZstdDecompressor()
    file_size = path.stat().st_size
    if start_offset >= file_size:
        return

    with path.open("rb") as fh:
        fh.seek(start_offset)
        buf = b""
        buf_file_pos = start_offset
        eof_reached = False

        while True:
            if not buf and not eof_reached:
                data = fh.read(chunk_size)
                if not data:
                    eof_reached = True
                    break
                buf = data

            if not buf:
                break

            frame_start = buf_file_pos
            if len(buf) >= 4 and buf[:4] != ZSTD_MAGIC:
                if ignore_truncated_tail:
                    break
                raise zstd.ZstdError(f"Invalid Zstd magic at {path}:{frame_start}")

            dobj = dctx.decompressobj()
            out_chunks: list[bytes] = []
            consumed_total = 0

            try:
                while True:
                    if not buf:
                        data = fh.read(chunk_size)
                        if not data:
                            eof_reached = True
                            break
                        buf = data
                    in_len = len(buf)
                    out = dobj.decompress(buf)
                    if out:
                        out_chunks.append(out)
                    if dobj.eof:
                        unused = dobj.unused_data
                        consumed = in_len - len(unused)
                        consumed_total += consumed
                        buf_file_pos += consumed
                        buf = unused
                        break
                    consumed_total += in_len
                    buf_file_pos += in_len
                    buf = b""
            except zstd.ZstdError:
                if ignore_truncated_tail:
                    break
                raise

            if not dobj.eof:
                if ignore_truncated_tail:
                    break
                raise EOFError(f"Incomplete Zstd frame in {path} at offset={frame_start}")

            payload = b"".join(out_chunks) if len(out_chunks) > 1 else (out_chunks[0] if out_chunks else b"")
            yield ScannedFrame(
                offset=frame_start,
                length=consumed_total,
                raw_bytes=len(payload),
                payload=payload,
            )


def append_frame_file(path: Path, frame_bytes: bytes, *, fsync: bool = True) -> tuple[int, int]:
    """Blob-First append of one Zstd frame to `path`. Returns `(offset, length)`.

    Caller must serialize writers per file (e.g. via Data Core single-writer
    lock) so CephFS append offsets remain strictly deterministic.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT, 0o644)
    try:
        offset = os.lseek(fd, 0, os.SEEK_END)
        view = memoryview(frame_bytes)
        written = 0
        total = len(frame_bytes)
        while written < total:
            n = os.write(fd, view[written:])
            if n <= 0:
                raise OSError(f"Short write to {path}")
            written += n
        if fsync:
            os.fsync(fd)
        return offset, total
    finally:
        os.close(fd)


class BulkPackWriter:
    """High-throughput buffered multi-frame Zstd writer for offline ETL."""

    def __init__(self, path: Path, rel_path: str, *, level: int = 6, buffer_bytes: int = 4 << 20):
        self.path = path
        self.rel_path = rel_path
        self.level = level
        self.cctx = make_compressor(level)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = self.path.open("wb", buffering=buffer_bytes)
        self.committed_bytes = 0
        self.uncompressed_bytes = 0
        self.record_count = 0
        self._sha256 = hashlib.sha256()

    def write_record(self, record: dict[str, Any] | bytes) -> FramePointer:
        frame, raw_len = compress_record_line(record, cctx=self.cctx)
        offset = self.committed_bytes
        self._fh.write(frame)
        self._sha256.update(frame)
        self.committed_bytes += len(frame)
        self.uncompressed_bytes += raw_len
        self.record_count += 1
        return FramePointer(
            rel_path=self.rel_path,
            offset=offset,
            length=len(frame),
            raw_bytes=raw_len,
        )

    def close(self, *, fsync: bool = True) -> str:
        self._fh.flush()
        if fsync:
            os.fsync(self._fh.fileno())
        self._fh.close()
        return self._sha256.hexdigest()

    def __enter__(self) -> "BulkPackWriter":
        return self

    def __exit__(self, *_exc) -> None:
        if not self._fh.closed:
            self.close()


def daily_input_rel_path(model: str, biz_day: str, part_no: int) -> str:
    yyyy, mm, dd = biz_day.split("-")
    return f"eval_input/{model}/{yyyy}/{mm}{dd}/part_{part_no:04d}.jsonl.zst"


def daily_output_rel_path(model: str, biz_day: str, kind: str, part_no: int) -> str:
    yyyy, mm, dd = biz_day.split("-")
    return f"eval_output/{model}/{yyyy}/{mm}{dd}/{kind}_part_{part_no:04d}.jsonl.zst"


def ab_candidate_rel_path(model: str, year: str, round_dir: str, candidate_key: str, kind: str) -> str:
    return f"ab_test/{model}/{year}/{round_dir}/{candidate_key}/{kind}.jsonl.zst"


def reference_rel_path(year: str, part_no: int) -> str:
    return f"references/{year}/part_{part_no:04d}.jsonl.zst"
