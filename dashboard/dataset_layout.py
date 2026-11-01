"""Resolve the current datasets tree layout.

Canonical output location is ``1_aime/eval_output/demo_data/<model>/`` with
``<model>_attribution-<date>.jsonl`` files.  Older snapshots may still live in
the legacy ``eval_output/<split>/...`` tree or under ``.archive/``; resolve
each artefact independently (demo -> legacy -> archive) so the dashboard keeps
working while the data tree migrates.
"""
import os


def datasets_root():
    """Use an explicit root, the mounted production tree, or local datasets/."""
    override = os.environ.get("EVAL_DATASETS")
    if override:
        return os.path.abspath(os.path.expanduser(override))
    production = "/mnt/fin_bench/code_and_clean_data/datasets"
    if os.path.isdir(production):
        return production
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "datasets")


def first_dir(*paths):
    for path in paths:
        if path and os.path.isdir(path):
            return path
    return None


def first_file(*paths):
    for path in paths:
        if path and os.path.isfile(path):
            return path
    return None


def is_under(path, root):
    path = os.path.abspath(path)
    root = os.path.abspath(root)
    try:
        return os.path.commonpath([path, root]) == root
    except ValueError:
        return False


def wencai_output_dir(datasets):
    return first_dir(
        f"{datasets}/0_wencai/eval_output/demo_data",
        f"{datasets}/0_wencai/eval_output/0_daily_eval_output",
        f"{datasets}/0_wencai/.archive/0_daily_eval_output",
        f"{datasets}/0_wencai/.archive/eval_output/0_daily_eval_output",
    )


def aime_group_dirs(datasets):
    """AIME output roots keyed by group: demo_data is the daily canonical."""
    daily = first_dir(
        f"{datasets}/1_aime/eval_output/demo_data",
        f"{datasets}/1_aime/eval_output/0_daily_eval_output",
        f"{datasets}/1_aime/.archive/eval_output/0_daily_eval_output",
    )
    lost = first_dir(
        f"{datasets}/1_aime/eval_output/1_lost_user_eval_output",
        f"{datasets}/1_aime/.archive/eval_output/1_lost_user_eval_output",
    )
    return [(name, path) for name, path in (("daily", daily), ("lost", lost)) if path]


def aime_input_dirs(datasets):
    return {
        "daily": f"{datasets}/1_aime/eval_input/0_daily_eval_input",
        "lost": first_dir(
            f"{datasets}/1_aime/eval_input/1_lost_user_eval",
            f"{datasets}/1_aime/eval_input/1_lost_user_input",
        ),
    }


def wencai_cluster(datasets):
    root = wencai_output_dir(datasets)
    return first_file(
        f"{root}/a_fast/cluster/cluster_tree.json" if root else None,
        f"{datasets}/0_wencai/eval_output/0_daily_eval_output/a_fast/cluster/cluster_tree.json",
        f"{datasets}/0_wencai/.archive/0_daily_eval_output/a_fast/cluster/cluster_tree.json",
        f"{datasets}/0_wencai/.archive/eval_output/0_daily_eval_output/a_fast/cluster/cluster_tree.json",
    )


def aime_clusters(datasets):
    return {
        "daily": first_file(
            f"{datasets}/1_aime/eval_output/demo_data/aime_fast/cluster/cluster_tree.json",
            f"{datasets}/1_aime/eval_output/0_daily_eval_output/aime_fast/cluster/cluster_tree.json",
            f"{datasets}/1_aime/.archive/eval_output/0_daily_eval_output/aime_fast/cluster/cluster_tree.json",
        ),
        "lost": first_file(
            f"{datasets}/1_aime/eval_output/1_lost_user_eval_output/aime_fast/cluster/cluster_tree.json",
            f"{datasets}/1_aime/.archive/eval_output/1_lost_user_eval_output/aime_fast/cluster/cluster_tree.json",
        ),
    }
