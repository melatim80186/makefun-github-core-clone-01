// MCP endpoint: JSON-RPC 2.0 over POST /mcp (Streamable HTTP, JSON answers).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HandlerCtx } from './httputil.ts';
import { jsonError, parseJsonBody, pathOf, readBody, sendEmpty, sendJson } from './httputil.ts';
import { SHOP_TOKEN } from './store.ts';
import type { Issue, Pull, Repo } from './store.ts';

const SERVER_INFO = { name: 'github-core-clone-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS: string[] = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// Module-level constant: byte-identical across calls (tools/list idempotency).
const TOOLS = [
  {
    name: 'create_repo',
    description: 'Make a new repository under the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The new repository name.' },
        description: { type: 'string', description: 'A short summary of the repository.' },
        private: { type: 'boolean', description: 'True when the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Fetch one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Open a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body text.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by issue state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body text.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_REQUIRED: Record<string, string[]> = {
  create_repo: ['name'],
  get_repo: ['owner', 'repo'],
  create_issue: ['owner', 'repo', 'title'],
  list_issues: ['owner', 'repo'],
  create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
  merge_pull_request: ['owner', 'repo', 'pull_number'],
};

function hasMcpToken(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  if (token.length === 0) return false;
  if (SHOP_TOKEN === '') return true;
  return token === SHOP_TOKEN;
}

function recordOf(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function answerResult(res: ServerResponse, ctx: HandlerCtx, id: unknown, result: unknown): void {
  sendJson(res, ctx, 200, { jsonrpc: '2.0', id: id === undefined ? null : id, result });
}

function answerError(res: ServerResponse, ctx: HandlerCtx, id: unknown, code: number, message: string): void {
  sendJson(res, ctx, 200, { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });
}

function failedToolCall(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError: true };
}

function okToolCall(obj: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj };
}

function repoCard(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id, name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private, description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueCard(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id, number: issue.number,
    title: issue.title, body: issue.body,
    state: issue.state, labels: [],
  };
}

function fillArgSynonyms(args: Record<string, unknown>): void {
  // full_name "owner/repo" split (only when owner/repo are absent).
  const ownerMissing = args.owner === undefined || args.owner === null || args.owner === '';
  const repoMissing = args.repo === undefined || args.repo === null || args.repo === '';
  if (ownerMissing && repoMissing && typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2 && parts[0] !== '' && parts[1] !== '') {
      args.owner = parts[0];
      args.repo = parts[1];
    }
  }
  // Light synonym fallbacks (suite sends canonical names; these are insurance).
  if (ownerMissing && typeof args.org === 'string') args.owner = args.org;
  if (ownerMissing && typeof args.user === 'string') args.owner = args.user;
  if (ownerMissing && typeof args.login === 'string') args.owner = args.login;
  if (repoMissing && typeof args.repository === 'string') args.repo = args.repository;
  if (repoMissing && typeof args.repo_name === 'string') args.repo = args.repo_name;
  if (args.pull_number === undefined && typeof args.number === 'number') args.pull_number = args.number;
  if (args.pull_number === undefined && typeof args.pr_number === 'number') args.pull_number = args.pr_number;
  if (args.pull_number === undefined && typeof args.pull_request_number === 'number') args.pull_number = args.pull_request_number;
  if (args.head === undefined && typeof args.head_ref === 'string') args.head = args.head_ref;
  if (args.base === undefined && typeof args.base_ref === 'string') args.base = args.base_ref;
}

function runTool(name: string, args: Record<string, unknown>, ctx: HandlerCtx): Record<string, unknown> {
  if (name === 'create_repo') {
    const repoName = String(args.name);
    const description = typeof args.description === 'string' ? args.description : '';
    const isPrivate = args.private === true;
    const created = ctx.store.createRepo(repoName, isPrivate, description);
    if (created !== null && typeof created === 'object' && 'error' in created) {
      return failedToolCall(`Repository already exists: ${repoName}`);
    }
    return okToolCall(repoCard(created as Repo));
  }
  if (name === 'get_repo') {
    const owner = String(args.owner ?? '');
    const repoName = String(args.repo ?? '');
    const repo = ctx.store.getRepo(owner, repoName);
    if (repo === undefined) return failedToolCall(`Repository not found: ${owner}/${repoName}`);
    return okToolCall(repoCard(repo));
  }
  if (name === 'create_issue') {
    const owner = String(args.owner ?? '');
    const repoName = String(args.repo ?? '');
    const repo = ctx.store.getRepo(owner, repoName);
    if (repo === undefined) return failedToolCall(`Repository not found: ${owner}/${repoName}`);
    const created = ctx.store.createIssue(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '');
    if (created !== null && typeof created === 'object' && 'error' in created) {
      return failedToolCall(`Bad label: ${(created as { label: string }).label}`);
    }
    return okToolCall(issueCard(created as Issue));
  }
  if (name === 'list_issues') {
    const owner = String(args.owner ?? '');
    const repoName = String(args.repo ?? '');
    const repo = ctx.store.getRepo(owner, repoName);
    if (repo === undefined) return failedToolCall(`Repository not found: ${owner}/${repoName}`);
    const state = typeof args.state === 'string' && args.state !== '' ? args.state : 'open';
    const issues = ctx.store.listIssues(repo, { state });
    const arr = issues.map((i) => issueCard(i));
    return { content: [{ type: 'text', text: JSON.stringify(arr) }], structuredContent: { issues: arr } };
  }
  if (name === 'create_pull_request') {
    const owner = String(args.owner ?? '');
    const repoName = String(args.repo ?? '');
    const repo = ctx.store.getRepo(owner, repoName);
    if (repo === undefined) return failedToolCall(`Repository not found: ${owner}/${repoName}`);
    const head = String(args.head ?? '');
    const base = String(args.base ?? '');
    const created = ctx.store.createPull(repo, head, base, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '');
    if (created !== null && typeof created === 'object' && 'error' in created) {
      return failedToolCall(`Cannot create pull request: no such branch: ${head} / ${base}`);
    }
    const pr = created as Pull;
    const prCard: Record<string, unknown> = {
      id: pr.id, number: pr.number,
      title: pr.title, body: pr.body, state: pr.state,
      head: { ref: pr.headRef, sha: pr.headSha },
      base: { ref: pr.baseRef, sha: pr.baseSha },
    };
    return okToolCall(prCard);
  }
  if (name === 'merge_pull_request') {
    const owner = String(args.owner ?? '');
    const repoName = String(args.repo ?? '');
    const repo = ctx.store.getRepo(owner, repoName);
    if (repo === undefined) return failedToolCall(`Repository not found: ${owner}/${repoName}`);
    const n = Number(args.pull_number);
    if (!Number.isFinite(n)) return failedToolCall('Missing required argument: pull_number');
    const pr = ctx.store.getPull(repo, n);
    if (pr === undefined) return failedToolCall(`Pull request not found: #${n}`);
    const res = ctx.store.mergePull(repo, pr);
    if (res.ok) return okToolCall({ merged: true, sha: res.sha, number: pr.number });
    if (res.reason === 'already' && pr.merged) {
      return okToolCall({ merged: true, sha: pr.mergeCommitSha ?? '', number: pr.number });
    }
    if (res.reason === 'conflict') return failedToolCall('Merge conflict');
    return failedToolCall('Pull request already closed');
  }
  return failedToolCall(`Unknown tool: ${name}`);
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx): Promise<boolean> {
  if (pathOf(req) !== '/mcp') return false;
  if (req.method === 'DELETE') {
    sendJson(res, ctx, 200, {});
    return true;
  }
  if (req.method !== 'POST') return false;
  if (!hasMcpToken(req)) {
    jsonError(res, ctx, 401, 'Unauthorized');
    return true;
  }
  let buf: Buffer;
  try {
    buf = await readBody(req);
  } catch {
    sendJson(res, ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  const parsed = parseJsonBody(buf);
  if (!parsed.ok || parsed.value === undefined) {
    sendJson(res, ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  let rpcId: unknown = null;
  try {
    const body = parsed.value;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, ctx, 200, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      return true;
    }
    const reqObj = body as Record<string, unknown>;
    rpcId = 'id' in reqObj ? reqObj.id : undefined;
    const method = typeof reqObj.method === 'string' ? reqObj.method : '';
    const params = recordOf(reqObj.params);
    if (method === 'notifications/initialized') {
      sendEmpty(res, ctx, 202);
      return true;
    }
    if (rpcId === undefined) {
      // Any other notification: no response body.
      sendEmpty(res, ctx, 202);
      return true;
    }
    if (method === 'server/discover') {
      answerResult(res, ctx, rpcId, { supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
      return true;
    }
    if (method === 'initialize') {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      answerResult(res, ctx, rpcId, { protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
      return true;
    }
    if (method === 'tools/list') {
      answerResult(res, ctx, rpcId, { tools: TOOLS });
      return true;
    }
    if (method === 'tools/call') {
      const toolName = typeof params.name === 'string' ? params.name : '';
      if (toolName === '') {
        answerError(res, ctx, rpcId, -32602, 'Invalid params: missing tool name');
        return true;
      }
      const known = TOOLS.some((t) => t.name === toolName);
      if (!known) {
        answerError(res, ctx, rpcId, -32601, `Method not found: ${toolName}`);
        return true;
      }
      const args: Record<string, unknown> = { ...recordOf(params.arguments) };
      fillArgSynonyms(args);
      const required = TOOL_REQUIRED[toolName] !== undefined ? (TOOL_REQUIRED[toolName] as string[]) : [];
      for (const prop of required) {
        const v = args[prop];
        if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
          answerResult(res, ctx, rpcId, failedToolCall(`Missing required argument: ${prop}`));
          return true;
        }
      }
      answerResult(res, ctx, rpcId, runTool(toolName, args, ctx));
      return true;
    }
    answerError(res, ctx, rpcId, -32601, `Method not found: ${method}`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    answerError(res, ctx, rpcId, -32603, msg);
    return true;
  }
}
