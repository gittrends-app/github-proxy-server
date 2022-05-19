/* eslint-disable @typescript-eslint/no-explicit-any */
import { omit } from 'lodash';
import { Db } from 'mongodb';

type PlainData = Record<string, any>;

export async function users(users: PlainData | PlainData[], opts: { db: Db }) {
  const records = (Array.isArray(users) ? users : [users]).filter((data) => !!data);

  await opts.db.collection('users').bulkWrite(
    records.map((user) => ({
      replaceOne: {
        filter: { _id: user.id },
        replacement: {
          _id: user.id,
          login: user.login,
          avatar_url: user.avatar_url,
          gravatar_id: user.gravatar_id,
          type: user.type,
          site_admin: user.site_admin
        },
        upsert: true
      }
    }))
  );
}

export async function repository(repo: PlainData | PlainData[], opts: { db: Db }) {
  const records = Array.isArray(repo) ? repo : [repo];

  await Promise.all([
    users(
      records.map((repo) => repo.owner).filter((owner) => !!owner),
      { db: opts.db }
    ),
    opts.db.collection('repositories').bulkWrite(
      records.map((repo) => {
        return {
          replaceOne: {
            filter: { _id: repo.id },
            replacement: omit({ ...repo, owner: repo.owner?.id }, 'id'),
            upsert: true
          }
        };
      })
    )
  ]);
}

type PlainIssue = Record<string, any> & { repository: number };

export async function issues(issues: PlainIssue | PlainIssue[], opts: { db: Db }) {
  const records = (Array.isArray(issues) ? issues : [issues]).filter((data) => !!data);
  if (!records.length) return;

  await users(
    records
      .reduce(
        (memo, issue) => memo.concat([issue.user, issue.assignee, ...issue.assignees]),
        [] as Array<any>
      )
      .filter((issue) => !!issue),
    { db: opts.db }
  );

  await opts.db.collection('issues').bulkWrite(
    records.map((issue) => ({
      replaceOne: {
        filter: { _id: issue.id },
        replacement: {
          _id: issue.id,
          number: issue.number,
          title: issue.title,
          user: issue.user?.id,
          labels: issue.labels?.map((label: { name: string }) => label.name),
          state: issue.state,
          locked: issue.locked,
          assignee: issue.assignee?.id,
          assignees: issue.assignees?.map(({ id }: { id: number }) => id),
          comments: issue.comments,
          created_at: issue.created_at && new Date(issue.created_at),
          updated_at: issue.updated_at && new Date(issue.updated_at),
          closed_at: issue.closed_at && new Date(issue.closed_at),
          author_association: issue.author_association,
          active_lock_reason: issue.active_lock_reason,
          draft: issue.draft,
          body: issue.body,
          performed_via_github_app: issue.performed_via_github_app,
          pull_request: issue.pull_request !== undefined,
          merged_at: issue.pull_request?.merged_at,
          repository: issue.repository
        },
        upsert: true
      }
    }))
  );
}

type PlainRelease = Record<string, any> & { repository: number };

export async function releases(releases: PlainRelease | PlainRelease[], opts: { db: Db }) {
  const records = (Array.isArray(releases) ? releases : [releases]).filter((data) => !!data);
  if (!records.length) return;

  await Promise.all([
    users(
      records.map((r) => r.author),
      { db: opts.db }
    ),
    opts.db.collection('releases').bulkWrite(
      records.map((release) => ({
        replaceOne: {
          filter: { _id: release.id },
          replacement: {
            _id: release.id,
            author: release.author?.id,
            tag_name: release.tag_name,
            target_commitish: release.target_commitish,
            name: release.name,
            draft: release.draft,
            prerelease: release.prerelease,
            created_at: release.created_at && new Date(release.created_at),
            published_at: release.published_at && new Date(release.published_at),
            body: release.body,
            repository: release.repository
          },
          upsert: true
        }
      }))
    )
  ]);
}

type PlainTag = Record<string, any> & { repository: number };

export async function tags(tags: PlainTag | PlainTag[], opts: { db: Db }) {
  const records = (Array.isArray(tags) ? tags : [tags]).filter((data) => !!data);
  if (!records.length) return;

  await opts.db.collection('tags').bulkWrite(
    records.map((tag) => ({
      replaceOne: {
        filter: { _id: { name: tag.name, repository: tag.repository } },
        replacement: { commit_sha: tag.commit?.sha },
        upsert: true
      }
    }))
  );
}

type PlainStargazer = Record<string, any> & { repository: number };

export async function stargazers(stargazers: PlainStargazer | PlainStargazer[], opts: { db: Db }) {
  const records = (Array.isArray(stargazers) ? stargazers : [stargazers]).filter((data) => !!data);
  if (!records.length) return;

  await Promise.all([
    users(
      records.map((r) => r.user),
      { db: opts.db }
    ),
    opts.db.collection('stargazers').bulkWrite(
      records.map((stargazer) => {
        return {
          replaceOne: {
            filter: {
              _id: {
                repository: stargazer.repository,
                user: stargazer.user?.id,
                starred_at: stargazer.starred_at
              }
            },
            replacement: {},
            upsert: true
          }
        };
      })
    )
  ]);
}

type PlainWatcher = { user: Record<string, any>; repository: number };

export async function watchers(watchers: PlainWatcher | PlainWatcher[], opts: { db: Db }) {
  const records = (Array.isArray(watchers) ? watchers : [watchers]).filter((data) => !!data);
  if (!records.length) return;

  await Promise.all([
    users(
      records.map((r) => r.user),
      { db: opts.db }
    ),
    opts.db.collection('watchers').bulkWrite(
      records.map((watcher) => ({
        replaceOne: {
          filter: { _id: { user: watcher.user?.id, repository: watcher.repository } },
          replacement: { _id: { user: watcher.user?.id, repository: watcher.repository } },
          upsert: true
        }
      }))
    )
  ]);
}
