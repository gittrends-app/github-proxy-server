# Using Proxy Server with Octokit.js

The [Octokit.js](https://github.com/octokit/octokit.js) is the official JavaScript lib and can be used to send requests to GitHub's REST API and queries to GitHub's GraphQL API.

To use with the proxy server, you need to use a custom `baseUrl`. For example, replace

```javascript
const octokit = new Octokit({ auth: "{access_token}" });
```

with

```javascript
const octokit = new Octokit({ baseUrl: "http://{hostname}:{port}" });
```

where hostname and port refer to the proxy server. For example: http://localhost:3000.