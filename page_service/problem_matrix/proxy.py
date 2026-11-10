"""Mounts for the standalone cluster-matrix page.

``/matrix/...`` is the dashboard data view collapsed to the matrix card;
``/dashboard/...`` stays available for filtered sample lists and other jumps
that the matrix cannot express as a single sample.
"""
from __future__ import annotations

import sys
from pathlib import Path

PARENT = Path(__file__).resolve().parent.parent
if str(PARENT) not in sys.path:
    sys.path.insert(0, str(PARENT))

from page_proxy import mount, redirect  # noqa: E402

MATRIX_PREFIX = "/matrix"
DASHBOARD_PREFIX = "/dashboard"


def handle(handler):
    """Consume ``/matrix`` and ``/dashboard`` requests; return False for everything else."""
    return mount(handler, MATRIX_PREFIX, "matrix=1") or mount(handler, DASHBOARD_PREFIX)


def redirect_root(handler):
    """Standalone mode: bare ``/`` is the matrix page."""
    redirect(handler, "%s/?matrix=1" % MATRIX_PREFIX.lstrip("/"))
