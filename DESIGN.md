# github-core-clone-01 — DESIGN (implementation contract)

Contest: github-core-clone-01, $500, Node 22 stdlib only, one process.
Specs: spec-rest.md, spec-graphql-mcp.md, spec-runner-scoring.md, spec-git.md (pending).
120 checks: git 30, repos 15, issues 15, pulls 20, graphql 20, mcp 15, protocol 5.

## Files (build/ = staging, NOT the repo yet)
- `main.ts` — starter lifecycle verbatim (bind ephemeral port, POST /register, poll /done, exit 0).
- `app.ts` — HTTP server + router + auth + JSON helpers (written by integrator).
- `store.ts` — in-memory forge state (written by integrator, API below is FROZEN).
- `gitobj.ts` — pure git object model: sha1, blob/tree/commit/tag bytes, tree build/parse.
- `rest.ts` — REST v3 handlers. Export: `handleRest(req, res, ctx)`.
- `graphql.ts` — GraphQL executor. Export: `handleGraphQL(req, res, ctx)`.
- `mcp.ts` — MCP endpoint. Export: `handleMcp(req, res, ctx)`.
- `git.ts` — smart HTTP handlers. Export: `handleGit(req, res, ctx)`.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT), `README.md` — copied from starter.

## Global facts (DO NOT re-derive differently)
- Viewer login = `adaiversen` (id 1000, name `ada iversen`, email `adaiversen@example.invalid`),
  derived in store.ts by reimplementing wire.ts exactly: SCENARIO_SEED 0x6a09e667f3bcc909n,
  fnv1a64/mix64/scenarioRng('users'), generateUsers with the FIRST/LAST name lists.
  The sealed env uses this same constant seed, so the derivation holds in the trial.
- Default branch = `main` everywhere.
- Token: `process.env.MAKEFUN_SHOP_TOKEN ?? ''`. Auth rule: `Authorization: Bearer <token>`
  exact match required on /api/v3/*, /api/graphql, /mcp, /{owner}/{repo}.git/*. Missing or
  wrong token -> 401 JSON `{"message": "..."}`. If env token is empty (local dev only),
  accept any non-empty Bearer token. `/healthz` takes no auth.
- Timestamps: logical clock in store.ts. Base = MAKEFUN_TRIAL_NOW if set, else
  2025-01-01T00:00:00Z. Each call advances 1s. ISO strings. Deterministic.
- X-GitHub-Request-Id: non-empty on EVERY reply, `req-<n>` incrementing (n = per-process counter).
- Every reply (except 204) is `application/json; charset=utf-8` with a JSON body.
  Error bodies: `{"message": "<non-empty string>"}`. Unknown route -> 404 JSON.
- Malformed JSON request body on any endpoint that reads a body -> 400 JSON.
- Repo `id` (databaseId): sequential integers starting at 1, in creation order.
  Issue/PR numbers: ONE shared counter per repo, starting at 1, +1 per issue or PR created.
- Global (GraphQL) ids: opaque base64url: repo `R:<dbid>`, issue `I:<repoDbid>:<number>`,
  PR `P:<repoDbid>:<number>`, comment `C:<repoDbid>:<issueNumber>:<commentId>`.
  Decode by base64url-decoding and splitting on ':'. Never the plain number.

## store.ts API (FROZEN — implementers code against this)
```ts
export interface User { id: number; login: string; name: string; email: string }
export const VIEWER: User; // adaiversen
export const SHOP_TOKEN: string;
export const DEFAULT_BRANCH = 'main';
export function nowIso(): string;                 // logical clock, +1s per call
export function nowEpochSec(): number;             // same clock as epoch seconds
export function globalId(kind: 'R'|'I'|'P'|'C', ...parts: (string|number)[]): string;
export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null;

export interface Repo { id: number; name: string; owner: string; private: boolean;
  description: string; defaultBranch: string; createdAt: string; updatedAt: string;
  counter: number; labels: Map<string, Label>; issues: Map<number, Issue>;
  pulls: Map<number, Pull>; comments: Map<number, Comment[]>; commentSeq: number;
  objects: Map<string, GitObject>; refs: Map<string, string>;
  commits: Map<string, CommitMeta>; }
export interface Label { name: string; color: string; description?: string }
export interface Issue { id: number; number: number; title: string; body: string;
  state: 'open'|'closed'; labels: Label[]; createdAt: string; updatedAt: string; repo: Repo }
export interface Pull { id: number; number: number; title: string; body: string;
  state: 'open'|'closed'; headRef: string; baseRef: string; headSha: string; baseSha: string;
  merged: boolean; mergedAt: string | null; mergeCommitSha: string | null;
  createdAt: string; updatedAt: string; repo: Repo }
export interface Comment { id: number; body: string; createdAt: string; updatedAt: string }
export interface GitObject { type: 'blob'|'tree'|'commit'|'tag'; data: Buffer } // data = raw content, no git header
export interface CommitMeta { sha: string; tree: string; parents: string[]; message: string;
  authorName: string; authorEmail: string; authorTime: number; committerName: string;
  committerEmail: string; committerTime: number; files: Map<string, string> } // files: path -> blob sha

export function createStore(): Store;
export interface Store {
  repos: Map<string, Repo>; // key `${owner}/${name}`
  getRepo(owner: string, name: string): Repo | undefined; // owner must == VIEWER.login
  createRepo(name: string, isPrivate: boolean, description: string): Repo | { error: 'exists' };
  deleteRepo(repo: Repo): void;
  listRepos(): Repo[]; // creation order
  createLabel(repo: Repo, name: string, color?: string): Label;
  createIssue(repo: Repo, title: string, body: string, labelNames?: string[]): Issue | { error: 'bad-label'; label: string };
  getIssue(repo: Repo, n: number): Issue | undefined;
  listIssues(repo: Repo, opts: { state?: string; sort?: string; direction?: string }): Issue[];
  patchIssue(repo: Repo, n: number, patch: { state?: string; title?: string; body?: string }): Issue | undefined;
  createComment(repo: Repo, issueNumber: number, body: string): Comment | undefined;
  listComments(repo: Repo, issueNumber: number): Comment[];
  createBranch(repo: Repo, branch: string, sha: string): boolean; // false if sha unknown
  listBranches(repo: Repo): { name: string; sha: string }[];
  // commit `changes` (path -> Buffer content, or null to delete) on `branch`; returns commit sha.
  // Creates blob/tree/commit objects. `message` exact. Works on unborn repo (no parent).
  commitFiles(repo: Repo, branch: string, message: string, changes: Map<string, Buffer | null>): string;
  getFileAt(repo: Repo, ref: string, path: string): { blobSha: string; bytes: Buffer } | { error: 'not-found' | 'is-dir' };
  listDirAt(repo: Repo, ref: string, dir: string): { type: 'file'|'dir'; name: string; path: string; sha: string }[] | { error: 'not-found' };
  listCommits(repo: Repo, ref?: string): { sha: string; message: string }[]; // newest first, walk parents
  createPull(repo: Repo, head: string, base: string, title: string, body: string): Pull | { error: 'no-head' | 'no-base' };
  getPull(repo: Repo, n: number): Pull | undefined;
  listPulls(repo: Repo, state?: string): Pull[]; // default open only; 'all' = open+closed
  pullFiles(repo: Repo, pr: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[];
  mergePull(repo: Repo, pr: Pull): { ok: true; sha: string; message: string } | { ok: false; reason: 'conflict' | 'already' };
  // git object helpers (also used by git.ts)
  storeObject(repo: Repo, type: GitObject['type'], data: Buffer): string; // returns sha1
  getObject(repo: Repo, sha: string): GitObject | undefined;
  refTip(repo: Repo, ref: string): string | undefined; // 'refs/heads/main' style
  setRef(repo: Repo, ref: string, sha: string | null): void; // null = delete ref
  mergeBase(repo: Repo, a: string, b: string): string | undefined;
  isAncestor(repo: Repo, anc: string, desc: string): boolean;
  treeFiles(repo: Repo, commitSha: string): Map<string, string> | undefined; // path -> blob sha
}
```

## gitobj.ts API (FROZEN)
```ts
export function sha1(data: Buffer): string;
export function gitObjectBytes(type: string, data: Buffer): Buffer; // "<type> <len>\0" + data
export function makeBlob(content: Buffer): { sha: string; bytes: Buffer };
export function buildTree(repo files: Map<string, string> /* path -> blob sha */): { sha: string; treeObj: Buffer; subtrees: Map<string, Buffer> };
  // returns root tree sha + ALL tree objects (root + subtrees) as sha->bytes map entries to store.
  // Simpler: buildTrees(files): Map<string, Buffer> of every tree object (sha -> raw bytes), plus root sha.
export function buildTrees(files: Map<string, string>): { root: string; objects: Map<string, Buffer> };
export function makeCommit(opts: { tree: string; parents: string[]; message: string;
  authorName: string; authorEmail: string; authorTime: number; committerName: string;
  committerEmail: string; committerTime: number }): { sha: string; bytes: Buffer };
export function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string;
  authorLine: string; committerLine: string; raw: Buffer };
export function parseTree(data: Buffer): { mode: string; name: string; sha: string }[];
```

## REST rules (from spec-rest.md — implementer reads the full spec)
- All under /api/v3. Root GET / and /api/v3 (both) -> 200 + X-OAuth-Scopes: repo, read:org.
- GET /meta -> 200 {"installed_version": "1.0.0"} (any non-empty string).
- POST /user/repos 201 repo object; duplicate name -> 422. GET /user/repos paginates
  per_page (default 30, cap 100) with Link rel="next" absolute same-origin URLs.
- Repo object: include name, full_name, private, description, default_branch, owner{login},
  id, html_url, clone_url, git_url, ssh_url, created_at, updated_at, pushed_at (extra fields allowed).
- PATCH repo {description} -> 200, persists. DELETE repo -> 204, then GET 404.
- POST /git/refs {ref:"refs/heads/x", sha} -> 201 {ref, object:{sha}}. GET /branches -> [{name, commit:{sha}}].
- GET /commits?sha=<branch> -> [{sha, commit:{message, author, committer}}]; no sha -> default branch history.
- PUT contents {message, content(base64), sha?, branch?} -> create 201 / update 200-or-201,
  stale sha -> 409. Response {content:{sha, encoding:"base64"}, commit:{sha}}.
  GET contents file -> {type:"file", encoding:"base64", content, sha, size}; dir -> array
  {type,name,path,sha}; missing -> 404. DELETE contents {message, sha} -> 200 {commit:{sha}}.
- POST labels {name, color} -> 201 {name}. POST issues {title, body, labels?} -> 201 open issue;
  unknown label -> 422. Issue object: number, title, body, state, labels[{name}], id, user{login},
  created_at, updated_at, html_url, url. GET /issues?state=&sort=created&direction=&per_page=.
  GET/PATCH /issues/{n} (state closed persists). Comments POST 201 {id, body}; GET list.
- POST pulls {head, base, title, body} -> 201 {number, state:"open", title, body,
  head:{ref,sha}, base:{ref,sha}, merged:false, merged_at:null, merge_commit_sha:null}.
  GET /pulls/{n}; GET /pulls/{n}/files [{filename, status, additions, deletions, changes}];
  PUT /pulls/{n}/merge {merge_method:"squash"} -> 200 {merged:true, sha, message};
  unknown PR -> 404; conflicted -> 405. After merge: state closed, merged true, merged_at set,
  merge_commit_sha == merge sha; squash commit on default branch with head content.
- Foreign owner (owner != viewer login) on any /repos/{owner}/... route -> 404, never 403.

## GraphQL rules (from spec-graphql-mcp.md — implementer reads the full spec)
- POST /api/graphql only. Single {query, variables} -> {data, errors?}; array body -> array of results in order.
- viewer.login == viewer login. repository(owner,name) nullable; unknown -> data.repository null, no errors.
- Introspection __type for Issue/PullRequest/Repository/SearchType with the exact required
  field lists (see spec A.2). Alias form must be honoured (data.Issue / data.PullRequest / ...).
- repository.issues(first, states:[OPEN], orderBy:{CREATED_AT,DESC}, after) -> nodes + pageInfo{hasNextPage,endCursor};
  order DESC = number descending; states filter; first caps; cursor pagination (cursor = base64 of issue number offset).
- issue(number), pullRequests(first), pullRequest(number){files(first){nodes{path}}}, node(id: ID!)
  with ... on Repository {name, nameWithOwner}.
- Mutations: createIssue{repositoryId,title,body}, closeIssue{issueId}, createPullRequest{repositoryId,
  baseRefName,headRefName,title}, mergePullRequest{pullRequestId, mergeMethod:'SQUASH'},
  addComment{subjectId, body} -> commentEdge{node{id,body}}.
- Unknown field (e.g. noSuchFieldOnViewer) -> HTTP 200 + errors array with message containing the field name.
- Global ids opaque + stable (see store globalId). databaseId = repo id (int).
- viewerPermission: "ADMIN". hasIssuesEnabled: true. mergeable: "MERGEABLE" unless mergePull
  conflict detection says otherwise ("CONFLICTING"); use store conflict check.
- States in GraphQL: 'OPEN'/'CLOSED' (uppercase). Issue state field returns 'OPEN'/'CLOSED'.
- Unauthenticated -> 401 exactly.

## MCP rules (from spec-graphql-mcp.md — implementer reads the full spec)
- POST /mcp only (+ DELETE /mcp -> 200 {}). JSON-RPC 2.0, application/json responses.
- server/discover -> result {supportedVersions: ["2026-07-28","2025-11-25","2025-06-18","2025-03-26","2024-11-05"],
  serverInfo:{name:"github-core-clone-forge",version:"1.0.0"}, capabilities:{tools:{}}}.
- initialize -> result {protocolVersion: <requested or "2025-11-25">, serverInfo:{...}, capabilities:{tools:{}}}.
  notifications/initialized -> 202, no body.
- tools/list -> {tools: [6 tools]}; byte-identical across calls (static array).
  Tools (exact property names — the suite maps args onto these):
  create_repo {name, description?, private?} required [name];
  get_repo {owner, repo} required [owner, repo];
  create_issue {owner, repo, title, body?} required [owner, repo, title];
  list_issues {owner, repo, state?} required [owner, repo];
  create_pull_request {owner, repo, title, body?, head, base} required [owner, repo, title, head, base];
  merge_pull_request {owner, repo, pull_number} required [owner, repo, pull_number].
  Every tool: non-empty description, inputSchema {type:"object", properties:{...}, required:[...]}.
  Support full_name: if args carry full_name "owner/repo" and no owner/repo, split it.
- tools/call: unknown tool -> JSON-RPC error -32601 (never HTTP 500). Missing required arg ->
  result {content:[{type:"text", text:"...missing..."}], isError:true}.
  Results: {content:[{type:"text", text: JSON.stringify(obj)}], structuredContent: obj}.
  list_issues text must contain the issue title (include full issue objects in text).
  get_repo text must contain the repo name. create_issue/create_repo/create_pull_request/
  merge_pull_request: act on the same store; return the created object (with number/full_name).
- Malformed JSON body -> HTTP 400 + JSON-RPC error -32700 (id null).
- No Authorization -> 401 (any method on /mcp). Each request < 3s (all ops are in-memory; trivially met).
- Concurrent calls: stateless handler; echo each request's own id.

## Git rules (from spec-git.md — git implementer reads the full spec)
- Smart HTTP at /{owner}/{repo}.git/info/refs?service=git-upload-pack|git-receive-pack,
  POST /{owner}/{repo}.git/git-upload-pack, POST /{owner}/{repo}.git/git-receive-pack.
- upload-pack protocol v2 when Git-Protocol: version=2 (capability advertisement + ls-refs + fetch);
  v0 fallback otherwise. receive-pack v0 only, advertise report-status, side-band-64k, delete-refs.
- v0 advertisements open with "# service=git-upload-pack" / "# service=git-receive-pack" preamble;
  v2 advertisement opens with "version 2". Missing repo -> 404 on GET /info/refs; server stays up.
- Fast-forward only: non-FF push refused per ref "ng <ref> non-fast-forward", ref does not move;
  mixed push applies FF refs (ok) and refuses others (one report line each).
- Packfiles: parse inbound packs (full objects + OFS_DELTA/REF_DELTA), generate valid packs
  (full objects; deltas optional unless spec says required). zlib via node:zlib. SHA-1 via node:crypto.

## Perf notes (all implementers)
- Hot paths must be fast: issue GET (2000 sequential, ~0.45ms budget at ref), issue create,
  push (pack parse/store), shallow clone (pack gen for tip only). Keep handlers synchronous
  in-memory work; no per-request file I/O; no Date.now() in responses (logical clock only).
- Node http server: use node:http createServer; read bodies as Buffers; keep-alive is default.
