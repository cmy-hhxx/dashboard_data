"""Mounts for the standalone version-compare page (A/B sample recall).

``/compare/...`` (and the ``/compare_details/...`` alias) render the dashboard's
compare view straight on a selected round/pair, with the test-set picker, model
filters and same-question list hidden.  The matrix's A/B drawer deep-links here.
"""
from __future__ import annotations

import sys
from pathlib import Path

PARENT = Path(__file__).resolve().parent.parent
if str(PARENT) not in sys.path:
    sys.path.insert(0, str(PARENT))

from page_proxy import mount, redirect  # noqa: E402

COMPARE_PREFIXES = ("/compare", "/compare_details")


def handle(handler):
    """Consume ``/compare`` and ``/compare_details`` requests; return False otherwise."""
    return any(mount(handler, prefix, "view=compare&compare=1") for prefix in COMPARE_PREFIXES)


def redirect_root(handler):
    """Standalone mode: bare ``/`` is the compare page shell."""
    redirect(handler, "%s/?view=compare&compare=1" % COMPARE_PREFIXES[0].lstrip("/"))
