"""Exercise release transactions against an isolated local bare Git remote."""

import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from release import bump_version, plan_release


PLUGIN = "oh-my-pi-useful-skills"
CATALOG = ".omp-plugin/marketplace.json"


def git(path, *args):
    return subprocess.run(
        ["git", "-C", str(path), *args],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


class ReleaseTransactionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.origin = self.root / "origin.git"
        self.checkout = self.root / "checkout"
        git(self.root, "init", "--bare", "--initial-branch=main", str(self.origin))
        git(self.root, "clone", str(self.origin), str(self.checkout))
        (self.checkout / "package.json").write_text(
            '{\n  "name": "release-fixture",\n  "version": "1.0.0",\n  "private": true\n}\n',
            encoding="utf-8",
        )
        (self.checkout / ".omp-plugin").mkdir()
        (self.checkout / CATALOG).write_text(
            json.dumps(
                {
                    "name": "omp-useful-skills",
                    "plugins": [
                        {
                            "name": PLUGIN,
                            "version": "1.0.0",
                            "source": {
                                "source": "github",
                                "repo": "MSpiechowicz/harness-useful-skills",
                                "ref": "v1.0.0",
                            },
                        }
                    ],
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        self.commit(self.checkout, "Initial source")
        git(self.checkout, "push", "origin", "main")
        self.source = git(self.checkout, "rev-parse", "HEAD")

    def commit(self, checkout, message):
        git(checkout, "add", ".")
        git(
            checkout,
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            message,
        )

    def fresh_checkout(self, name):
        path = self.root / name
        git(self.root, "clone", str(self.origin), str(path))
        git(path, "checkout", "--detach", self.source)
        return path

    def test_publish_links_package_marketplace_and_tag_and_retry_reuses_transaction(self):
        result = plan_release(self.checkout, self.source, push=True)
        commit = git(self.origin, "rev-parse", "refs/tags/v1.0.1")
        self.assertEqual(commit, git(self.origin, "rev-parse", "refs/heads/main"))
        self.assertEqual(git(self.origin, "show", "-s", "--format=%P", commit), self.source)
        self.assertEqual(json.loads(git(self.origin, "show", f"{commit}:package.json"))["version"], "1.0.1")
        catalog = json.loads(git(self.origin, "show", f"{commit}:{CATALOG}"))
        self.assertEqual(catalog["name"], "omp-useful-skills")
        self.assertEqual(catalog["plugins"][0]["name"], PLUGIN)
        self.assertEqual(catalog["plugins"][0]["source"]["source"], "github")
        self.assertEqual(catalog["plugins"][0]["source"]["repo"], "MSpiechowicz/harness-useful-skills")
        self.assertEqual(catalog["plugins"][0]["version"], "1.0.1")
        self.assertEqual(catalog["plugins"][0]["source"]["ref"], "v1.0.1")

        retry = plan_release(self.fresh_checkout("retry"), self.source, push=True)
        self.assertTrue(retry["reused"])
        self.assertEqual(retry["commit"], result["commit"])
        self.assertEqual(git(self.origin, "tag", "--list"), "v1.0.1")

    def test_stale_source_never_publishes_over_new_main(self):
        newer = self.fresh_checkout("newer")
        (newer / "change.txt").write_text("New source\n", encoding="utf-8")
        self.commit(newer, "New source")
        git(newer, "push", "origin", "HEAD:main")
        head = git(self.origin, "rev-parse", "refs/heads/main")

        result = plan_release(self.checkout, self.source, push=True)

        self.assertTrue(result["skipped"])
        self.assertEqual(git(self.origin, "rev-parse", "refs/heads/main"), head)
        self.assertEqual(git(self.origin, "tag", "--list"), "")

    def test_matching_tag_can_resume_github_publication_after_main_advances(self):
        result = plan_release(self.checkout, self.source, push=True)
        newer = self.fresh_checkout("newer")
        git(newer, "checkout", "--detach", "origin/main")
        (newer / "change.txt").write_text("New source\n", encoding="utf-8")
        self.commit(newer, "New source")
        git(newer, "push", "origin", "HEAD:main")

        retry = plan_release(self.fresh_checkout("retry"), self.source, push=True)

        self.assertTrue(retry["reused"])
        self.assertTrue(retry["mainAdvanced"])
        self.assertEqual(retry["commit"], result["commit"])

    def test_existing_unrelated_tag_is_never_reused_or_overwritten(self):
        git(self.checkout, "-c", "tag.gpgsign=false", "tag", "v1.0.1")
        git(self.checkout, "push", "origin", "refs/tags/v1.0.1")

        with self.assertRaises(ValueError):
            plan_release(self.checkout, self.source, push=True)

        self.assertEqual(git(self.origin, "rev-parse", "refs/heads/main"), self.source)
        self.assertEqual(git(self.origin, "rev-parse", "refs/tags/v1.0.1"), self.source)

    def test_atomic_push_rejection_leaves_main_and_remote_tags_unchanged(self):
        hook = self.origin / "hooks" / "update"
        hook.write_text(
            "#!/bin/sh\ncase \"$1\" in refs/tags/*) exit 1 ;; esac\nexit 0\n",
            encoding="utf-8",
        )
        hook.chmod(0o755)

        with self.assertRaises(subprocess.CalledProcessError):
            plan_release(self.checkout, self.source, push=True)

        self.assertEqual(git(self.origin, "rev-parse", "refs/heads/main"), self.source)
        self.assertEqual(git(self.origin, "tag", "--list"), "")

    def test_mismatched_marketplace_metadata_fails_before_creating_refs(self):
        catalog = json.loads((self.checkout / CATALOG).read_text(encoding="utf-8"))
        catalog["plugins"][0]["source"]["ref"] = "v9.9.9"
        (self.checkout / CATALOG).write_text(json.dumps(catalog) + "\n", encoding="utf-8")
        self.commit(self.checkout, "Break marketplace metadata")
        git(self.checkout, "push", "origin", "main")
        source = git(self.checkout, "rev-parse", "HEAD")

        with self.assertRaisesRegex(ValueError, "Marketplace version and source ref"):
            plan_release(self.checkout, source, push=True)

        self.assertEqual(git(self.origin, "rev-parse", "refs/heads/main"), source)
        self.assertEqual(git(self.origin, "tag", "--list"), "")

    def test_bump_resets_lower_components_and_rejects_unstable_versions(self):
        self.assertEqual(bump_version("3.9.8", "minor"), "3.10.0")
        self.assertEqual(bump_version("3.9.8", "major"), "4.0.0")
        with self.assertRaises(ValueError):
            bump_version("3.9.8-rc.1", "patch")
        with self.assertRaises(ValueError):
            bump_version("03.9.8", "patch")


if __name__ == "__main__":
    unittest.main()
