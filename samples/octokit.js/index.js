const { Octokit } = require("octokit");

(async () => {
  const octokit = new Octokit({ baseUrl: "http://127.0.0.1:3000" });
  const { data: repo } = await octokit.rest.repos.get({ owner: "hsborges", repo: "github-proxy-server" });
  console.log(repo);
})();
