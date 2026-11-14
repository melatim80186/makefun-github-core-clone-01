// Pure git object model: SHA-1, blob/tree/commit/tag bytes, tree build/parse.
// No I/O, no state. Used by store.ts and git.ts.
import { createHash } from 'node:crypto';

export function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The on-disk object bytes: "<type> <len>\0" + data. */
export function gitObjectBytes(type: string, data: Buffer): Buffer {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return Buffer.concat([header, data]);
}

export function makeBlob(content: Buffer): { sha: string; bytes: Buffer } {
  const bytes = gitObjectBytes('blob', content);
  return { sha: sha1(bytes), bytes };
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/** Parse a raw tree object body into entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space === -1) break;
    const mode = data.subarray(i, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    i = nul + 21;
  }
  return entries;
}

function serializeTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/**
 * Build every tree object for a flat file map (path -> blob sha).
 * Returns the root tree sha plus all tree objects (sha -> raw tree bytes).
 * Tree entries are sorted git-style: by name, directories as if suffixed with '/'.
 */
export function buildTrees(files: Map<string, string>): { root: string; objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  // dir path -> Map<name, {mode, sha}>
  const dirs = new Map<string, Map<string, { mode: string; sha: string }>>();
  const ensureDir = (dir: string): Map<string, { mode: string; sha: string }> => {
    let d = dirs.get(dir);
    if (!d) {
      d = new Map();
      dirs.set(dir, d);
    }
    return d;
  };
  ensureDir('');
  for (const [path, blobSha] of files) {
    const parts = path.split('/');
    let dir = '';
    for (let i = 0; i < parts.length - 1; i += 1) {
      const name = parts[i] as string;
      const parent = ensureDir(dir);
      const childDir = dir === '' ? name : `${dir}/${name}`;
      ensureDir(childDir);
      if (!parent.has(name)) parent.set(name, { mode: '40000', sha: '' });
      dir = childDir;
    }
    const leaf = parts[parts.length - 1] as string;
    ensureDir(dir).set(leaf, { mode: '100644', sha: blobSha });
  }
  // Build bottom-up: deepest dirs first ('': depth 0).
  const depth = (d: string): number => (d === '' ? 0 : d.split('/').length);
  const dirPaths = [...dirs.keys()].sort((a, b) => depth(b) - depth(a));
  const dirSha = new Map<string, string>();
  for (const dir of dirPaths) {
    const entries = [...(dirs.get(dir) as Map<string, { mode: string; sha: string }>).entries()].map(
      ([name, v]) => ({ mode: v.mode, name, sha: v.mode === '40000' ? (dirSha.get(dir === '' ? name : `${dir}/${name}`) as string) : v.sha }),
    );
    entries.sort((a, b) => {
      const ka = a.mode === '40000' ? `${a.name}/` : a.name;
      const kb = b.mode === '40000' ? `${b.name}/` : b.name;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const raw = serializeTree(entries);
    const sha = sha1(gitObjectBytes('tree', raw));
    objects.set(sha, raw);
    dirSha.set(dir, sha);
  }
  return { root: dirSha.get('') as string, objects };
}

export interface CommitOptions {
  tree: string;
  parents: string[];
  message: string;
  authorName: string;
  authorEmail: string;
  authorTime: number;
  committerName: string;
  committerEmail: string;
  committerTime: number;
}

export function makeCommit(opts: CommitOptions): { sha: string; bytes: Buffer } {
  const lines: string[] = [`tree ${opts.tree}`];
  for (const p of opts.parents) lines.push(`parent ${p}`);
  lines.push(`author ${opts.authorName} <${opts.authorEmail}> ${opts.authorTime} +0000`);
  lines.push(`committer ${opts.committerName} <${opts.committerEmail}> ${opts.committerTime} +0000`);
  const message = opts.message.endsWith('\n') ? opts.message : `${opts.message}\n`;
  const raw = Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
  const bytes = gitObjectBytes('commit', raw);
  return { sha: sha1(bytes), bytes };
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  authorLine: string;
  committerLine: string;
  message: string;
  raw: Buffer;
}

/** Parse a raw commit object body. Message has one trailing newline stripped. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank === -1 ? text : text.slice(0, blank);
  let message = blank === -1 ? '' : text.slice(blank + 2);
  if (message.endsWith('\n')) message = message.slice(0, -1);
  let tree = '';
  const parents: string[] = [];
  let authorLine = '';
  let committerLine = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) committerLine = line.slice(10);
  }
  return { tree, parents, authorLine, committerLine, message, raw: data };
}

/** Parse "Name <email> 1234567890 +0000" into parts; falls back to raw string. */
export function parseIdent(line: string): { name: string; email: string; time: number } {
  const m = /^(.*) <([^>]*)> (\d+) [+-]\d{4}$/.exec(line.trim());
  if (!m) return { name: line.trim(), email: '', time: 0 };
  return { name: m[1] as string, email: m[2] as string, time: Number(m[3]) };
}
