"""Per-key locks with a fixed footprint.

A long-running server builds details for ~10^5 distinct keys; one lock object per
key kept forever is a slow leak.  Hashing keys onto a fixed set of locks bounds
memory, and two keys only share a lock (and wait for each other) by collision.
"""
import threading


class KeyedLocks:
    def __init__(self, stripes: int = 256):
        self._locks = [threading.Lock() for _ in range(stripes)]

    def __call__(self, key) -> threading.Lock:
        return self._locks[hash(key) % len(self._locks)]
