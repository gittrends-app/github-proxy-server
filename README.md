# 🖥️ GitHub Proxy Server

[![Build + S3 sync](https://github.com/gittrends-app/github-proxy-server/actions/workflows/build.yml/badge.svg?branch=master)](https://github.com/gittrends-app/github-proxy-server/actions/workflows/build.yml)
[![Coverage Status](https://coveralls.io/repos/github/gittrends-app/github-proxy-server/badge.svg)](https://coveralls.io/github/gittrends-app/github-proxy-server)
[![GitHub version](https://badge.fury.io/gh/gittrends-app%2Fgithub-proxy-server.svg)](https://badge.fury.io/gh/gittrends-app%2Fgithub-proxy-server)
![GitHub](https://img.shields.io/github/license/gittrends-app/github-proxy-server)

<br/>

> GitHub Proxy Server is a tool to support developers and researchers collect massive amount of data from GitHub API (REST or GraphQL) by automatically managing access tokens and client requests to avoid triggering the GitHub API abuse detection mechanisms.

<br/>

**Why should I use it?** GitHub API has a limited number of requests per client and implements several mechanisms to detect user abuses. Thus, users must handle these restrictions in their applications. GitHub Proxy Server is a tool that abstracts these problems by means of a proxy server.

**When should I use it?** This tool is intended to be used by developers and researches that need to perform massive data collection of public repositories using both REST and GraphQL APIs.

**When should I <ins>not</ins> use it?** If you need to deal with private information of users and repositories this tool is not for you (see [limitations section](#limitations)).

**Can I use it with other libs?** Yes, as long they allow the users setup the proxy server as base url (see [samples](samples)).

**How it works?**

<p align="center">
  <img src="architecture.png" alt="GitHub Proxy Server" width="350px"/>
</p>
<p align="center">Proxy Server Architecture</p>

## Features

- Support to multiple access tokens

- Load balancing

- Rate limiter

- Customizable parameters

## Getting Started

First, you need to clone the repository:

```bash
git clone https://github.com/gittrends-app/github-proxy-server.git
```

Then, install dependencies, build files, and run the server:

```bash
yarn install
yarn build
yarn start --help
```

You can also build and run the Docker image directly:

```bash
docker build -t github-proxy-server https://github.com/gittrends-app/github-proxy-server.git#master
docker run --rm -it github-proxy-server --help
```

## Usage

To use this tool you need to provide at least one GitHub access token:

```bash
github-proxy-server -p 3000 -t <access_token>
```

Or provide a file with several access token (one per line):

```bash
github-proxy-server -p 3000 --tokens <tokens.txt>
```

After that, just make the requests to <http://localhost:3000> instead of <https://api.github.com>. For example:

```bash
curl -s http://localhost:3000/users/gittrends-app 2>&1
```

To more usage information, use the option `--help`.

```bash
Usage: index [options]

Options:
  -p, --port [port]            Port to start the proxy server (default: 3000, env: PORT)
  -t, --token [token]          GitHub token to be used (default: [])
  --tokens [file]              File containing a list of tokens (env: GPS_TOKENS_FILE)
  --request-timeout [timeout]  Request timeout (ms) (default: 30000, env: GPS_REQUEST_TIMEOUT)
  --min-remaining <number>     Stop using token on a minimum of (default: 100, env: GPS_MIN_REMAINING)
  --clustering                 (clustering) enable clustering (requires redis) (default: false, env: GPS_CLUSTERING_HOST)
  --clustering-host [host]     (clustering) redis host (default: "localhost", env: GPS_CLUSTERING_HOST)
  --clustering-port [port]     (clustering) redis port (default: 6379, env: GPS_CLUSTERING_PORT)
  --clustering-db [db]         (clustering) redis db (default: 0, env: GPS_CLUSTERING_DB)
  --silent                     Dont show requests outputs
  --no-override-authorization  By default, the authorization header is overrided with a configured token
  --no-status-monitor          Disable requests monitoring on /status
  -v, --version                output the current version
  -h, --help                   display help for command
```

## Limitations

GitHub Proxy Server was primarly intended to be a tool to support massive data collection of public repositories and users. To this purpose, we use a pool of access tokens to proxy requests to GitHub servers. For each request, we select the token with the lowest queue size and with more requests available.

Besides that, **we do not perform any verification on the clients requests, which may implies in security issues for the users who provided their tokens**.

To mitigate this problem, you can ensure that your access tokens are generated using only the necessary scopes (e.g., _public_repo_, _read:user_, etc.).

You may also ensure access to the proxy server only to users that you trust.

## Integrations

As mentioned, this tool can be used with serveral other libraries. You can find several examples in [samples](samples) folder.

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.

## License

[MIT](https://choosealicense.com/licenses/mit/)
