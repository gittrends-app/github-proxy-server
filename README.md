# GitHub Proxy Server

GitHub Proxy Server is a tool to support researchers make a lot of requests to GitHub API (REST or GraphQL).

In summary, it allows use multiple access tokens and synchronizes the requests to not inflict the GitHub API usage policy.

## Installation

Use the package manager [npm](https://www.npmjs.com/) to install locally.

```bash
npm install -g @hsborges/github-proxy-server
```

## Usage

To use this tool you need to provide at least one GitHub access token:

```bash
github-proxy-server -p 8080 -t <access_token>
```

Or you can provide a file with several access token (one per line):

```bash
github-proxy-server -p 8080 --tokens <tokens.txt>
```

After that, just make the requests to http://localhost:8080 instead of https://api.github.com. For example:

```bash
curl -s http://localhost:8080/users/hsborges 2>&1
```

To more usage information, use the option `--help`.

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.

## License

[MIT](https://choosealicense.com/licenses/mit/)
