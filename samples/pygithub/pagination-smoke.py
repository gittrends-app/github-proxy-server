#!/usr/bin/env python3
"""Smoke-test PyGithub pagination through the local GitHub proxy."""

# Author: Hudson S. Borges

import os
import sys
from itertools import islice
from importlib.metadata import PackageNotFoundError, version
from typing import Iterable, TypeVar

import github
from github import Auth, Github
from github.GithubException import GithubException


T = TypeVar("T")


def _take_two(items: Iterable[T], resource_name: str, repository: str) -> list[T]:
    """Consume two items, ensuring that the paginated request has useful data."""
    result = list(islice(items, 2))
    if len(result) < 2:
        raise RuntimeError(
            f"{repository} returned only {len(result)} {resource_name}; expected at least 2"
        )
    return result


def _redact(value: str, token: str) -> str:
    """Return text without exposing the configured token."""
    return value.replace(token, "[REDACTED]")


def _safe_error(error: Exception, token: str) -> str:
    """Return an error string without exposing the configured token."""
    return _redact(str(error), token)


def _package_version() -> str:
    """Return the installed PyGithub distribution version."""
    try:
        return version("PyGithub")
    except PackageNotFoundError:
        return "unknown"


def main() -> int:
    """Run the pagination smoke test and return a process exit status."""
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        print("Usage error: set GITHUB_TOKEN before running this smoke test", file=sys.stderr)
        return 2

    base_url = os.environ.get("GITHUB_PROXY_BASE_URL", "http://127.0.0.1:3000")
    repository = os.environ.get("GITHUB_REPOSITORY", "django/django")
    client: Github | None = None

    print(f"PyGithub {_package_version()}")
    print(f"Target: {_redact(base_url, token)} ({_redact(repository, token)})")

    try:
        configured_client = Github(auth=Auth.Token(token), base_url=base_url, per_page=1)
        client = configured_client
        repo = configured_client.get_repo(repository)
        pulls = _take_two(repo.get_pulls(state="all"), "pull requests", repository)
        labels = _take_two(repo.get_labels(), "labels", repository)
        print(f"PASS: consumed {len(pulls)} pull requests and {len(labels)} labels")
        return 0
    except GithubException as error:
        status = getattr(error, "status", "unknown")
        print(f"FAIL: GitHub API error ({status}): {_safe_error(error, token)}", file=sys.stderr)
        return 1
    except Exception as error:
        print(f"FAIL: {_safe_error(error, token)}", file=sys.stderr)
        return 1
    finally:
        if client is not None:
            client.close()


if __name__ == "__main__":
    raise SystemExit(main())
