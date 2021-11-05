# Using Proxy Server with PyGithub

[PyGithub](https://github.com/PyGithub/PyGithub) is a Python library to access the GitHub REST API.

To use with the proxy server, you need to use a custom `baseUrl`. For example, replace

```python
g = Github("{access_token}")
```

with

```python
g = Github(base_url="http://{hostname}:{port}")
```

where hostname and port refer to the proxy server. For example: http://localhost:3000.