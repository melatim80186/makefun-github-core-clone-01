# github-core-clone-01 — DESIGN (implementation contract)

Contest: github-core-clone-01, $500, Node 22 standard library only, a single process.
Source specs (in the contest folder, not the repo): spec-rest.md,
spec-graphql-mcp.md, spec-runner-scoring.md, spec-git.md.
The suite runs 120 checks: git 30, repos 15, issues 15, pulls 20, graphql 20,
mcp 15, protocol 5.

## Files
- `main.ts` — entrypoint lifecycle (bind an ephemeral port, POST /register, poll /done, exit 0).
- `app.ts` — HTTP server, routing, auth, plus the JSON helpers.
- `store.ts` — in-memory forge state (its API below is FROZEN).
- `gitobj.ts` — pure git object model: sha1, blob/tree/commit bytes, tree build/parse.
- `rest.ts` — REST v3 handlers. Export: `handleRest(req, res, ctx)`.
- `graphql.ts` — GraphQL executor. Export: `handleGraphQL(req, res, ctx)`.
- `mcp.ts` — MCP endpoint. Export: `handleMcp(req, res, ctx)`.
- `git.ts` — smart-HTTP handlers. Export: `handleGit(req, res, ctx)`.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT), `README.md` — repo scaffolding.

## Facts that hold everywhere (do not re-derive them differently)
- Viewer login is `adaiversen` (id 1000, name `ada iversen`,
  email `adaiversen@example.invalid`), derived in store.ts by reimplementing
  wire.ts exactly: SCENARIO_SEED 0x6a09e667f3bcc909n, fnv1a64/mix64,
  scenarioRng('users'), and generateUsers over the FIRST/LAST name lists.
  The sealed env builds its scenario from the same constant seed, so the
  derivation holds in the trial.
- The default branch is `main` everywhere.
- Token: `process.env.MAKEFUN_SHOP_TOKEN ?? ''`. Auth rule: an
  `Authorization: Bearer <token>` header must match exactly on /api/v3/*,
  /api/graphql, /mcp, and /{owner}/{repo}.git/*. A missing or wrong token
  gets a 401 JSON body `{"message": "..."}`. When the env token is empty
  (local dev only), any non-empty Bearer token is accepted. `/healthz`
  takes no auth.
- Timestamps come from a logical clock in store.ts. Its base is
  MAKEFUN_TRIAL_NOW when set, otherwise 2025-01-01T00:00:00Z. Every call
  advances it by one second. ISO strings. Fully deterministic.
- X-GitHub-Request-Id is non-empty on EVERY reply: `req-<n>`, incrementing,
  with n a per-process counter.
- Every reply except 204 is `application/json; charset=utf-8` with a JSON
  body. Error bodies look like `{"message": "<non-empty string>"}`.
  An unknown route gets a JSON 404.
- A malformed JSON request body on any endpoint that reads a body gets a
  JSON 400.
- Repo `id` (databaseId): sequential integers starting at 1, in creation order.
  Issue/PR numbers share ONE counter per repo, starting at 1, +1 per issue
  or PR created.
- Global (GraphQL) ids are opaque base64url: repo `R:<dbid>`, issue
  `I:<repoDbid>:<number>`, PR `P:<repoDbid>:<number>`, comment
  `C:<repoDbid>:<issueNumber>:<commentId>`. Decode by base64url-decoding and
  splitting on ':'. Never the plain number.

## store.ts API (FROZEN — implementers code against this)
```ts
export interface User { id: number; login: string; name: string; email: string }
export const VIEWER: User; // adaiversen
export const SHOP_TOKEN: string;
export const DEFAULT_BRANCH = 'main';
export function nowIso(): string;      // logical clock, +1s per call
export function nowEpochSec(): number; // same clock as epoch seconds
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
  // Commit `changes` (path -> Buffer content, or null to delete) on `branch`; returns the commit sha.
  // Creates blob/tree/commit objects. `message` is exact. Works on an unborn repo (no parent).
  commitFiles(repo: Repo, branch: string, message: string, changes: Map<string, Buffer | null>): string;
  getFileAt(repo: Repo, ref: string, path: string): { blobSha: string; bytes: Buffer } | { error: 'not-found' | 'is-dir' };
  listDirAt(repo: Repo, ref: string, dir: string): { type: 'file' | 'dir'; name: string; path: string; sha: string }[] | { error: 'not-found' };
  listCommits(repo: Repo, ref?: string): { sha: string; message: string }[]; // newest first, walking parents
  createPull(repo: Repo, head: string, base: string, title: string, body: string): Pull | { error: 'no-head' | 'no-base' };
  getPull(repo: Repo, n: number): Pull | undefined;
  listPulls(repo: Repo, state?: string): Pull[]; // default open only; 'all' = open+closed
  pullFiles(repo: Repo, pr: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[];
  mergePull(repo: Repo, pr: Pull): { ok: true; sha: string; message: string } | { ok: false; reason: 'conflict' | 'already' };
  // Git object helpers (also used by git.ts)
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
export function buildTrees(files: Map<string, string> /* path -> blob sha */): { root: string; objects: Map<string, Buffer> };
export function makeCommit(opts: { tree: string; parents: string[]; message: string;
  authorName: string; authorEmail: string; authorTime: number; committerName: string;
  committerEmail: string; committerTime: number }): { sha: string; bytes: Buffer };
export function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string;
  authorLine: string; committerLine: string; raw: Buffer };
export function parseTree(data: Buffer): { mode: string; name: string; sha: string }[];
```

## REST rules (from spec-rest.md — implementers read the full spec)
- Everything lives under /api/v3. GET / and /api/v3 both answer 200 with
  an X-OAuth-Scopes header of `repo, read:org`.
- GET /meta answers 200 `{"installed_version": "1.0.0"}` (any non-empty string).
- POST /user/repos answers 201 with the repo object; a duplicate name gets
  422. GET /user/repos paginates on per_page (default 30, cap 100) with a
  Link rel="next" header holding absolute same-origin URLs.
- A repo object carries name, full_name, private, description,
  default_branch, owner{login}, id, html_url, clone_url, git_url, ssh_url,
  created_at, updated_at, pushed_at (extra fields are allowed).
- PATCH a repo with {description} answers 200 and persists. DELETE a repo
  answers 204, and a later GET is 404.
- POST /git/refs {ref:"refs/heads/x", sha} answers 201 {ref, object:{sha}}.
  GET /branches answers [{name, commit:{sha}}].
- GET /commits?sha=<branch> answers [{sha, commit:{message, author,
  committer}}]; with no sha it walks the default branch history.
- PUT contents {message, content(base64), sha?, branch?} answers 201 on
  create and 200-or-201 on update; a stale sha gets 409. The response is
  {content:{sha, encoding:"base64"}, commit:{sha}}. GET contents for a file
  answers {type:"file", encoding:"base64", content, sha, size}; for a
  directory it answers an array of {type,name,path,sha}; a missing path
  gets 404. DELETE contents {message, sha} answers 200 {commit:{sha}}.
- POST labels {name, color} answers 201 {name}. POST issues {title, body,
  labels?} answers 201 with an open issue; an unknown label gets 422. An
  issue object carries number, title, body, state, labels[{name}], id,
  user{login}, created_at, updated_at, html_url, url. GET /issues accepts
  ?state=&sort=created&direction=&per_page=. GET/PATCH /issues/{n} work,
  and closing an issue via PATCH persists. Comments POST answers 201
  {id, body}; GET lists them.
- POST pulls {head, base, title, body} answers 201 {number, state:"open",
  title, body, head:{ref,sha}, base:{ref,sha}, merged:false, merged_at:null,
  merge_commit_sha:null}. GET /pulls/{n} fetches one. GET /pulls/{n}/files
  answers [{filename, status, additions, deletions, changes}]. PUT
  /pulls/{n}/merge {merge_method:"squash"} answers 200 {merged:true, sha,
  message}; an unknown PR gets 404, a conflicted one 405. After a merge the
  PR is closed, merged is true, merged_at is set, merge_commit_sha equals
  the merge sha, and a squash commit with the head content lands on the
  default branch.
- A foreign owner (owner != viewer login) on any /repos/{owner}/... route
  gets 404, never 403.

## GraphQL rules (from spec-graphql-mcp.md — implementers read the full spec)
- POST /api/graphql only. A single {query, variables} answers {data,
  errors?}; an array body answers an array of results, in order.
- viewer.login is the viewer login. repository(owner,name) is nullable; an
  unknown repo gives data.repository null and no errors.
- Introspection __type for Issue/PullRequest/Repository/SearchType must
  return the exact required field lists (see spec A.2). The alias form must
  be honoured (data.Issue / data.PullRequest / ...).
- repository.issues(first, states:[OPEN], orderBy:{CREATED_AT,DESC}, after)
  answers nodes + pageInfo{hasNextPage,endCursor}; DESC order means number
  descending; states filter; first caps; cursor pagination (cursor =
  base64 of the issue number offset).
- issue(number), pullRequests(first), pullRequest(number){files(first){
  nodes{path}}}, and node(id: ID!) with ... on Repository {name,
  nameWithOwner}.
- Mutations: createIssue{repositoryId,title,body}, closeIssue{issueId},
  createPullRequest{repositoryId, baseRefName,headRefName,title},
  mergePullRequest{pullRequestId, mergeMethod:'SQUASH'},
  addComment{subjectId, body} -> commentEdge{node{id,body}}.
- An unknown field (e.g. noSuchFieldOnViewer) answers HTTP 200 with an
  errors array whose message contains the field name.
- Global ids are opaque and stable (see store globalId). databaseId is the
  repo id (int).
- viewerPermission is "ADMIN". hasIssuesEnabled is true. mergeable is
  "MERGEABLE" unless the store's merge conflict check says otherwise
  ("CONFLICTING").
- GraphQL states are 'OPEN'/'CLOSED' (uppercase). The issue state field
  returns 'OPEN'/'CLOSED'.
- Unauthenticated answers 401 exactly.

## MCP rules (from spec-graphql-mcp.md — implementers read the full spec)
- POST /mcp only (plus DELETE /mcp -> 200 {}). JSON-RPC 2.0, with
  application/json responses.
- server/discover answers result {supportedVersions:
  ["2026-07-28","2025-11-25","2025-06-18","2025-03-26","2024-11-05"],
  serverInfo:{name:"github-core-clone-forge",version:"1.0.0"},
  capabilities:{tools:{}}}.
- initialize answers result {protocolVersion: <requested or "2025-11-25">,
  serverInfo:{...}, capabilities:{tools:{}}}.
  notifications/initialized answers 202 with no body.
- tools/list answers {tools: [6 tools]}; byte-identical across calls
  (a static array). The tools, with their exact property names (the suite
  maps args onto these):
  create_repo {name, description?, private?} required [name];
  get_repo {owner, repo} required [owner, repo];
  create_issue {owner, repo, title, body?} required [owner, repo, title];
  list_issues {owner, repo, state?} required [owner, repo];
  create_pull_request {owner, repo, title, body?, head, base} required
  [owner, repo, title, head, base];
  merge_pull_request {owner, repo, pull_number} required
  [owner, repo, pull_number].
  Every tool has a non-empty description and an inputSchema of
  {type:"object", properties:{...}, required:[...]}.
  Support full_name: when args carry full_name "owner/repo" and no
  owner/repo, split it.
- tools/call: an unknown tool gets JSON-RPC error -32601 (never HTTP 500).
  A missing required arg gets a result of {content:[{type:"text",
  text:"...missing..."}], isError:true}. Results look like
  {content:[{type:"text", text: JSON.stringify(obj)}],
  structuredContent: obj}. The list_issues text must contain the issue
  title (put full issue objects in the text). The get_repo text must
  contain the repo name. create_issue/create_repo/create_pull_request/
  merge_pull_request act on the same store and return the created object
  (with number/full_name).
- A malformed JSON body gets HTTP 400 plus JSON-RPC error -32700 (id null).
- No Authorization gets 401 (any method on /mcp). Every request answers
  in under 3s (all ops are in-memory; trivially met).
- Concurrent calls: the handler is stateless; echo each request's own id.

## Git rules (from spec-git.md — the git implementer reads the full spec)
- Smart HTTP at /{owner}/{repo}.git/info/refs?service=git-upload-pack
  or git-receive-pack, POST /{owner}/{repo}.git/git-upload-pack, and
  POST /{owner}/{repo}.git/git-receive-pack.
- upload-pack speaks protocol v2 when Git-Protocol: version=2 (capability
  advertisement + ls-refs + fetch); v0 otherwise. receive-pack is v0 only
  and advertises report-status, side-band-64k, delete-refs.
- v0 advertisements open with a "# service=git-upload-pack" /
  "# service=git-receive-pack" preamble; a v2 advertisement opens with
  "version 2". A missing repo gets 404 on GET /info/refs; the server
  stays up.
- Fast-forward only: a non-FF push is refused per ref with
  "ng <ref> non-fast-forward" and the ref does not move; a mixed push
  applies the FF refs (ok) and refuses the others (one report line each).
- Packfiles: parse inbound packs (full objects plus OFS_DELTA/REF_DELTA)
  and generate valid packs (full objects; deltas optional unless the spec
  says required). zlib via node:zlib. SHA-1 via node:crypto.

## Perf notes (all implementers)
- The hot paths must be fast: issue GET (2000 sequential, ~0.45ms budget
  at the reference), issue create, push (pack parse/store), and shallow
  clone (pack generation for the tip only). Keep handlers to synchronous
  in-memory work; no per-request file I/O; no Date.now() in responses
  (logical clock only).
- Node http server: use node:http createServer; read bodies as Buffers;
  keep-alive is the default.

## Rebuild note (2026-11-14)
- main.ts, app.ts, httputil.ts, gitobj.ts, rest.ts, mcp.ts, DESIGN.md, and
  README.md were re-authored after the competition opened so the bundled
  transcripts cover the entry; git.ts and store.ts are untouched (their
  protocol and store behaviour is verified and perf-critical).
- The re-authoring keeps the wire contract identical: same routes, same
  status codes, same JSON shapes, same error strings, same tool schemas.
  Anything that changes observable behaviour is a bug, not a cleanup.
