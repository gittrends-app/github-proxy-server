# Using Proxy Server with PyGithub

[PyGithub](https://github.com/PyGithub/PyGithub) is a Python library to access the GitHub REST API.

To use it with the proxy server, configure a custom `base_url` and authenticate with a
token. With modern PyGithub 2.x, use:

```python
from github import Auth, Github

g = Github(auth=Auth.Token(token), base_url="http://127.0.0.1:3000")
```

## Pagination smoke test

`pagination-smoke.py` is a smoke test for the proxy. It consumes multiple pull requests
and labels with a one-item page size, checking the pagination behavior from Issue #18.
Start the proxy, install the sample dependencies, and run:

```bash
python -m pip install -r samples/pygithub/requirements.txt
export GITHUB_TOKEN=your-github-token
python samples/pygithub/pagination-smoke.py
```

The test uses `http://127.0.0.1:3000` and `django/django` by default. Override them with:

```bash
export GITHUB_PROXY_BASE_URL=http://127.0.0.1:3000
export GITHUB_REPOSITORY=django/django
```

With the current transparent proxy, this test reproduces Issue #18 and exits with
`AssertionError: api.github.com`: PyGithub follows API URLs embedded in response bodies,
which still point to GitHub. `GPS_EXTERNAL_BASE_URL` only rewrites `Link` headers and does
not change this result.
