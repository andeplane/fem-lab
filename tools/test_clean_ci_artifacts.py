import importlib.util
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "cleanup", Path(__file__).with_name("clean-ci-artifacts.py")
)
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)
NOW = datetime(2026, 11, 11, 12, tzinfo=UTC)


def artifact(identifier, name="wasm", run=10, age=60):
    return {
        "id": identifier,
        "name": name,
        "workflow_run": {"id": run},
        "expired": False,
        "created_at": (NOW - timedelta(minutes=age)).isoformat(),
        "size_in_bytes": 100,
    }


class ArtifactPolicy(unittest.TestCase):
    def select(self, artifacts, active=()):
        delete, keep = cleanup.select_artifacts(artifacts, active, 20, NOW)
        return {a["id"] for a in delete}, {a["id"] for a in keep}

    def test_consumed_transfer_and_release_intermediates_are_removed(self):
        names = [
            "wasm",
            "dist",
            "release-bundle",
            "release-files-web",
            "project-io-linux",
        ]
        self.assertEqual(
            self.select([artifact(i, name) for i, name in enumerate(names)]),
            (set(range(len(names))), set()),
        )

    def test_active_runs_and_event_delivery_window_survive(self):
        artifacts = [artifact(1, run=30), artifact(2, age=3), artifact(3)]
        self.assertEqual(
            self.select(artifacts, [{"id": 30, "name": "release"}]), ({3}, {1, 2})
        )

    def test_latest_deployable_dist_survives_even_after_a_new_failed_ci_run(self):
        self.assertEqual(
            self.select([artifact(1, "dist", 20), artifact(2, "dist", 21)]), ({2}, {1})
        )

    def test_every_dist_survives_while_deployment_is_active(self):
        active = [{"id": 100, "name": "deploy"}]
        self.assertEqual(
            self.select([artifact(1, "dist"), artifact(2)], active), ({2}, {1})
        )

    def test_latest_diagnostic_for_each_name_survives(self):
        artifacts = [
            artifact(1, "playwright-report", age=120),
            artifact(2, "playwright-report"),
            artifact(3, "gpu-coverage-detail"),
            artifact(4, "unrecognized-evidence"),
        ]
        self.assertEqual(self.select(artifacts), ({1}, {2, 3, 4}))

    def test_unknown_run_and_expired_artifact_are_left_alone(self):
        unknown = artifact(1)
        unknown.pop("workflow_run")
        expired = artifact(2)
        expired["expired"] = True
        self.assertEqual(self.select([unknown, expired]), (set(), {1, 2}))

    def test_missing_green_source_refuses_to_delete_anything(self):
        with (
            patch.object(
                cleanup, "pages", return_value=[{"artifacts": [], "workflow_runs": []}]
            ),
            patch.object(cleanup, "gh", return_value="[]") as gh,
            patch("sys.argv", ["cleanup", "--repo", "owner/repo", "--apply"]),
        ):
            with self.assertRaisesRegex(SystemExit, "refusing cleanup"):
                cleanup.main()
            self.assertFalse(any("DELETE" in call.args for call in gh.call_args_list))

    def test_api_failure_aborts_before_mutation(self):
        with (
            patch.object(cleanup, "pages", side_effect=RuntimeError("API unavailable")),
            patch.object(cleanup, "gh") as gh,
            patch("sys.argv", ["cleanup", "--repo", "owner/repo", "--apply"]),
        ):
            with self.assertRaisesRegex(RuntimeError, "API unavailable"):
                cleanup.main()
            gh.assert_not_called()


if __name__ == "__main__":
    unittest.main()
