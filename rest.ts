// REST v3 surface (GitHub-compatible) for the forge.
// Auth is enforced by the router before this handler runs; this module only
// routes /api/v3/* and answers per spec-rest.md. No fs, no network, and no
// wall clock in response data (the store's logical clock only).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HandlerCtx } from './httputil.ts';
import type { Issue, Pull, Repo } from './store.ts';
import { VIEWER, nowIso } from './store.ts';
import {
  jsonError,
  parseJsonBody,
  pathOf,
  pathSegments,
  queryOf,
  readBody,
  sendEmpty,
  sendJson,
} from './httputil.ts';

type JsonMap = Record<string, unknown>;

function toRecord(value: unknown): JsonMap | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonMap;
  }
  return null;
}

function toText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Read + parse a JSON request body. Empty body -> {}. Bad JSON -> 'malformed'. */
async function readJsonBody(req: IncomingMessage): Promise<JsonMap | 'malformed'> {
  const buf = await readBody(req);
  const parsed = parseJsonBody(buf);
  if (!parsed.ok) return 'malformed';
  if (parsed.value === undefined) return {};
  return toRecord(parsed.value) ?? {};
}

function pagingOf(q: URLSearchParams): { perPage: number; page: number } {
  let perPage = Number.parseInt(q.get('per_page') ?? '', 10);
  if (!Number.isFinite(perPage) || perPage < 1) perPage = 30;
  if (perPage > 100) perPage = 100;
  let page = Number.parseInt(q.get('page') ?? '', 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  return { perPage, page };
}

function pageSlice<T>(items: T[], perPage: number, page: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

function repoPageUrl(ctx: HandlerCtx, repo: Repo): string {
  return `${ctx.baseUrl}/${repo.owner}/${repo.name}`;
}

function repoShape(ctx: HandlerCtx, repo: Repo): JsonMap {
  const page = repoPageUrl(ctx, repo);
  return {
    id: repo.id, name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private, description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    html_url: page, clone_url: `${page}.git`, git_url: `${page}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    created_at: repo.createdAt, updated_at: repo.updatedAt, pushed_at: repo.updatedAt,
  };
}

function labelShape(label: { name: string; color: string; description?: string }): JsonMap {
  return { name: label.name, color: label.color, description: label.description ?? '' };
}

function issueShape(ctx: HandlerCtx, repo: Repo, issue: Issue): JsonMap {
  const commentCount = ctx.store.listComments(repo, issue.number).length;
  return {
    id: issue.id, number: issue.number,
    title: issue.title, body: issue.body, state: issue.state,
    labels: issue.labels.map(labelShape),
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    created_at: issue.createdAt, updated_at: issue.updatedAt,
    html_url: `${repoPageUrl(ctx, repo)}/issues/${issue.number}`,
    url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: commentCount,
  };
}

function pullShape(ctx: HandlerCtx, repo: Repo, pr: Pull): JsonMap {
  return {
    id: pr.id, number: pr.number,
    title: pr.title, body: pr.body, state: pr.state,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}` },
    merged: pr.merged, merged_at: pr.mergedAt, merge_commit_sha: pr.mergeCommitSha,
    created_at: pr.createdAt, updated_at: pr.updatedAt,
    html_url: `${repoPageUrl(ctx, repo)}/pull/${pr.number}`,
    url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

function sendNotFound(res: ServerResponse, ctx: HandlerCtx): void {
  jsonError(res, ctx, 404, 'Not Found');
}

function parsePositiveInt(seg: string): number | null {
  const n = Number.parseInt(seg, 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

async function serveRest(req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx, pathname: string): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const segs = pathSegments(pathname).slice(2); // drop ['api', 'v3']
  const q = queryOf(req);

  // 1. GET /api/v3/ and /api/v3
  if (segs.length === 0) {
    if (method !== 'GET') return sendNotFound(res, ctx);
    sendJson(res, ctx, 200, {}, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  // 2. GET /api/v3/meta
  if (segs.length === 1 && segs[0] === 'meta') {
    if (method !== 'GET') return sendNotFound(res, ctx);
    sendJson(res, ctx, 200, { installed_version: '1.0.0' });
    return;
  }

  // 3/4. /user/repos
  if (segs.length === 2 && segs[0] === 'user' && segs[1] === 'repos') {
    if (method === 'POST') {
      const body = await readJsonBody(req);
      if (body === 'malformed') return jsonError(res, ctx, 400, 'Malformed JSON body');
      const name = toText(body.name);
      if (name === undefined || name === '') return jsonError(res, ctx, 422, 'Missing repository name');
      const created = ctx.store.createRepo(name, body.private === true, toText(body.description) ?? '');
      if ('error' in created) return jsonError(res, ctx, 422, 'Repository already exists');
      sendJson(res, ctx, 201, repoShape(ctx, created));
      return;
    }
    if (method === 'GET') {
      const { perPage, page } = pagingOf(q);
      const all = ctx.store.listRepos();
      const headers: Record<string, string> = {};
      if (page * perPage < all.length) {
        headers.link = `<${ctx.baseUrl}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next"`;
      }
      sendJson(res, ctx, 200, pageSlice(all, perPage, page).map((r) => repoShape(ctx, r)), headers);
      return;
    }
    return sendNotFound(res, ctx);
  }

  // 5-25. /repos/{owner}/{name}/...
  if (segs[0] === 'repos' && segs.length >= 3) {
    const owner = segs[1] as string;
    const name = segs[2] as string;
    // getRepo returns undefined for foreign owners -> 404, never 403.
    const repo = ctx.store.getRepo(owner, name);
    if (repo === undefined) return sendNotFound(res, ctx);

    // 5/6/7. Repo CRUD on /repos/{o}/{r}
    if (segs.length === 3) {
      if (method === 'GET') {
        sendJson(res, ctx, 200, repoShape(ctx, repo));
        return;
      }
      if (method === 'PATCH') {
        const body = await readJsonBody(req);
        if (body === 'malformed') return jsonError(res, ctx, 400, 'Malformed JSON body');
        const desc = toText(body.description);
        if (desc !== undefined) {
          repo.description = desc;
          repo.updatedAt = nowIso();
        }
        sendJson(res, ctx, 200, repoShape(ctx, repo));
        return;
      }
      if (method === 'DELETE') {
        ctx.store.deleteRepo(repo);
        sendEmpty(res, ctx, 204);
        return;
      }
      return sendNotFound(res, ctx);
    }

    const sub = segs[3] as string;

    // 8. POST /git/refs ; 9. GET /branches
    if (sub === 'git' && segs.length === 5 && segs[4] === 'refs') {
      if (method !== 'POST') return sendNotFound(res, ctx);
      const body = await readJsonBody(req);
      if (body === 'malformed') return jsonError(res, ctx, 400, 'Malformed JSON body');
      const ref = toText(body.ref);
      const sha = toText(body.sha);
      if (ref === undefined || !ref.startsWith('refs/heads/') || sha === undefined || sha === '') {
        return jsonError(res, ctx, 422, 'Invalid ref or sha');
      }
      const branch = ref.slice('refs/heads/'.length);
      if (!ctx.store.createBranch(repo, branch, sha)) {
        return jsonError(res, ctx, 422, 'Unknown commit sha');
      }
      sendJson(res, ctx, 201, { ref, object: { sha } });
      return;
    }
    if (sub === 'branches' && segs.length === 4) {
      if (method !== 'GET') return sendNotFound(res, ctx);
      sendJson(res, ctx, 200, ctx.store.listBranches(repo).map((b) => ({
        name: b.name,
        commit: { sha: b.sha },
        protected: false,
      })));
      return;
    }

    // 10. GET /commits
    if (sub === 'commits' && segs.length === 4) {
      if (method !== 'GET') return sendNotFound(res, ctx);
      const ref = q.get('sha') ?? undefined;
      const commits = ctx.store.listCommits(repo, ref);
      sendJson(res, ctx, 200, commits.map(({ sha, message }) => {
        const meta = ctx.store.commitMeta(repo, sha);
        const authorDate = meta !== undefined ? new Date(meta.authorTime * 1000).toISOString() : repo.createdAt;
        const committerDate = meta !== undefined ? new Date(meta.committerTime * 1000).toISOString() : repo.createdAt;
        return {
          sha,
          commit: {
            message,
            author: { name: meta?.authorName ?? repo.owner, email: meta?.authorEmail ?? '', date: authorDate },
            committer: { name: meta?.committerName ?? repo.owner, email: meta?.committerEmail ?? '', date: committerDate },
          },
          author: { login: repo.owner },
          committer: { login: repo.owner },
        };
      }));
      return;
    }

    // 11/12/13. Contents
    if (sub === 'contents' && segs.length >= 4) {
      const filePath = segs.slice(4).join('/');
      const ref = q.get('ref') ?? '';
      if (method === 'PUT') {
        const body = await readJsonBody(req);
        if (body === 'malformed') return jsonError(res, ctx, 400, 'Malformed JSON body');
        const branch = toText(body.branch) ?? repo.defaultBranch;
        const message = toText(body.message) ?? `Update ${filePath}`;
        const bytes = Buffer.from(toText(body.content) ?? '', 'base64');
        const existing = ctx.store.getFileAt(repo, branch, filePath);
        if ('error' in existing) {
          if (existing.error === 'is-dir') return sendNotFound(res, ctx);
          const commitSha = ctx.store.commitFiles(repo, branch, message, new Map([[filePath, bytes]]));
          const after = ctx.store.getFileAt(repo, branch, filePath);
          if ('error' in after) return jsonError(res, ctx, 500, 'Failed to read back created file');
          sendJson(res, ctx, 201, {
            content: {
              type: 'file', encoding: 'base64', sha: after.blobSha,
              size: after.bytes.length, name: filePath.split('/').pop(), path: filePath,
            },
            commit: { sha: commitSha },
          });
          return;
        }
        if (typeof body.sha === 'string' && body.sha !== '' && body.sha.toLowerCase() !== existing.blobSha.toLowerCase()) {
          return jsonError(res, ctx, 409, 'Stale sha: file has been updated');
        }
        const commitSha = ctx.store.commitFiles(repo, branch, message, new Map([[filePath, bytes]]));
        const after = ctx.store.getFileAt(repo, branch, filePath);
        if ('error' in after) return jsonError(res, ctx, 500, 'Failed to read back updated file');
        sendJson(res, ctx, 200, {
          content: {
            type: 'file', encoding: 'base64', sha: after.blobSha,
            size: after.bytes.length, name: filePath.split('/').pop(), path: filePath,
          },
          commit: { sha: commitSha },
        });
        return;
      }
      if (method === 'GET') {
        if (filePath === '') {
          const listing = ctx.store.listDirAt(repo, ref, '');
          if ('error' in listing) return sendNotFound(res, ctx);
          sendJson(res, ctx, 200, listing);
          return;
        }
        const got = ctx.store.getFileAt(repo, ref, filePath);
        if ('error' in got) {
          if (got.error === 'is-dir') {
            const listing = ctx.store.listDirAt(repo, ref, filePath);
            if ('error' in listing) return sendNotFound(res, ctx);
            sendJson(res, ctx, 200, listing);
            return;
          }
          return sendNotFound(res, ctx);
        }
        sendJson(res, ctx, 200, {
          type: 'file', encoding: 'base64',
          content: got.bytes.toString('base64'),
          sha: got.blobSha, size: got.bytes.length,
          name: filePath.split('/').pop(), path: filePath,
        });
        return;
      }
      if (method === 'DELETE') {
        const body = await readJsonBody(req);
        if (body === 'malformed') return jsonError(res, ctx, 400, 'Malformed JSON body');
        const branch = toText(body.branch) ?? repo.defaultBranch;
        const message = toText(body.message) ?? `Delete ${filePath}`;
        const existing = ctx.store.getFileAt(repo, branch, filePath);
        if ('error' in existing) return sendNotFound(res, ctx);
        if (typeof body.sha === 'string' && body.sha !== '' && body.sha.toLowerCase() !== existing.blobSha.toLowerCase()) {
          return jsonError(res, ctx, 409, 'Stale sha: file has been updated');
        }
        const commitSha = ctx.store.commitFiles(repo, branch, message, new Map([[filePath, null]]));
        sendJson(res, ctx, 200, { commit: { sha: commitSha } });
        return;
      }
      return sendNotFound(res, ctx);
    }

    // 14. POST /labels
    if (sub === 'labels' && segs.length === 4) {
      if (method !== 'POST') return sendNotFound(res, ctx);
      const body = await readJsonBody(req);
      if (body === 'malformed') return jsonError(res, ctx, 400, 'Malformed JSON body');
      const labelName = toText(body.name);
      if (labelName === undefined || labelName === '') return jsonError(res, ctx, 422, 'Missing label name');
      const label = ctx.store.createLabel(repo, labelName, toText(body.color));
      sendJson(res, ctx, 201, labelShape(label));
      return;
    }

    // 15-20. Issues
    if (sub === 'issues') {
      // 15/16. POST + GET /issues
      if (segs.length === 4) {
        if (method === 'POST') {
          const body = await readJsonBody(req);
          if (body === 'malformed') return jsonError(res, ctx, 400, 'Malformed JSON body');
          const title = toText(body.title);
          if (title === undefined || title === '') return jsonError(res, ctx, 422, 'Missing issue title');
          const labelNames = Array.isArray(body.labels)
            ? (body.labels as unknown[]).filter((l): l is string => typeof l === 'string')
            : [];
          const created = ctx.store.createIssue(repo, title, toText(body.body) ?? '', labelNames);
          if ('error' in created) return jsonError(res, ctx, 422, `Unknown label: ${created.label}`);
          sendJson(res, ctx, 201, issueShape(ctx, repo, created));
          return;
        }
        if (method === 'GET') {
          const { perPage, page } = pagingOf(q);
          const items = ctx.store.listIssues(repo, {
            state: q.get('state') ?? undefined,
            sort: q.get('sort') ?? undefined,
            direction: q.get('direction') ?? undefined,
          });
          sendJson(res, ctx, 200, pageSlice(items, perPage, page).map((i) => issueShape(ctx, repo, i)));
          return;
        }
        return sendNotFound(res, ctx);
      }
      // 17/18. GET + PATCH /issues/{n}
      if (segs.length === 5) {
        const n = parsePositiveInt(segs[4] as string);
        if (n === null) return sendNotFound(res, ctx);
        if (method === 'GET') {
          const issue = ctx.store.getIssue(repo, n);
          if (issue === undefined) return sendNotFound(res, ctx);
          sendJson(res, ctx, 200, issueShape(ctx, repo, issue));
          return;
        }
        if (method === 'PATCH') {
          const body = await readJsonBody(req);
          if (body === 'malformed') return jsonError(res, ctx, 400, 'Malformed JSON body');
          const patched = ctx.store.patchIssue(repo, n, {
            state: toText(body.state),
            title: toText(body.title),
            body: toText(body.body),
          });
          if (patched === undefined) return sendNotFound(res, ctx);
          sendJson(res, ctx, 200, issueShape(ctx, repo, patched));
          return;
        }
        return sendNotFound(res, ctx);
      }
      // 19/20. Comments
      if (segs.length === 6 && segs[5] === 'comments') {
        const n = parsePositiveInt(segs[4] as string);
        if (n === null) return sendNotFound(res, ctx);
        if (method === 'POST') {
          const body = await readJsonBody(req);
          if (body === 'malformed') return jsonError(res, ctx, 400, 'Malformed JSON body');
          const comment = ctx.store.createComment(repo, n, toText(body.body) ?? '');
          if (comment === undefined) return sendNotFound(res, ctx);
          sendJson(res, ctx, 201, {
            id: comment.id, body: comment.body,
            created_at: comment.createdAt, updated_at: comment.updatedAt,
            user: { login: repo.owner, id: VIEWER.id, type: 'User' },
            html_url: `${repoPageUrl(ctx, repo)}/issues/${n}#issuecomment-${comment.id}`,
            url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/${n}/comments/${comment.id}`,
          });
          return;
        }
        if (method === 'GET') {
          if (ctx.store.getIssue(repo, n) === undefined) return sendNotFound(res, ctx);
          sendJson(res, ctx, 200, ctx.store.listComments(repo, n).map((c) => ({
            id: c.id, body: c.body,
            created_at: c.createdAt, updated_at: c.updatedAt,
            user: { login: repo.owner, id: VIEWER.id, type: 'User' },
          })));
          return;
        }
        return sendNotFound(res, ctx);
      }
      return sendNotFound(res, ctx);
    }

    // 21-25. Pulls
    if (sub === 'pulls') {
      // 21/22. POST + GET /pulls
      if (segs.length === 4) {
        if (method === 'POST') {
          const body = await readJsonBody(req);
          if (body === 'malformed') return jsonError(res, ctx, 400, 'Malformed JSON body');
          const head = toText(body.head);
          const base = toText(body.base);
          const title = toText(body.title);
          if (head === undefined || head === '' || base === undefined || base === '' || title === undefined || title === '') {
            return jsonError(res, ctx, 422, 'Missing head, base, or title');
          }
          const created = ctx.store.createPull(repo, head, base, title, toText(body.body) ?? '');
          if ('error' in created) return jsonError(res, ctx, 422, `Unknown ${created.error === 'no-head' ? 'head' : 'base'} branch`);
          sendJson(res, ctx, 201, pullShape(ctx, repo, created));
          return;
        }
        if (method === 'GET') {
          const { perPage, page } = pagingOf(q);
          const items = ctx.store.listPulls(repo, q.get('state') ?? undefined);
          sendJson(res, ctx, 200, pageSlice(items, perPage, page).map((p) => pullShape(ctx, repo, p)));
          return;
        }
        return sendNotFound(res, ctx);
      }
      // 23. GET /pulls/{n}
      if (segs.length === 5) {
        if (method !== 'GET') return sendNotFound(res, ctx);
        const n = parsePositiveInt(segs[4] as string);
        if (n === null) return sendNotFound(res, ctx);
        const pr = ctx.store.getPull(repo, n);
        if (pr === undefined) return sendNotFound(res, ctx);
        sendJson(res, ctx, 200, pullShape(ctx, repo, pr));
        return;
      }
      // 24. GET /pulls/{n}/files ; 25. PUT /pulls/{n}/merge
      if (segs.length === 6) {
        const n = parsePositiveInt(segs[4] as string);
        if (n === null) return sendNotFound(res, ctx);
        if (segs[5] === 'files') {
          if (method !== 'GET') return sendNotFound(res, ctx);
          const pr = ctx.store.getPull(repo, n);
          if (pr === undefined) return sendNotFound(res, ctx);
          sendJson(res, ctx, 200, ctx.store.pullFiles(repo, pr));
          return;
        }
        if (segs[5] === 'merge') {
          if (method !== 'PUT') return sendNotFound(res, ctx);
          const body = await readJsonBody(req);
          if (body === 'malformed') return jsonError(res, ctx, 400, 'Malformed JSON body');
          const pr = ctx.store.getPull(repo, n);
          if (pr === undefined) return sendNotFound(res, ctx);
          const result = ctx.store.mergePull(repo, pr);
          if (!result.ok) {
            if (result.reason === 'conflict') return jsonError(res, ctx, 405, 'Merge conflict');
            return jsonError(res, ctx, 409, 'Pull request already merged');
          }
          sendJson(res, ctx, 200, { merged: true, sha: result.sha, message: result.message });
          return;
        }
        return sendNotFound(res, ctx);
      }
      return sendNotFound(res, ctx);
    }

    return sendNotFound(res, ctx);
  }

  // 26. Anything else under /api/v3 -> JSON 404.
  return sendNotFound(res, ctx);
}

export async function handleRest(req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx): Promise<boolean> {
  const pathname = pathOf(req);
  if (pathname !== '/api/v3' && !pathname.startsWith('/api/v3/')) return false;
  try {
    await serveRest(req, res, ctx, pathname);
  } catch (err) {
    if (!res.writableEnded) {
      jsonError(res, ctx, 500, err instanceof Error ? err.message : 'Internal Server Error');
    }
  }
  return true;
}
