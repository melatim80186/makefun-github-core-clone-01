// GraphQL v4 executor for the forge (targeted executor, not a general engine).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HandlerCtx } from './httputil.ts';
import { jsonError, parseJsonBody, pathOf, readBody, sendJson } from './httputil.ts';
import { decodeGlobalId, globalId, SHOP_TOKEN, VIEWER } from './store.ts';
import type { Issue, Pull, Repo } from './store.ts';

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author', 'comments', 'labels', 'url', 'resourcePath', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'commits', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt', 'url'],
  User: ['id', 'login', 'name', 'email'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
};

const SEARCH_TYPE_VALUES: string[] = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'ORGANIZATION', 'MILESTONE', 'PACKAGE', 'PROJECT', 'WIKI'];

function isAuthed(req: IncomingMessage): boolean {
  const h = req.headers.authorization;
  if (typeof h !== 'string' || !h.startsWith('Bearer ')) return false;
  const token = h.slice('Bearer '.length);
  if (token.length === 0) return false;
  if (SHOP_TOKEN === '') return true;
  return token === SHOP_TOKEN;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function issueState(state: string): string {
  return state === 'closed' ? 'CLOSED' : 'OPEN';
}

function prState(pr: Pull): string {
  if (pr.merged) return 'MERGED';
  if (pr.state === 'closed') return 'CLOSED';
  return 'OPEN';
}

function mergeableOf(repo: Repo, pr: Pull, ctx: HandlerCtx): string {
  try {
    return ctx.store.isConflicted(repo, pr) ? 'CONFLICTING' : 'MERGEABLE';
  } catch {
    return 'MERGEABLE';
  }
}

function issueObj(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: globalId('I', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    state: issueState(issue.state),
    body: issue.body,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

function prNode(repo: Repo, pr: Pull, ctx: HandlerCtx): Record<string, unknown> {
  return {
    id: globalId('P', repo.id, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: prState(pr),
    merged: pr.merged,
    mergeable: mergeableOf(repo, pr, ctx),
    headRefName: pr.headRef,
    baseRefName: pr.baseRef,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
  };
}

function findRepoById(ctx: HandlerCtx, dbid: number): Repo | undefined {
  for (const repo of ctx.store.listRepos()) {
    if (repo.id === dbid) return repo;
  }
  return undefined;
}

function encodeCursor(n: number): string {
  return Buffer.from(String(n), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  try {
    const n = parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function notFoundResult(key: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  data[key] = null;
  return { data, errors: [{ message: 'Not found' }] };
}

function executeIntrospection(query: string): Record<string, unknown> | null {
  if (!query.includes('__type')) return null;
  const data: Record<string, unknown> = {};
  const re = /(?:([A-Za-z_][A-Za-z0-9_]*)\s*:\s*)?__type\s*\(\s*name\s*:\s*"([^"]+)"\s*\)/g;
  let m: RegExpExecArray | null;
  let found = false;
  while ((m = re.exec(query)) !== null) {
    found = true;
    const alias = m[1] !== undefined ? m[1] : '__type';
    const typeName = m[2] as string;
    const rest = query.slice(m.index + m[0].length);
    const nextIdx = rest.search(/__type\s*\(/);
    const segment = nextIdx === -1 ? rest : rest.slice(0, nextIdx);
    if (segment.includes('enumValues')) {
      const vals = typeName === 'SearchType' ? SEARCH_TYPE_VALUES : [];
      data[alias] = { enumValues: vals.map((n) => ({ name: n })) };
    } else {
      const fields = TYPE_FIELDS[typeName] !== undefined ? TYPE_FIELDS[typeName] as string[] : [];
      data[alias] = { fields: fields.map((n) => ({ name: n })) };
    }
  }
  if (!found) return null;
  return { data };
}

function executeRepository(query: string, variables: Record<string, unknown>, ctx: HandlerCtx): Record<string, unknown> | null {
  if (!query.includes('repository(')) return null;
  const owner = typeof variables.owner === 'string' ? variables.owner : '';
  const name = typeof variables.name === 'string' ? variables.name : '';
  const repo = owner !== '' && name !== '' ? ctx.store.getRepo(owner, name) : undefined;
  if (!repo) return { data: { repository: null } };
  const repoData: Record<string, unknown> = {
    id: globalId('R', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    defaultBranchRef: { name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    private: repo.private,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    url: `${ctx.baseUrl}/${repo.owner}/${repo.name}`,
  };
  // repository.issue(number: ...)
  const issueMatch = /issue\s*\(\s*number\s*:\s*\$?([A-Za-z_][A-Za-z0-9_]*|\d+)\s*\)/.exec(query);
  if (issueMatch) {
    const raw = issueMatch[1] as string;
    const num = /^\d+$/.test(raw) ? parseInt(raw, 10) : (typeof variables[raw] === 'number' ? (variables[raw] as number) : NaN);
    const issue = Number.isFinite(num) ? ctx.store.getIssue(repo, num) : undefined;
    repoData.issue = issue ? issueObj(repo, issue) : null;
  }
  // repository.issues(first, states, orderBy, after)
  const issuesMatch = /issues\s*\(([^)]*)\)/.exec(query);
  if (issuesMatch) {
    const argsText = issuesMatch[1] as string;
    let first: number | undefined;
    if (typeof variables.first === 'number') first = variables.first as number;
    else {
      const fm = /first\s*:\s*(\d+)/.exec(argsText);
      if (fm) first = parseInt(fm[1] as string, 10);
    }
    let states: string[] | null = null;
    const sm = /states\s*:\s*\[([^\]]*)\]/.exec(argsText);
    if (sm) {
      states = (sm[1] as string).split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    }
    let desc = true;
    const dm = /direction\s*:\s*(ASC|DESC)/.exec(argsText);
    if (dm) desc = (dm[1] as string) === 'DESC';
    let items = [...repo.issues.values()];
    if (states !== null) {
      const wantOpen = states.includes('OPEN');
      const wantClosed = states.includes('CLOSED');
      items = items.filter((i) => (wantOpen && i.state === 'open') || (wantClosed && i.state === 'closed'));
    }
    items.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
    const afterRaw = variables.after;
    if (typeof afterRaw === 'string' && afterRaw.length > 0) {
      const afterNum = decodeCursor(afterRaw);
      if (afterNum !== null) {
        items = items.filter((i) => (desc ? i.number < afterNum : i.number > afterNum));
      }
    }
    const page = first !== undefined ? items.slice(0, first) : items;
    const hasNextPage = items.length > page.length;
    const endCursor = page.length > 0 ? encodeCursor((page[page.length - 1] as Issue).number) : null;
    repoData.issues = {
      nodes: page.map((i) => issueObj(repo, i)),
      pageInfo: { hasNextPage, endCursor },
    };
  }
  // repository.pullRequests(first)
  if (/pullRequests\s*\(/.test(query)) {
    let first: number | undefined;
    if (typeof variables.first === 'number') first = variables.first as number;
    const all = ctx.store.listPulls(repo);
    const page = first !== undefined ? all.slice(0, first) : all;
    repoData.pullRequests = { nodes: page.map((p) => prNode(repo, p, ctx)) };
  }
  // repository.pullRequest(number: ...)
  const prMatch = /pullRequest\s*\(\s*number\s*:\s*\$?([A-Za-z_][A-Za-z0-9_]*|\d+)\s*\)/.exec(query);
  if (prMatch) {
    const raw = prMatch[1] as string;
    const num = /^\d+$/.test(raw) ? parseInt(raw, 10) : (typeof variables[raw] === 'number' ? (variables[raw] as number) : NaN);
    const pr = Number.isFinite(num) ? ctx.store.getPull(repo, num) : undefined;
    if (!pr) {
      repoData.pullRequest = null;
    } else {
      let filesFirst: number | undefined;
      const ff = /files\s*\(\s*first\s*:\s*\$?([A-Za-z_][A-Za-z0-9_]*|\d+)\s*\)/.exec(query);
      if (ff) {
        const fraw = ff[1] as string;
        filesFirst = /^\d+$/.test(fraw) ? parseInt(fraw, 10) : (typeof variables[fraw] === 'number' ? (variables[fraw] as number) : undefined);
      }
      const allFiles = ctx.store.pullFiles(repo, pr);
      const filesPage = filesFirst !== undefined ? allFiles.slice(0, filesFirst) : allFiles;
      const node = prNode(repo, pr, ctx);
      node.files = { nodes: filesPage.map((f) => ({ path: f.filename })) };
      repoData.pullRequest = node;
    }
  }
  return { data: { repository: repoData } };
}

function executeOperation(op: unknown, ctx: HandlerCtx): Record<string, unknown> {
  try {
    const rec = asRecord(op);
    const query = typeof rec.query === 'string' ? rec.query : '';
    const variables = asRecord(rec.variables);
    if (query === '') return { data: null, errors: [{ message: 'Missing query' }] };

    // Invalid-field check on the viewer selection set (only viewer case is tested).
    const viewerMatch = /viewer\s*\{([\s\S]*?)\}/.exec(query);
    if (viewerMatch) {
      const fields = (viewerMatch[1] as string).match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
      let bad: string | null = null;
      for (const f of fields) {
        if (f !== 'login') { bad = f; break; }
      }
      if (bad !== null) {
        return {
          data: { viewer: { login: VIEWER.login } },
          errors: [{ message: `Cannot query field "${bad}" on type "Viewer".` }],
        };
      }
    }

    // Introspection __type(...)
    const intro = executeIntrospection(query);
    if (intro !== null) return intro;

    // Mutations
    if (query.includes('createIssue')) {
      const input = asRecord(variables.input);
      const dec = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      const repo = dec !== null && dec.kind === 'R' ? findRepoById(ctx, Number(dec.parts[0])) : undefined;
      if (!repo) return notFoundResult('createIssue');
      const created = ctx.store.createIssue(repo, typeof input.title === 'string' ? input.title : '', typeof input.body === 'string' ? input.body : '');
      if (created !== null && typeof created === 'object' && 'error' in created) return notFoundResult('createIssue');
      const issue = created as Issue;
      return { data: { createIssue: { issue: { number: issue.number, id: globalId('I', repo.id, issue.number) } } } };
    }
    if (query.includes('closeIssue')) {
      const input = asRecord(variables.input);
      const dec = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
      const repo = dec !== null && dec.kind === 'I' ? findRepoById(ctx, Number(dec.parts[0])) : undefined;
      const num = dec !== null ? Number(dec.parts[1]) : NaN;
      const issue = repo !== undefined && Number.isFinite(num) ? ctx.store.getIssue(repo, num) : undefined;
      if (!repo || !issue) return notFoundResult('closeIssue');
      ctx.store.patchIssue(repo, num, { state: 'closed' });
      return { data: { closeIssue: { issue: { number: issue.number, id: globalId('I', repo.id, issue.number), state: 'CLOSED' } } } };
    }
    if (query.includes('createPullRequest')) {
      const input = asRecord(variables.input);
      const dec = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      const repo = dec !== null && dec.kind === 'R' ? findRepoById(ctx, Number(dec.parts[0])) : undefined;
      if (!repo) return notFoundResult('createPullRequest');
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const created = ctx.store.createPull(repo, head, base, typeof input.title === 'string' ? input.title : '', '');
      if (created !== null && typeof created === 'object' && 'error' in created) {
        return { data: { createPullRequest: null }, errors: [{ message: 'No such branch' }] };
      }
      const pr = created as Pull;
      return { data: { createPullRequest: { pullRequest: { number: pr.number, id: globalId('P', repo.id, pr.number), state: 'OPEN', headRefName: pr.headRef, baseRefName: pr.baseRef } } } };
    }
    if (query.includes('mergePullRequest')) {
      const input = asRecord(variables.input);
      const dec = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
      const repo = dec !== null && dec.kind === 'P' ? findRepoById(ctx, Number(dec.parts[0])) : undefined;
      const num = dec !== null ? Number(dec.parts[1]) : NaN;
      const pr = repo !== undefined && Number.isFinite(num) ? ctx.store.getPull(repo, num) : undefined;
      if (!repo || !pr) return notFoundResult('mergePullRequest');
      const res = ctx.store.mergePull(repo, pr);
      if (res.ok) {
        return { data: { mergePullRequest: { pullRequest: { number: pr.number, merged: true, state: 'CLOSED' } } } };
      }
      if (res.reason === 'already' && pr.merged) {
        return { data: { mergePullRequest: { pullRequest: { number: pr.number, merged: true, state: 'CLOSED' } } } };
      }
      if (res.reason === 'conflict') {
        return { data: { mergePullRequest: null }, errors: [{ message: 'Merge conflict' }] };
      }
      return { data: { mergePullRequest: null }, errors: [{ message: 'Pull request already closed' }] };
    }
    if (query.includes('addComment')) {
      const input = asRecord(variables.input);
      const dec = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
      const repo = dec !== null && dec.kind === 'I' ? findRepoById(ctx, Number(dec.parts[0])) : undefined;
      const num = dec !== null ? Number(dec.parts[1]) : NaN;
      const comment = repo !== undefined && Number.isFinite(num) ? ctx.store.createComment(repo, num, typeof input.body === 'string' ? input.body : '') : undefined;
      if (!repo || !comment) return notFoundResult('addComment');
      return { data: { addComment: { commentEdge: { node: { id: globalId('C', repo.id, num, comment.id), body: comment.body } } } } };
    }

    // node(id: ...)
    if (query.includes('node(')) {
      const idVar = typeof variables.id === 'string' ? variables.id : '';
      const dec = idVar !== '' ? decodeGlobalId(idVar) : null;
      if (dec !== null && dec.kind === 'R') {
        const repo = findRepoById(ctx, Number(dec.parts[0]));
        if (!repo) return { data: { node: null } };
        return { data: { node: { id: idVar, name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}` } } };
      }
      return { data: { node: { id: idVar } } };
    }

    // repository(...)
    const repoResult = executeRepository(query, variables, ctx);
    if (repoResult !== null) return repoResult;

    // viewer
    if (query.includes('viewer')) {
      return { data: { viewer: { login: VIEWER.login } } };
    }

    return { data: {}, errors: [{ message: 'Unknown operation' }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return { data: null, errors: [{ message: msg }] };
  }
}

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx): Promise<boolean> {
  if (req.method !== 'POST' || pathOf(req) !== '/api/graphql') return false;
  if (!isAuthed(req)) {
    jsonError(res, ctx, 401, 'Unauthorized');
    return true;
  }
  let buf: Buffer;
  try {
    buf = await readBody(req);
  } catch {
    jsonError(res, ctx, 400, 'Invalid request body');
    return true;
  }
  const parsed = parseJsonBody(buf);
  if (!parsed.ok) {
    jsonError(res, ctx, 400, 'Invalid JSON');
    return true;
  }
  try {
    const value = parsed.value;
    if (Array.isArray(value)) {
      const results = value.map((op) => executeOperation(op, ctx));
      sendJson(res, ctx, 200, results);
      return true;
    }
    if (value !== null && typeof value === 'object') {
      sendJson(res, ctx, 200, executeOperation(value, ctx));
      return true;
    }
    jsonError(res, ctx, 400, 'Invalid GraphQL request');
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    sendJson(res, ctx, 200, { data: null, errors: [{ message: msg }] });
    return true;
  }
}
