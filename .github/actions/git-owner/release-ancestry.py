import math
import os
import re
import subprocess
import time

from ci_git_owner import FetchTimeout, GitFailure, backoff, cleanup_seconds, git_output, run_git


source_local_ref = "refs/remotes/origin/release-ancestry-source"
target_local_ref = "refs/remotes/origin/release-ancestry-target"
deepen_chunks = (128, 256, 512, 1024, 2048)
max_total_seconds = 120
max_fetch_seconds = 30
max_fetch_attempts = 3
retry_backoff_seconds = 2


class TotalBudgetExpired(Exception):
    pass


def parse_inputs():
    mode = os.environ.get("RELEASE_ANCESTRY_MODE", "")
    target_ref = os.environ.get("RELEASE_ANCESTRY_TARGET_REF", "")
    try:
        total_seconds = float(os.environ.get("RELEASE_ANCESTRY_TOTAL_SECONDS", ""))
    except ValueError:
        total_seconds = 0
    if mode not in ("merge-base", "ancestor"):
        print("::error::Release ancestry mode must be merge-base or ancestor.", flush=True)
        return None
    if (
        not math.isfinite(total_seconds)
        or total_seconds <= 0
        or total_seconds > max_total_seconds
    ):
        print("::error::Release ancestry total budget must be at most 120 seconds.", flush=True)
        return None
    if not target_ref.startswith("refs/heads/"):
        print("::error::Release ancestry target must be a branch ref.", flush=True)
        return None
    return mode, target_ref, total_seconds


def operation_timeout(deadline, maximum=None):
    seconds = deadline - time.monotonic() - cleanup_seconds
    if seconds <= 0:
        raise TotalBudgetExpired()
    return min(seconds, maximum) if maximum is not None else seconds


def git_test(workspace, deadline, *arguments):
    try:
        run_git(
            workspace,
            *arguments,
            timeout=operation_timeout(deadline),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return True
    except GitFailure as error:
        if error.code != 1:
            raise
        return False


def resolve_commit(workspace, deadline, ref):
    value = git_output(
        workspace,
        "rev-parse",
        "--verify",
        f"{ref}^{{commit}}",
        timeout=operation_timeout(deadline),
    ).strip()
    if not re.fullmatch("[0-9a-f]{40}", value):
        raise RuntimeError("Git returned an invalid commit")
    return value


def fetch_history(workspace, deadline, source_sha, target, depth_argument):
    for attempt in range(1, max_fetch_attempts + 1):
        try:
            run_git(
                workspace,
                "-c",
                "protocol.version=2",
                "fetch",
                "--atomic",
                "--no-tags",
                "--no-recurse-submodules",
                "--filter=blob:none",
                depth_argument,
                "origin",
                f"+{source_sha}:{source_local_ref}",
                target,
                timeout=operation_timeout(deadline, max_fetch_seconds),
                reclaim_locks=True,
            )
            return
        except (FetchTimeout, GitFailure):
            if attempt == max_fetch_attempts:
                raise
            print(
                f"::warning::Release ancestry fetch failed on attempt {attempt}; retrying.",
                flush=True,
            )
            if operation_timeout(deadline) < retry_backoff_seconds:
                raise TotalBudgetExpired()
            backoff(retry_backoff_seconds)


def relationship_holds(workspace, deadline, mode, source_sha, target_sha):
    arguments = (
        ("merge-base", source_sha, target_sha)
        if mode == "merge-base"
        else ("merge-base", "--is-ancestor", source_sha, target_sha)
    )
    return git_test(workspace, deadline, *arguments)


def repository_is_shallow(workspace, deadline):
    value = git_output(
        workspace,
        "rev-parse",
        "--is-shallow-repository",
        timeout=operation_timeout(deadline),
    ).strip()
    if value not in ("true", "false"):
        raise RuntimeError("Git returned an invalid shallow-repository state")
    return value == "true"


def reachable_commit_count(workspace, deadline, source_sha, target_sha):
    value = git_output(
        workspace,
        "rev-list",
        "--count",
        source_sha,
        target_sha,
        timeout=operation_timeout(deadline),
    ).strip()
    if not value.isdigit():
        raise RuntimeError("Git returned an invalid reachable commit count")
    return int(value)


def establish_ancestry():
    inputs = parse_inputs()
    if inputs is None:
        return 2
    mode, target_ref, total_seconds = inputs
    workspace = os.getcwd()
    deadline = time.monotonic() + total_seconds

    if not git_test(workspace, deadline, "check-ref-format", target_ref):
        print("::error::Release ancestry target must be a valid branch ref.", flush=True)
        return 2
    source_sha = resolve_commit(workspace, deadline, "HEAD")
    fetch_history(
        workspace,
        deadline,
        source_sha,
        f"+{target_ref}:{target_local_ref}",
        "--depth=64",
    )
    target_sha = resolve_commit(workspace, deadline, target_local_ref)

    if relationship_holds(workspace, deadline, mode, source_sha, target_sha):
        print(f"Established release {mode} relationship with {target_sha}.", flush=True)
        return 0
    if not repository_is_shallow(workspace, deadline):
        print(
            f"::error::Release {mode} relationship with {target_sha} is invalid after complete history.",
            flush=True,
        )
        return 1

    previous_count = reachable_commit_count(workspace, deadline, source_sha, target_sha)
    chunk_index = 0
    while True:
        chunk = deepen_chunks[min(chunk_index, len(deepen_chunks) - 1)]
        fetch_history(
            workspace,
            deadline,
            source_sha,
            f"+{target_sha}:{target_local_ref}",
            f"--deepen={chunk}",
        )
        current_count = reachable_commit_count(workspace, deadline, source_sha, target_sha)
        if current_count <= previous_count:
            print("::error::Release ancestry fetch completed without ancestry progress.", flush=True)
            return 125
        if relationship_holds(workspace, deadline, mode, source_sha, target_sha):
            print(f"Established release {mode} relationship with {target_sha}.", flush=True)
            return 0
        if not repository_is_shallow(workspace, deadline):
            print(
                f"::error::Release {mode} relationship with {target_sha} is invalid after complete history.",
                flush=True,
            )
            return 1
        previous_count = current_count
        chunk_index += 1


try:
    raise SystemExit(establish_ancestry())
except TotalBudgetExpired:
    print("::error::Release ancestry exceeded its total time budget.", flush=True)
    raise SystemExit(124)
