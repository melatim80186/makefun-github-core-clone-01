// Pure git object model: SHA-1 ids, blob/tree/commit/tag bytes, and tree
// building/parsing. No I/O and no mutable state — store.ts and git.ts call
// into here for everything content-addressed.
import { createHash } from 'node:crypto';

export function sha1(data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(data);
  return hash.digest('hex');
}

/** The stored bytes of an object: "<type> <length>\0" followed by the payload. */
export function gitObjectBytes(type: string, data: Buffer): Buffer {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return Buffer.concat([head, data]);
}

export function makeBlob(content: Buffer): { sha: string; bytes: Buffer } {
  const raw = gitObjectBytes('blob', content);
  return { sha: sha1(raw), bytes: raw };
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/** Parse a raw tree body into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const found: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const sp = data.indexOf(0x20, pos);
    if (sp === -1) break;
    const mode = data.subarray(pos, sp).toString('ascii');
    const zero = data.indexOf(0x00, sp + 1);
    if (zero === -1) break;
    const name = data.subarray(sp + 1, zero).toString('utf8');
    const sha = data.subarray(zero + 1, zero + 21).toString('hex');
    found.push({ mode, name, sha });
    pos = zero + 21;
  }
  return found;
}

function encodeTree(entries: TreeEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    chunks.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    chunks.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(chunks);
}

/** Sort key for a tree entry: directories compare as if named with '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/**
 * Build every tree object for a flat file map (path -> blob sha).
 * Returns the root tree sha plus all tree objects (sha -> raw tree bytes).
 * Entries sort git-style: by name, directories as if suffixed with '/'.
 */
export function buildTrees(files: Map<string, string>): { root: string; objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  // Directory path -> its entries (name -> {mode, sha}; subtree shas filled later).
  const byDir = new Map<string, Map<string, { mode: string; sha: string }>>();
  const dirMap = (dir: string): Map<string, { mode: string; sha: string }> => {
    let table = byDir.get(dir);
    if (table === undefined) {
      table = new Map();
      byDir.set(dir, table);
    }
    return table;
  };
  dirMap('');
  for (const [path, blobSha] of files) {
    const parts = path.split('/');
    let dir = '';
    for (let depth = 0; depth < parts.length - 1; depth += 1) {
      const segment = parts[depth] as string;
      const parent = dirMap(dir);
      const child = dir === '' ? segment : `${dir}/${segment}`;
      dirMap(child);
      if (!parent.has(segment)) parent.set(segment, { mode: '40000', sha: '' });
      dir = child;
    }
    const leaf = parts[parts.length - 1] as string;
    dirMap(dir).set(leaf, { mode: '100644', sha: blobSha });
  }
  // Build bottom-up: deepest directories first ('' is depth 0).
  const dirDepth = (d: string): number => (d === '' ? 0 : d.split('/').length);
  const ordered = [...byDir.keys()].sort((a, b) => dirDepth(b) - dirDepth(a));
  const shaOfDir = new Map<string, string>();
  for (const dir of ordered) {
    const rows: TreeEntry[] = [];
    for (const [name, value] of dirMap(dir).entries()) {
      const sha = value.mode === '40000'
        ? (shaOfDir.get(dir === '' ? name : `${dir}/${name}`) as string)
        : value.sha;
      rows.push({ mode: value.mode, name, sha });
    }
    rows.sort((a, b) => {
      const ka = treeSortKey(a);
      const kb = treeSortKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const raw = encodeTree(rows);
    const sha = sha1(gitObjectBytes('tree', raw));
    objects.set(sha, raw);
    shaOfDir.set(dir, sha);
  }
  return { root: shaOfDir.get('') as string, objects };
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
  const head: string[] = [`tree ${opts.tree}`];
  for (const parent of opts.parents) head.push(`parent ${parent}`);
  head.push(`author ${opts.authorName} <${opts.authorEmail}> ${opts.authorTime} +0000`);
  head.push(`committer ${opts.committerName} <${opts.committerEmail}> ${opts.committerTime} +0000`);
  const body = opts.message.endsWith('\n') ? opts.message : `${opts.message}\n`;
  const raw = Buffer.from(`${head.join('\n')}\n\n${body}`, 'utf8');
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

/** Parse a raw commit body. The message loses one trailing newline, if any. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const gap = text.indexOf('\n\n');
  const head = gap === -1 ? text : text.slice(0, gap);
  let message = gap === -1 ? '' : text.slice(gap + 2);
  if (message.endsWith('\n')) message = message.slice(0, -1);
  let tree = '';
  const parents: string[] = [];
  let authorLine = '';
  let committerLine = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) committerLine = line.slice(10);
  }
  return { tree, parents, authorLine, committerLine, message, raw: data };
}

/** Split "Name <email> 1234567890 +0000" into parts; anything else stays raw. */
export function parseIdent(line: string): { name: string; email: string; time: number } {
  const m = /^(.*) <([^>]*)> (\d+) [+-]\d{4}$/.exec(line.trim());
  if (m === null) return { name: line.trim(), email: '', time: 0 };
  return { name: m[1] as string, email: m[2] as string, time: Number(m[3]) };
}
