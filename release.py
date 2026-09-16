"""Create immutable, resumable releases from a tested main revision.

The default mode is a dry-run.  ``--push`` is intended for the GitHub Actions
checkout, where ``--source`` identifies the revision that passed CI.
"""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys

VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
CATALOG = ".omp-plugin/marketplace.json"
PLUGIN = "oh-my-pi-useful-skills"


def git(repo, *args):
    """Run Git in *repo* without exposing authenticated remote URLs on failure."""
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=90,
    ).stdout.rstrip("\n")


def bump_version(version, bump):
    """Return the requested stable semantic-version increment."""
    match = VERSION.fullmatch(version)
    if match is None:
        raise ValueError("package.json version must be stable MAJOR.MINOR.PATCH")
    major, minor, patch = map(int, match.groups())
    if bump == "major":
        return f"{major + 1}.0.0"
    if bump == "minor":
        return f"{major}.{minor + 1}.0"
    if bump == "patch":
        return f"{major}.{minor}.{patch + 1}"
    raise ValueError("Unknown version bump")


def catalog_for(repo, source, current_version, version):
    """Load and update the sole marketplace entry from the tested source."""
    catalog = json.loads(git(repo, "show", f"{source}:{CATALOG}"))
    plugins = [plugin for plugin in catalog["plugins"] if plugin["name"] == PLUGIN]
    if len(plugins) != 1:
        raise ValueError("Marketplace must contain exactly one useful-skills plugin")
    plugin = plugins[0]
    if plugin["version"] != current_version or plugin["source"]["ref"] != f"v{current_version}":
        raise ValueError("Marketplace version and source ref must match package.json")
    plugin["version"] = version
    plugin["source"]["ref"] = f"v{version}"
    return catalog


def is_matching_release(repo, source, metadata, catalog, version, message, commit):
    """Whether an existing tag is the exact transaction this invocation resumes."""
    try:
        parents = git(repo, "show", "-s", "--format=%P", commit)
        released = json.loads(git(repo, "show", f"{commit}:package.json"))
        released_catalog = json.loads(git(repo, "show", f"{commit}:{CATALOG}"))
    except (KeyError, json.JSONDecodeError, subprocess.SubprocessError):
        return False
    changed = git(repo, "diff-tree", "--no-commit-id", "--name-only", "-r", commit).splitlines()
    return (
        parents == source
        and git(repo, "show", "-s", "--format=%B", commit) == message
        and changed == [CATALOG, "package.json"]
        and released == dict(metadata, version=version)
        and released_catalog == catalog
    )


def plan_release(repo, source, bump="patch", push=False):
    """Plan or atomically publish one release from ``source``.

    A tag that exactly matches this metadata transaction is reused so a rerun
    after a GitHub Release API failure can finish publication without another
    version bump.  A source that is merely stale never creates refs.
    """
    repo = Path(repo).resolve()
    if not re.fullmatch(r"[0-9a-f]{40}", source):
        raise ValueError("Source must be a full commit SHA")
    if git(repo, "status", "--porcelain", "--untracked-files=all"):
        raise ValueError("Release checkout must be clean")
    if git(repo, "rev-parse", "HEAD") != source:
        raise ValueError("Release checkout must be at the workflow source SHA")

    git(
        repo,
        "fetch",
        "--no-recurse-submodules",
        "origin",
        "+refs/heads/main:refs/remotes/origin/main",
        "refs/tags/*:refs/tags/*",
    )
    remote_head = git(repo, "rev-parse", "refs/remotes/origin/main")
    metadata = json.loads(git(repo, "show", f"{source}:package.json"))
    version = bump_version(metadata["version"], bump)
    catalog = catalog_for(repo, source, metadata["version"], version)
    tag = f"v{version}"
    message = f"chore(release): {tag}\n\nRelease-Source: {source}\nRelease-Bump: {bump}"

    if git(repo, "tag", "--list", tag):
        commit = git(repo, "rev-parse", f"refs/tags/{tag}^{{commit}}")
        if not is_matching_release(repo, source, metadata, catalog, version, message, commit):
            raise ValueError(f"Tag {tag} already exists and is not this release")
        # GitHub Release creation is independent from a later main commit.  The
        # immutable tag proves this source was already atomically published.
        return {
            "skipped": False,
            "version": version,
            "tag": tag,
            "commit": commit,
            "reused": True,
            "mainAdvanced": remote_head != commit,
        }

    if remote_head != source:
        return {"skipped": True, "reason": "main advanced; stale run"}

    requested = tuple(map(int, version.split(".")))
    for existing in git(repo, "tag", "--list", "v*").splitlines():
        match = VERSION.fullmatch(existing[1:])
        if match and tuple(map(int, match.groups())) >= requested:
            raise ValueError(f"New version {version} must exceed existing tag {existing}")

    result = {"skipped": False, "version": version, "tag": tag, "reused": False}
    if not push:
        return result

    package = repo / "package.json"
    package_text = package.read_text(encoding="utf-8")
    updated, count = re.subn(
        r'("version"\s*:\s*")' + re.escape(metadata["version"]) + r'(")',
        lambda match: match[1] + version + match[2],
        package_text,
    )
    if count != 1:
        raise ValueError("package.json must contain exactly one version field")
    package.write_text(updated, encoding="utf-8")
    (repo / CATALOG).write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")
    git(repo, "add", "--", "package.json", CATALOG)
    git(
        repo,
        "-c",
        "user.name=github-actions[bot]",
        "-c",
        "user.email=41898282+github-actions[bot]@users.noreply.github.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        message,
    )
    commit = git(repo, "rev-parse", "HEAD")
    git(repo, "-c", "tag.gpgsign=false", "tag", tag, commit)
    # No force-push: Git rejects both refs if either main or the tag changed.
    git(repo, "push", "--atomic", "origin", f"{commit}:refs/heads/main", f"refs/tags/{tag}:refs/tags/{tag}")
    result["commit"] = commit
    return result


def gh(repository, *args):
    """Run the GitHub CLI with captured output for deliberate error handling."""
    return subprocess.run(
        ["gh", *args],
        env={**os.environ, "GH_REPO": repository},
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=90,
    )


def publish_release(repository, tag):
    """Create generated GitHub release notes, preserving an existing stable release."""
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("Repository must be owner/name")
    if not re.fullmatch(r"v" + VERSION.pattern, tag):
        raise ValueError("Tag must be vMAJOR.MINOR.PATCH")
    if not (os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")):
        raise ValueError("GITHUB_TOKEN or GH_TOKEN is required to publish a GitHub Release")

    existing = gh(repository, "api", f"repos/{repository}/releases/tags/{tag}")
    if existing.returncode == 0:
        release = json.loads(existing.stdout)
        if release.get("draft") or release.get("prerelease"):
            raise ValueError(f"{tag} already has a draft or prerelease; resolve it manually")
        return release["html_url"]
    if not re.search(r"(?:HTTP )?404(?:\D|$)", existing.stderr):
        raise ValueError("GitHub release lookup failed; check gh authentication and repository access")

    created = gh(repository, "release", "create", tag, "--title", tag, "--generate-notes")
    if created.returncode:
        raise ValueError("GitHub release creation failed; rerun the workflow to resume")
    released = gh(repository, "api", f"repos/{repository}/releases/tags/{tag}")
    if released.returncode:
        raise ValueError("GitHub release was created but could not be read; rerun the workflow to resume")
    return json.loads(released.stdout)["html_url"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=".", help="Disposable checkout with an origin remote")
    parser.add_argument("--source", required=True, help="Full tested workflow commit SHA")
    parser.add_argument("--bump", choices=("patch", "minor", "major"), default="patch")
    parser.add_argument("--push", action="store_true", help="Commit, tag, and atomically push origin/main")
    parser.add_argument("--github-release", action="store_true", help="Publish generated GitHub release notes after push")
    parser.add_argument("--repository", default=os.environ.get("GITHUB_REPOSITORY", ""))
    args = parser.parse_args()
    if args.github_release and (not args.push or not args.repository):
        parser.error("--github-release requires --push and --repository (or GITHUB_REPOSITORY)")
    try:
        result = plan_release(args.repo, args.source, args.bump, args.push)
        if args.github_release and not result["skipped"]:
            result["releaseUrl"] = publish_release(args.repository, result["tag"])
        print(json.dumps(result))
        return 0
    except (ValueError, KeyError, OSError, json.JSONDecodeError, subprocess.SubprocessError) as error:
        if isinstance(error, subprocess.CalledProcessError):
            text = f"Git command failed (exit {error.returncode}); check branch/tag rules and whether main advanced"
        elif isinstance(error, subprocess.TimeoutExpired):
            text = "GitHub or Git command timed out; rerun in a fresh checkout"
        else:
            text = str(error)
        print(f"Release failed: {text}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
