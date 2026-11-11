#!/usr/bin/env python3
"""Remove consumed Actions artifacts. Dry-run by default; never downloads their contents."""

import argparse
import json
import os
import subprocess
import time
from datetime import UTC, datetime, timedelta


def gh(*args):
    return subprocess.check_output(["gh", *args], text=True)


def pages(endpoint):
    return json.loads(gh("api", "--paginate", "--slurp", endpoint))


def timestamp(value):
    return datetime.fromisoformat(value)


def select_artifacts(artifacts, active_runs, latest_main, now):
    """Return (delete, keep), failing closed around consumers and useful diagnostics."""
    recent = now - timedelta(minutes=10)
    # The deployment workflow can start just after its CI completion event. Keep the race
    # window, and keep every dist while any deployment is queued/running/waiting.
    deploying = any(run["name"] == "deploy" for run in active_runs)
    active_ids = {run["id"] for run in active_runs}
    transfers = ("wasm", "dist", "release-bundle")
    prefixes = ("release-files-", "project-io-")
    diagnostic_ids = {}
    for artifact in artifacts:
        name = artifact["name"]
        if (
            name not in transfers
            and not name.startswith(prefixes)
            and not artifact["expired"]
        ):
            previous = diagnostic_ids.get(name)
            if previous is None or timestamp(artifact["created_at"]) > timestamp(
                previous["created_at"]
            ):
                diagnostic_ids[name] = artifact
    diagnostics = {artifact["id"] for artifact in diagnostic_ids.values()}
    delete, keep = [], []
    for artifact in artifacts:
        run_id = artifact.get("workflow_run", {}).get("id")
        protected = (
            artifact["expired"]
            or not run_id
            or run_id in active_ids
            or timestamp(artifact["created_at"]) >= recent
            or artifact["id"] in diagnostics
            or (artifact["name"] == "dist" and (deploying or run_id == latest_main))
        )
        (keep if protected else delete).append(artifact)
    return delete, keep


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo",
        default=os.environ.get("GH_REPO"),
        required=not os.environ.get("GH_REPO"),
    )
    parser.add_argument(
        "--apply", action="store_true", help="Delete the selected obsolete artifacts"
    )
    parser.add_argument(
        "--wait-for-rate-reset",
        action="store_true",
        help="For the initial backlog only: wait instead of stopping at the API reserve",
    )
    args = parser.parse_args()
    repo = args.repo
    artifacts = [
        a
        for page in pages(f"repos/{repo}/actions/artifacts?per_page=100")
        for a in page["artifacts"]
    ]
    active = []
    for status in ("queued", "in_progress", "waiting", "requested", "pending"):
        active.extend(
            run
            for page in pages(f"repos/{repo}/actions/runs?status={status}&per_page=100")
            for run in page["workflow_runs"]
        )
    # This must succeed before any deletion; never guess the deployment source on API failure.
    green = json.loads(
        gh(
            "run",
            "list",
            "--repo",
            repo,
            "--workflow",
            "ci.yml",
            "--branch",
            "main",
            "--event",
            "push",
            "--status",
            "success",
            "--limit",
            "1",
            "--json",
            "databaseId",
        )
    )
    if not green:
        raise SystemExit(
            "No successful main CI run found; refusing cleanup without a deployable source"
        )
    delete, keep = select_artifacts(
        artifacts, active, green[0]["databaseId"], datetime.now(UTC)
    )
    report = {
        "apply": args.apply,
        "before_bytes": sum(a["size_in_bytes"] for a in artifacts if not a["expired"]),
        "delete_count": len(delete),
        "delete_bytes": sum(a["size_in_bytes"] for a in delete),
        "keep_bytes": sum(a["size_in_bytes"] for a in keep if not a["expired"]),
        "keep": [
            {
                "id": a["id"],
                "name": a["name"],
                "run": a.get("workflow_run", {}).get("id"),
                "bytes": a["size_in_bytes"],
            }
            for a in keep
            if not a["expired"]
        ],
    }
    print(json.dumps(report, indent=2), flush=True)
    if args.apply:
        checked_runs = {}
        for index, artifact in enumerate(delete, 1):
            if (index - 1) % 50 == 0:
                while True:
                    budget = json.loads(gh("api", "rate_limit"))["resources"]["core"]
                    if budget["remaining"] >= 300:
                        break
                    if not args.wait_for_rate_reset:
                        raise SystemExit(
                            "API reserve reached; cleanup is partial. A later completion can continue it."
                        )
                    delay = min(60, max(1, budget["reset"] - time.time() + 1))
                    print(
                        f"Preserving API reserve; waiting {delay:.0f}s for rate reset",
                        flush=True,
                    )
                    time.sleep(delay)
            # Recheck the artifact's run immediately before mutation. A manually rerun workflow
            # may have become active after the initial inventory; its artifacts must survive.
            run_id = artifact["workflow_run"]["id"]
            if run_id not in checked_runs:
                checked_runs[run_id] = json.loads(
                    gh("api", f"repos/{repo}/actions/runs/{run_id}")
                )
            if checked_runs[run_id]["status"] != "completed":
                print(f"Preserved active run {run_id}", flush=True)
                continue
            gh(
                "api",
                "-X",
                "DELETE",
                f"repos/{repo}/actions/artifacts/{artifact['id']}",
            )
            if index % 100 == 0:
                print(f"Deleted {index}/{len(delete)} selected artifacts", flush=True)


if __name__ == "__main__":
    main()
