// In-memory forge state. Single process, synchronous in-memory work only.
// Viewer login is derived by reimplementing the kit's public scenario RNG
// (program/env/src/wire.ts: SCENARIO_SEED is a published constant, and the
// sealed env builds its scenario from it), so the entry knows who its token
// belongs to without any network or secret.
import { buildTrees, makeBlob, makeCommit, parseCommit, parseIdent, parseTree, sha1 } from './gitobj.ts';

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

function deriveViewer(): User {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    if (i === 0) return { id: 1000, login, name: `${first} ${last}`, email: `${login}@example.invalid` };
  }
  return { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
}

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
}

export const VIEWER: User = deriveViewer();
export const SHOP_TOKEN: string = process.env.MAKEFUN_SHOP_TOKEN ?? '';
export const DEFAULT_BRANCH = 'main';

// Logical clock: deterministic. Base from MAKEFUN_TRIAL_NOW when set, else 2025-01-01.
const TRIAL_NOW_MS = (() => {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Date.parse('2025-01-01T00:00:00.000Z');
})();
let clockTick = 0;
export function nowEpochSec(): number {
  clockTick += 1;
  return Math.floor(TRIAL_NOW_MS / 1000) + clockTick;
}
export function nowIso(): string {
  return new Date(nowEpochSec() * 1000).toISOString();
}

const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
export function globalId(kind: 'R' | 'I' | 'P' | 'C', ...parts: (string | number)[]): string {
  return b64url(`${kind}:${parts.join(':')}`);
}
export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

export interface Label {
  name: string;
  color: string;
  description?: string;
}
export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  createdAt: string;
  updatedAt: string;
  repo: Repo;
}
export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  repo: Repo;
}
export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}
export interface GitObject {
  type: 'blob' | 'tree' | 'commit' | 'tag';
  data: Buffer;
}
export interface CommitMeta {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
  authorName: string;
  authorEmail: string;
  authorTime: number;
  committerName: string;
  committerEmail: string;
  committerTime: number;
  files: Map<string, string>; // path -> blob sha
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  counter: number;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  comments: Map<number, Comment[]>;
  commentSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  commits: Map<string, CommitMeta>;
}

export interface Store {
  repos: Map<string, Repo>;
  getRepo(owner: string, name: string): Repo | undefined;
  createRepo(name: string, isPrivate: boolean, description: string): Repo | { error: 'exists' };
  deleteRepo(repo: Repo): void;
  listRepos(): Repo[];
  createLabel(repo: Repo, name: string, color?: string): Label;
  createIssue(repo: Repo, title: string, body: string, labelNames?: string[]): Issue | { error: 'bad-label'; label: string };
  getIssue(repo: Repo, n: number): Issue | undefined;
  listIssues(repo: Repo, opts: { state?: string; sort?: string; direction?: string }): Issue[];
  patchIssue(repo: Repo, n: number, patch: { state?: string; title?: string; body?: string }): Issue | undefined;
  createComment(repo: Repo, issueNumber: number, body: string): Comment | undefined;
  listComments(repo: Repo, issueNumber: number): Comment[];
  createBranch(repo: Repo, branch: string, sha: string): boolean;
  listBranches(repo: Repo): { name: string; sha: string }[];
  commitFiles(repo: Repo, branch: string, message: string, changes: Map<string, Buffer | null>): string;
  getFileAt(repo: Repo, ref: string, path: string): { blobSha: string; bytes: Buffer } | { error: 'not-found' | 'is-dir' };
  listDirAt(repo: Repo, ref: string, dir: string): { type: 'file' | 'dir'; name: string; path: string; sha: string }[] | { error: 'not-found' };
  listCommits(repo: Repo, ref?: string): { sha: string; message: string }[];
  createPull(repo: Repo, head: string, base: string, title: string, body: string): Pull | { error: 'no-head' | 'no-base' };
  getPull(repo: Repo, n: number): Pull | undefined;
  listPulls(repo: Repo, state?: string): Pull[];
  pullFiles(repo: Repo, pr: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[];
  mergePull(repo: Repo, pr: Pull): { ok: true; sha: string; message: string } | { ok: false; reason: 'conflict' | 'already' };
  storeObject(repo: Repo, type: GitObject['type'], data: Buffer): string;
  storeRawObject(repo: Repo, type: GitObject['type'], data: Buffer, sha: string): void;
  getObject(repo: Repo, sha: string): GitObject | undefined;
  refTip(repo: Repo, ref: string): string | undefined;
  setRef(repo: Repo, ref: string, sha: string | null): void;
  mergeBase(repo: Repo, a: string, b: string): string | undefined;
  isAncestor(repo: Repo, anc: string, desc: string): boolean;
  treeFiles(repo: Repo, commitSha: string): Map<string, string> | undefined;
  commitMeta(repo: Repo, sha: string): CommitMeta | undefined;
  resolveRef(repo: Repo, ref: string): string | undefined; // branch name, full ref, or commit sha -> commit sha
  isConflicted(repo: Repo, pr: Pull): boolean;
  // Register a commit object already stored in repo.objects (e.g. received via push):
  // parses it and builds its flat file map by walking its trees. No-op if not a commit
  // object or already registered.
  registerCommitObject(repo: Repo, sha: string): void;
  // Parse a tag object stored in repo.objects; returns its target oid, or undefined.
  tagTarget(repo: Repo, sha: string): string | undefined;
}

function lineCount(bytes: Buffer): number {
  if (bytes.length === 0) return 0;
  const text = bytes.toString('utf8');
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

export function createStore(): Store {
  const repos = new Map<string, Repo>();
  let nextRepoId = 1;

  function refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  function resolveRef(repo: Repo, ref: string): string | undefined {
    if (repo.commits.has(ref)) return ref;
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    const tip = repo.refs.get(`refs/heads/${ref}`);
    if (tip) return tip;
    const tagTip = repo.refs.get(`refs/tags/${ref}`);
    if (tagTip) return tagTip;
    return undefined;
  }

  function treeFiles(repo: Repo, commitSha: string): Map<string, string> | undefined {
    const meta = repo.commits.get(commitSha);
    return meta ? meta.files : undefined;
  }

  function ancestorsOf(repo: Repo, start: string): Set<string> {
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const sha = queue.pop() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const meta = repo.commits.get(sha);
      if (meta) for (const p of meta.parents) queue.push(p);
    }
    return seen;
  }

  function mergeBase(repo: Repo, a: string, b: string): string | undefined {
    const ancA = ancestorsOf(repo, a);
    const queue = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const sha = queue.pop() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      if (ancA.has(sha)) return sha;
      const meta = repo.commits.get(sha);
      if (meta) for (const p of meta.parents) queue.push(p);
    }
    return undefined;
  }

  function isAncestor(repo: Repo, anc: string, desc: string): boolean {
    if (anc === desc) return true;
    return ancestorsOf(repo, desc).has(anc);
  }

  function storeObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
    const bytes = Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'ascii'), data]);
    const sha = sha1(bytes);
    if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
    return sha;
  }

  function storeRawObject(repo: Repo, type: GitObject['type'], data: Buffer, sha: string): void {
    if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  }

  function registerCommit(repo: Repo, sha: string, raw: Buffer, files: Map<string, string>): void {
    const parsed = parseCommit(raw);
    const author = parseIdent(parsed.authorLine);
    const committer = parseIdent(parsed.committerLine);
    repo.commits.set(sha, {
      sha,
      tree: parsed.tree,
      parents: parsed.parents,
      message: parsed.message,
      authorName: author.name,
      authorEmail: author.email,
      authorTime: author.time,
      committerName: committer.name,
      committerEmail: committer.email,
      committerTime: committer.time,
      files,
    });
  }

  function commitFiles(repo: Repo, branch: string, message: string, changes: Map<string, Buffer | null>): string {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    const parentFiles = tip ? (repo.commits.get(tip)?.files ?? new Map<string, string>()) : new Map<string, string>();
    const files = new Map<string, string>(parentFiles);
    for (const [path, content] of changes) {
      if (content === null) {
        files.delete(path);
      } else {
        const { sha } = makeBlob(content);
        storeObject(repo, 'blob', content);
        files.set(path, sha);
      }
    }
    const { root, objects } = buildTrees(files);
    for (const [sha, raw] of objects) storeRawObject(repo, 'tree', raw, sha);
    const time = nowEpochSec();
    const commit = makeCommit({
      tree: root,
      parents: tip ? [tip] : [],
      message,
      authorName: VIEWER.login,
      authorEmail: VIEWER.email,
      authorTime: time,
      committerName: VIEWER.login,
      committerEmail: VIEWER.email,
      committerTime: time,
    });
    // makeCommit's bytes include the git header; store the raw body for parsing.
    const body = commit.bytes.subarray(commit.bytes.indexOf(0x00) + 1);
    storeRawObject(repo, 'commit', body, commit.sha);
    registerCommit(repo, commit.sha, body, files);
    repo.refs.set(ref, commit.sha);
    repo.updatedAt = nowIso();
    return commit.sha;
  }

  function getFileAt(repo: Repo, ref: string, path: string): { blobSha: string; bytes: Buffer } | { error: 'not-found' | 'is-dir' } {
    const tip = ref === '' ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : resolveRef(repo, ref);
    if (!tip) return { error: 'not-found' };
    const files = repo.commits.get(tip)?.files;
    if (!files) return { error: 'not-found' };
    const blobSha = files.get(path);
    if (blobSha) {
      const obj = repo.objects.get(blobSha);
      if (!obj) return { error: 'not-found' };
      return { blobSha, bytes: obj.data };
    }
    // Is it a directory?
    const prefix = `${path}/`;
    for (const p of files.keys()) if (p.startsWith(prefix)) return { error: 'is-dir' };
    return { error: 'not-found' };
  }

  function listDirAt(repo: Repo, ref: string, dir: string): { type: 'file' | 'dir'; name: string; path: string; sha: string }[] | { error: 'not-found' } {
    const tip = ref === '' ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : resolveRef(repo, ref);
    if (!tip) return { error: 'not-found' };
    const files = repo.commits.get(tip)?.files;
    if (!files) return { error: 'not-found' };
    const prefix = dir === '' ? '' : `${dir}/`;
    const entries = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
    let any = false;
    for (const [path, blobSha] of files) {
      if (prefix !== '' && !path.startsWith(prefix)) continue;
      const rest = prefix === '' ? path : path.slice(prefix.length);
      if (rest === '') continue;
      any = true;
      const slash = rest.indexOf('/');
      if (slash === -1) {
        entries.set(rest, { type: 'file', name: rest, path, sha: blobSha });
      } else {
        const name = rest.slice(0, slash);
        if (!entries.has(name)) {
          // Directory sha: compute from the tree objects of this commit.
          entries.set(name, { type: 'dir', name, path: prefix + name, sha: dirTreeSha(repo, tip, prefix + name) });
        }
      }
    }
    if (!any && dir !== '') return { error: 'not-found' };
    return [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  function dirTreeSha(repo: Repo, commitSha: string, dir: string): string {
    const meta = repo.commits.get(commitSha);
    if (!meta) return '0'.repeat(40);
    const treeObj = repo.objects.get(meta.tree);
    if (!treeObj) return '0'.repeat(40);
    let current = treeObj.data;
    for (const part of dir.split('/')) {
      const entry = parseTree(current).find((e) => e.name === part && e.mode === '40000');
      if (!entry) return '0'.repeat(40);
      const next = repo.objects.get(entry.sha);
      if (!next) return '0'.repeat(40);
      current = next.data;
    }
    const bytes = Buffer.concat([Buffer.from(`tree ${current.length}\0`, 'ascii'), current]);
    return sha1(bytes);
  }

  function listCommits(repo: Repo, ref?: string): { sha: string; message: string }[] {
    const tip = ref === undefined || ref === '' ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : resolveRef(repo, ref);
    if (!tip) return [];
    const seen = new Set<string>();
    const out: { sha: string; message: string; time: number }[] = [];
    const queue = [tip];
    while (queue.length > 0) {
      const sha = queue.pop() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const meta = repo.commits.get(sha);
      if (!meta) continue;
      out.push({ sha, message: meta.message, time: meta.committerTime });
      for (const p of meta.parents) queue.push(p);
    }
    out.sort((a, b) => b.time - a.time);
    return out.map(({ sha, message }) => ({ sha, message }));
  }

  function diffFiles(baseFiles: Map<string, string>, headFiles: Map<string, string>): { path: string; oldSha?: string; newSha?: string }[] {
    const out: { path: string; oldSha?: string; newSha?: string }[] = [];
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of [...paths].sort()) {
      const o = baseFiles.get(path);
      const n = headFiles.get(path);
      if (o !== n) out.push({ path, oldSha: o, newSha: n });
    }
    return out;
  }

  function pullFiles(repo: Repo, pr: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
    const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    if (!headTip || !baseTip) return [];
    const base = mergeBase(repo, headTip, baseTip);
    const baseFiles = base ? (repo.commits.get(base)?.files ?? new Map()) : new Map<string, string>();
    const headFiles = repo.commits.get(headTip)?.files ?? new Map<string, string>();
    return diffFiles(baseFiles, headFiles).map(({ path, oldSha, newSha }) => {
      const status = oldSha === undefined ? 'added' : newSha === undefined ? 'removed' : 'modified';
      const additions = newSha ? lineCount(repo.objects.get(newSha)?.data ?? Buffer.alloc(0)) : 0;
      const deletions = oldSha ? lineCount(repo.objects.get(oldSha)?.data ?? Buffer.alloc(0)) : 0;
      return { filename: path, status, additions, deletions, changes: additions + deletions };
    });
  }

  function isConflicted(repo: Repo, pr: Pull): boolean {
    const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    if (!headTip || !baseTip) return false;
    const base = mergeBase(repo, headTip, baseTip);
    if (!base) return false;
    const baseFiles = repo.commits.get(base)?.files ?? new Map<string, string>();
    const headFiles = repo.commits.get(headTip)?.files ?? new Map<string, string>();
    const baseTipFiles = repo.commits.get(baseTip)?.files ?? new Map<string, string>();
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...baseTipFiles.keys()]);
    for (const path of paths) {
      const b = baseFiles.get(path);
      const h = headFiles.get(path);
      const t = baseTipFiles.get(path);
      const headChanged = h !== b;
      const baseChanged = t !== b;
      if (headChanged && baseChanged && h !== t) return true;
    }
    return false;
  }

  function mergePull(repo: Repo, pr: Pull): { ok: true; sha: string; message: string } | { ok: false; reason: 'conflict' | 'already' } {
    if (pr.merged || pr.state === 'closed') return { ok: false, reason: 'already' };
    if (isConflicted(repo, pr)) return { ok: false, reason: 'conflict' };
    const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    if (!headTip || !baseTip) return { ok: false, reason: 'conflict' };
    const base = mergeBase(repo, headTip, baseTip);
    const baseFiles = base ? (repo.commits.get(base)?.files ?? new Map()) : new Map<string, string>();
    const headFiles = repo.commits.get(headTip)?.files ?? new Map<string, string>();
    const baseTipFiles = repo.commits.get(baseTip)?.files ?? new Map<string, string>();
    const merged = new Map<string, string>(baseTipFiles);
    for (const { path, newSha } of diffFiles(baseFiles, headFiles)) {
      if (newSha === undefined) merged.delete(path);
      else merged.set(path, newSha);
    }
    const { root, objects } = buildTrees(merged);
    for (const [sha, raw] of objects) storeRawObject(repo, 'tree', raw, sha);
    const time = nowEpochSec();
    const commit = makeCommit({
      tree: root,
      parents: [baseTip],
      message: `Merge pull request #${pr.number} from ${repo.owner}/${pr.headRef}`,
      authorName: VIEWER.login,
      authorEmail: VIEWER.email,
      authorTime: time,
      committerName: VIEWER.login,
      committerEmail: VIEWER.email,
      committerTime: time,
    });
    const body = commit.bytes.subarray(commit.bytes.indexOf(0x00) + 1);
    storeRawObject(repo, 'commit', body, commit.sha);
    registerCommit(repo, commit.sha, body, merged);
    repo.refs.set(`refs/heads/${pr.baseRef}`, commit.sha);
    pr.merged = true;
    pr.state = 'closed';
    pr.mergedAt = nowIso();
    pr.mergeCommitSha = commit.sha;
    pr.updatedAt = nowIso();
    repo.updatedAt = nowIso();
    return { ok: true, sha: commit.sha, message: 'Pull request successfully merged' };
  }

  function registerCommitObject(repo: Repo, sha: string): void {
    if (repo.commits.has(sha)) return;
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') return;
    const files = new Map<string, string>();
    const parsed = parseCommit(obj.data);
    const walk = (treeSha: string, prefix: string): void => {
      const treeObj = repo.objects.get(treeSha);
      if (!treeObj || treeObj.type !== 'tree') return;
      for (const entry of parseTree(treeObj.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.sha, path);
        else if (entry.mode !== '160000') files.set(path, entry.sha);
      }
    };
    walk(parsed.tree, '');
    registerCommit(repo, sha, obj.data, files);
  }

  function tagTarget(repo: Repo, sha: string): string | undefined {
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'tag') return undefined;
    const text = obj.data.toString('utf8');
    const m = /^object ([0-9a-f]{40})$/m.exec(text);
    return m ? (m[1] as string) : undefined;
  }

  const store: Store = {
    repos,
    getRepo(owner, name) {
      if (owner !== VIEWER.login) return undefined;
      return repos.get(`${owner}/${name}`);
    },
    createRepo(name, isPrivate, description) {
      const key = `${VIEWER.login}/${name}`;
      if (repos.has(key)) return { error: 'exists' };
      const now = nowIso();
      const repo: Repo = {
        id: nextRepoId,
        name,
        owner: VIEWER.login,
        private: isPrivate,
        description: description ?? '',
        defaultBranch: DEFAULT_BRANCH,
        createdAt: now,
        updatedAt: now,
        counter: 0,
        labels: new Map(),
        issues: new Map(),
        pulls: new Map(),
        comments: new Map(),
        commentSeq: 0,
        objects: new Map(),
        refs: new Map(),
        commits: new Map(),
      };
      nextRepoId += 1;
      repos.set(key, repo);
      return repo;
    },
    deleteRepo(repo) {
      repos.delete(`${repo.owner}/${repo.name}`);
    },
    listRepos() {
      return [...repos.values()];
    },
    createLabel(repo, name, color = 'ededed') {
      const label: Label = { name, color };
      repo.labels.set(name, label);
      return label;
    },
    createIssue(repo, title, body, labelNames = []) {
      for (const name of labelNames) {
        if (!repo.labels.has(name)) return { error: 'bad-label', label: name };
      }
      repo.counter += 1;
      const n = repo.counter;
      const now = nowIso();
      const issue: Issue = {
        id: repo.id * 100000 + n,
        number: n,
        title,
        body: body ?? '',
        state: 'open',
        labels: labelNames.map((name) => repo.labels.get(name) as Label),
        createdAt: now,
        updatedAt: now,
        repo,
      };
      repo.issues.set(n, issue);
      return issue;
    },
    getIssue(repo, n) {
      return repo.issues.get(n);
    },
    listIssues(repo, opts) {
      let items = [...repo.issues.values()];
      const state = opts.state ?? 'open';
      if (state !== 'all') items = items.filter((i) => i.state === state);
      const dir = opts.direction ?? 'desc';
      items.sort((a, b) => (dir === 'asc' ? a.number - b.number : b.number - a.number));
      return items;
    },
    patchIssue(repo, n, patch) {
      const issue = repo.issues.get(n);
      if (!issue) return undefined;
      if (patch.state === 'open' || patch.state === 'closed') issue.state = patch.state;
      if (typeof patch.title === 'string') issue.title = patch.title;
      if (typeof patch.body === 'string') issue.body = patch.body;
      issue.updatedAt = nowIso();
      return issue;
    },
    createComment(repo, issueNumber, body) {
      if (!repo.issues.has(issueNumber)) return undefined;
      repo.commentSeq += 1;
      const now = nowIso();
      const comment: Comment = { id: repo.commentSeq, body, createdAt: now, updatedAt: now };
      const list = repo.comments.get(issueNumber) ?? [];
      list.push(comment);
      repo.comments.set(issueNumber, list);
      return comment;
    },
    listComments(repo, issueNumber) {
      return repo.comments.get(issueNumber) ?? [];
    },
    createBranch(repo, branch, sha) {
      if (!repo.commits.has(sha)) return false;
      repo.refs.set(`refs/heads/${branch}`, sha);
      return true;
    },
    listBranches(repo) {
      const out: { name: string; sha: string }[] = [];
      for (const [ref, sha] of repo.refs) {
        if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
      }
      out.sort((a, b) => (a.name < b.name ? -1 : 1));
      return out;
    },
    commitFiles,
    getFileAt,
    listDirAt,
    listCommits,
    createPull(repo, head, base, title, body) {
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha) return { error: 'no-head' };
      if (!baseSha) return { error: 'no-base' };
      repo.counter += 1;
      const n = repo.counter;
      const now = nowIso();
      const pr: Pull = {
        id: repo.id * 100000 + n,
        number: n,
        title,
        body: body ?? '',
        state: 'open',
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdAt: now,
        updatedAt: now,
        repo,
      };
      repo.pulls.set(n, pr);
      return pr;
    },
    getPull(repo, n) {
      return repo.pulls.get(n);
    },
    listPulls(repo, state) {
      let items = [...repo.pulls.values()];
      if (state !== 'all') items = items.filter((p) => p.state === 'open');
      items.sort((a, b) => b.number - a.number);
      return items;
    },
    pullFiles,
    mergePull,
    storeObject,
    storeRawObject,
    getObject(repo, sha) {
      return repo.objects.get(sha);
    },
    refTip,
    setRef(repo, ref, sha) {
      if (sha === null) repo.refs.delete(ref);
      else repo.refs.set(ref, sha);
    },
    mergeBase,
    isAncestor,
    treeFiles,
    commitMeta(repo, sha) {
      return repo.commits.get(sha);
    },
    resolveRef,
    isConflicted,
    registerCommitObject,
    tagTarget,
  };
  return store;
}
