import { Octokit } from '@octokit/core';
import { paginateRest } from '@octokit/plugin-paginate-rest';
import { restEndpointMethods } from '@octokit/plugin-rest-endpoint-methods';
import { EventEmitter } from 'stream';

const PaginatedOctokit = Octokit.plugin(paginateRest, restEndpointMethods);

export default class GitHubApp extends EventEmitter {
  private static INSTANCE_ID = 0;

  private requestId = 0;
  private octokit;
  private instance_id = (GitHubApp.INSTANCE_ID += 1);

  constructor(token: string, baseUrl = process.env.GH_GITHUB_URL) {
    super();

    this.octokit = new PaginatedOctokit({ auth: token, baseUrl, throttle: {} });

    this.octokit.hook.wrap('request', async (request, options) => {
      const requestId = ++this.requestId;
      const startedAt = Date.now();
      const data = await request(options);
      const finishedAt = Date.now();

      this.emit('response', {
        instance_id: this.instance_id,
        request_id: requestId,
        url: data.url,
        status: data.status,
        started_at: startedAt,
        finished_at: finishedAt,
        duration: finishedAt - startedAt
      });

      return data;
    });
  }

  search(query: string) {
    return this.octokit.paginate.iterator(this.octokit.rest.search.repos, {
      q: query,
      sort: 'stars',
      order: 'desc',
      per_page: 100
    });
  }

  issues(owner: string, repo: string) {
    return this.octokit.paginate.iterator(this.octokit.rest.issues.listForRepo, {
      owner,
      repo,
      direction: 'asc',
      sort: 'created',
      state: 'all',
      per_page: 100
    });
  }

  releases(owner: string, repo: string) {
    return this.octokit.paginate.iterator(this.octokit.rest.repos.listReleases, {
      owner,
      repo,
      direction: 'asc',
      sort: 'created',
      state: 'all',
      per_page: 100
    });
  }

  tags(owner: string, repo: string) {
    return this.octokit.paginate.iterator(this.octokit.rest.repos.listTags, {
      owner,
      repo,
      direction: 'asc',
      sort: 'created',
      state: 'all',
      per_page: 100
    });
  }

  stargazers(owner: string, repo: string) {
    return this.octokit.paginate.iterator(this.octokit.rest.activity.listStargazersForRepo, {
      owner,
      repo,
      per_page: 100,
      headers: { accept: 'application/vnd.github.v3.star+json' }
    });
  }

  watchers(owner: string, repo: string) {
    return this.octokit.paginate.iterator(this.octokit.rest.activity.listWatchersForRepo, {
      owner,
      repo,
      per_page: 100
    });
  }
}
