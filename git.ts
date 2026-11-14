// Git smart-HTTP surface: upload-pack v2/v0, receive-pack v0, packfiles.
// Node stdlib only (node:zlib; SHA-1 via gitobj). See spec-git.md.
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gitObjectBytes, parseTree, sha1 } from './gitobj.ts';
import { jsonError, readBody, type HandlerCtx } from './httputil.ts';
import type { Repo } from './store.ts';

const ZERO_OID = '0'.repeat(40);
const PKT_MAX = 65520;
const AGENT = 'github-core-clone-forge/1.0';

// ---------------------------------------------------------------- pkt-lines

function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  if (len > PKT_MAX) throw new Error('pkt-line too long');
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

function parsePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) throw new Error('pktline-truncated');
    const head = buf.subarray(i, i + 4).toString('ascii');
    if (head === '0000') {
      out.push({ kind: 'flush' });
      i += 4;
      continue;
    }
    if (head === '0001') {
      out.push({ kind: 'delim' });
      i += 4;
      continue;
    }
    if (head === '0002') {
      out.push({ kind: 'end' });
      i += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || len > PKT_MAX) throw new Error(`invalid pkt-line length ${head}`);
    if (i + len > buf.length) throw new Error('pktline-truncated');
    out.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return out;
}

function pktText(p: Pkt): string | null {
  return p.kind === 'data' ? p.payload.toString('utf8') : null;
}

/** Sideband-wrap payload bytes into band-1 packets (<= 65516 payload each). */
function sidebandPackets(data: Buffer, band = 1): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65516 - 1;
  if (data.length === 0) return out;
  for (let i = 0; i < data.length; i += CHUNK) {
    const slice = data.subarray(i, Math.min(data.length, i + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), slice])));
  }
  return out;
}

// ---------------------------------------------------------------- packfiles

const CODE_TYPES: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_CODES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export interface PackEntry {
  type: string;
  data: Buffer;
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[i] as number;
      value |= (b & 0x7f) << shift;
      shift += 7;
      i += 1;
      if ((b & 0x80) === 0) break;
    }
    return value;
  };
  const srcSize = readVarint();
  const tgtSize = readVarint();
  if (srcSize !== base.length) throw new Error('pack-delta-base-size');
  const out: Buffer[] = [];
  let outLen = 0;
  while (i < delta.length) {
    const op = delta[i] as number;
    i += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[i] as number, i += 1;
      if (op & 0x02) offset |= (delta[i] as number) << 8, i += 1;
      if (op & 0x04) offset |= (delta[i] as number) << 16, i += 1;
      if (op & 0x08) offset |= (delta[i] as number) << 24, i += 1;
      if (op & 0x10) size = delta[i] as number, i += 1;
      if (op & 0x20) size |= (delta[i] as number) << 8, i += 1;
      if (op & 0x40) size |= (delta[i] as number) << 16, i += 1;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      outLen += size;
    } else if (op !== 0) {
      out.push(delta.subarray(i, i + op));
      outLen += op;
      i += op;
    } else {
      throw new Error('pack-delta-op0');
    }
  }
  if (outLen !== tgtSize) throw new Error('pack-delta-size');
  return Buffer.concat(out, outLen);
}

/** Adler-32 checksum (the trailer of a zlib stream). */
function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i += 1) {
    a = (a + (data[i] as number)) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Bounded inflate: find the consumed length of the zlib stream starting at
 * `offset`. inflateSync ignores trailing bytes, so one tail inflate yields the
 * data; the stream end is then located via its Adler-32 trailer (the last 4
 * bytes of the stream), verified with a single confirming inflate. Falls back
 * to a binary search if the trailer is not found (essentially never).
 */
function inflateBounded(buf: Buffer, offset: number, end: number, size: number): { data: Buffer; next: number } {
  const data = inflateSync(buf.subarray(offset, end));
  if (data.length !== size) throw new Error('pack-inflate');
  const trailer = Buffer.alloc(4);
  trailer.writeUInt32BE(adler32(data), 0);
  let searchFrom = offset + 2; // a zlib stream is at least 2 bytes
  for (;;) {
    const at = buf.indexOf(trailer, searchFrom);
    if (at === -1 || at + 4 > end) break;
    const candidateEnd = at + 4;
    try {
      const check = inflateSync(buf.subarray(offset, candidateEnd));
      if (check.length === size) return { data: check, next: candidateEnd };
    } catch {
      // Not the true end; keep scanning.
    }
    searchFrom = at + 1;
  }
  // Fallback: binary search for the smallest end that inflates to `size` bytes.
  let lo = offset + 1;
  let hi = end;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const out = inflateSync(buf.subarray(offset, mid));
      if (out.length === size) {
        found = mid;
        hi = mid - 1;
      } else if (out.length < size) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    } catch {
      lo = mid + 1;
    }
  }
  if (found === -1) throw new Error('pack-inflate');
  return { data: inflateSync(buf.subarray(offset, found)), next: found };
}

interface RawEntry {
  offset: number;
  typeCode: number;
  size: number;
  baseOffset?: number;
  baseOid?: string;
  data: Buffer; // inflated bytes (for deltas: the delta instructions)
}

/** Parse a packfile, resolving OFS_DELTA / REF_DELTA entries. */
function parsePack(buf: Buffer, repo: Repo): PackEntry[] {
  if (buf.length < 32) throw new Error('pack-too-short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack-magic');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('pack-version');
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  if (sha1(buf.subarray(0, buf.length - 20)) !== trailer.toString('hex')) throw new Error('pack-checksum');
  const rawEntries: RawEntry[] = [];
  let offset = 12;
  const end = buf.length - 20;
  for (let n = 0; n < count; n += 1) {
    const entryOffset = offset;
    const first = buf[offset] as number;
    offset += 1;
    const typeCode = (first >> 4) & 0x7;
    let size = first & 0x0f;
    let shift = 4;
    let b = first;
    while (b & 0x80) {
      b = buf[offset] as number;
      offset += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    const raw: RawEntry = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let cb = buf[offset] as number;
      offset += 1;
      let baseOffset = cb & 0x7f;
      while (cb & 0x80) {
        cb = buf[offset] as number;
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (cb & 0x7f);
      }
      raw.baseOffset = entryOffset - baseOffset;
    } else if (typeCode === 7) {
      raw.baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPES[typeCode]) {
      throw new Error('pack-type');
    }
    const inflated = inflateBounded(buf, offset, end, size);
    raw.data = inflated.data;
    offset = inflated.next;
    rawEntries.push(raw);
  }
  if (offset !== end) throw new Error('pack-trailing');
  const resolved = new Map<number, PackEntry>();
  const byOffset = new Map<number, PackEntry>();
  for (const raw of rawEntries) {
    let entry: PackEntry;
    if (raw.typeCode <= 4) {
      entry = { type: CODE_TYPES[raw.typeCode] as string, data: raw.data };
    } else if (raw.typeCode === 6) {
      const base = byOffset.get(raw.baseOffset as number);
      if (!base) throw new Error('pack-delta-base');
      entry = { type: base.type, data: applyDelta(base.data, raw.data) };
    } else {
      const baseOid = raw.baseOid as string;
      const inPack = [...byOffset.values()].find((e) => sha1(gitObjectBytes(e.type, e.data)) === baseOid);
      const stored = inPack ? undefined : repo.objects.get(baseOid);
      const base = inPack ?? (stored ? { type: stored.type, data: stored.data } : undefined);
      if (!base) throw new Error('pack-delta-base');
      entry = { type: base.type, data: applyDelta(base.data, raw.data) };
    }
    resolved.set(raw.offset, entry);
    byOffset.set(raw.offset, entry);
  }
  return rawEntries.map((r) => resolved.get(r.offset) as PackEntry);
}

/** Build a PACK v2 packfile from full objects (no deltas). */
function buildPack(entries: PackEntry[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  parts.push(header);
  for (const entry of entries) {
    const typeCode = TYPE_CODES[entry.type] as number;
    const size = entry.data.length;
    const headerBytes: number[] = [];
    let remaining = size;
    headerBytes.push(((typeCode & 0x7) << 4) | (remaining & 0x0f));
    remaining >>= 4;
    while (remaining > 0) {
      headerBytes[headerBytes.length - 1] = (headerBytes[headerBytes.length - 1] as number) | 0x80;
      headerBytes.push(remaining & 0x7f);
      remaining >>= 7;
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(entry.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1(body), 'hex')]);
}

function objectId(type: string, data: Buffer): string {
  return sha1(gitObjectBytes(type, data));
}

// Pack cache: identical fetch parameters against identical ref tips always
// produce identical packs (objects are content-addressed), so repeated clones
// of the same repo reuse one built pack. Keyed on repo id + ref tips, so any
// mutation changes the key. Bounded FIFO.
const packCache = new Map<string, Buffer>();
const PACK_CACHE_MAX = 64;

function cachedPack(repo: Repo, wants: string[], haves: Set<string>, depth: number | undefined, clientShallow: string[], objects: PackEntry[]): Buffer {
  const tips = [...repo.refs.entries()].map(([n, o]) => `${n}=${o}`).sort().join(',');
  const key = `${repo.id}|${tips}|${[...wants].sort().join(',')}|${[...haves].sort().join(',')}|${depth ?? ''}|${[...clientShallow].sort().join(',')}`;
  const hit = packCache.get(key);
  if (hit) return hit;
  const pack = buildPack(objects);
  if (packCache.size >= PACK_CACHE_MAX) {
    const oldest = packCache.keys().next().value as string | undefined;
    if (oldest !== undefined) packCache.delete(oldest);
  }
  packCache.set(key, pack);
  return pack;
}

// ---------------------------------------------------------------- reachability

interface Collected {
  objects: PackEntry[]; // in BFS discovery order (commits, then trees/blobs as found)
  boundary: string[]; // included commits whose parents are not included/fully-held
  includedCommits: Set<string>; // commits whose objects were sent
  fullHeld: Set<string>; // objects fully held via non-shallow haves (ancestry included)
}

function collectReachable(
  repo: Repo,
  wants: string[],
  haves: Set<string>,
  depth: number | undefined,
  clientShallow: string[] = [],
): Collected {
  const shallowHaveSet = new Set(clientShallow.filter((s) => haves.has(s)));
  const fullHaves = [...haves].filter((h) => !shallowHaveSet.has(h));
  // Objects fully held: everything reachable from non-shallow haves (unlimited).
  const fullHeld = new Set<string>();
  {
    const queue: string[] = [...fullHaves];
    while (queue.length > 0) {
      const sha = queue.pop() as string;
      if (fullHeld.has(sha)) continue;
      fullHeld.add(sha);
      const meta = repo.commits.get(sha);
      if (meta) {
        for (const p of meta.parents) queue.push(p);
        queue.push(meta.tree);
        continue;
      }
      const obj = repo.objects.get(sha);
      if (!obj) continue;
      if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) queue.push(e.sha);
      } else if (obj.type === 'tag') {
        const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
        if (m) queue.push(m[1] as string);
      }
    }
  }
  // Objects held via shallow haves: just the object + its tree closure, NOT ancestors.
  const shallowHeld = new Set<string>();
  for (const sha of shallowHaveSet) {
    const queue: string[] = [sha];
    while (queue.length > 0) {
      const cur = queue.pop() as string;
      if (shallowHeld.has(cur) || fullHeld.has(cur)) continue;
      shallowHeld.add(cur);
      const meta = repo.commits.get(cur);
      if (meta) {
        queue.push(meta.tree);
        continue;
      }
      const obj = repo.objects.get(cur);
      if (!obj) continue;
      if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) queue.push(e.sha);
      } else if (obj.type === 'tag') {
        const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
        if (m) queue.push(m[1] as string);
      }
    }
  }
  const held = new Set<string>([...fullHeld, ...shallowHeld]);
  const included = new Map<string, PackEntry>();
  const includedCommits = new Set<string>();
  const addObject = (sha: string): PackEntry | undefined => {
    if (included.has(sha) || held.has(sha)) return included.get(sha);
    const obj = repo.objects.get(sha);
    if (!obj) return undefined;
    const entry: PackEntry = { type: obj.type, data: obj.data };
    included.set(sha, entry);
    return entry;
  };
  // Commit walk with distances (0 = want). A fully-held commit is skipped entirely
  // (its history is held); a shallow-held commit is not re-sent but IS traversed,
  // because its parents are exactly what a deepen fetch must deliver.
  const commitDist = new Map<string, number>();
  const queue: { sha: string; dist: number }[] = wants.map((sha) => ({ sha, dist: 0 }));
  while (queue.length > 0) {
    const { sha, dist } = queue.shift() as { sha: string; dist: number };
    if (commitDist.has(sha)) continue;
    if (depth !== undefined && dist >= depth) continue;
    if (fullHeld.has(sha)) continue;
    commitDist.set(sha, dist);
    const isHeld = held.has(sha);
    const entry = isHeld ? repo.objects.get(sha) : addObject(sha);
    if (!entry) continue;
    if (entry.type === 'tag') {
      const m = /^object ([0-9a-f]{40})$/m.exec(entry.data.toString('utf8'));
      if (m) queue.push({ sha: m[1] as string, dist });
      continue;
    }
    if (entry.type !== 'commit') continue;
    const meta = repo.commits.get(sha);
    if (!meta) continue;
    if (!isHeld) {
      includedCommits.add(sha);
      // Include the commit's tree closure.
      const treeQueue: string[] = [meta.tree];
      while (treeQueue.length > 0) {
        const treeSha = treeQueue.pop() as string;
        const treeEntry = addObject(treeSha);
        if (!treeEntry) continue;
        for (const e of parseTree(treeEntry.data)) {
          if (e.mode === '40000') treeQueue.push(e.sha);
          else if (e.mode !== '160000') addObject(e.sha);
        }
      }
    }
    for (const p of meta.parents) {
      if (commitDist.has(p) || fullHeld.has(p)) continue;
      if (depth !== undefined && dist + 1 >= depth) continue;
      queue.push({ sha: p, dist: dist + 1 });
    }
  }
  // Boundary: an included commit with a parent that is neither included nor fully-held.
  const boundary = new Set<string>();
  for (const sha of includedCommits) {
    const meta = repo.commits.get(sha);
    if (!meta || meta.parents.length === 0) continue;
    if (meta.parents.some((p) => !includedCommits.has(p) && !fullHeld.has(p))) boundary.add(sha);
  }
  return { objects: [...included.values()], boundary: [...boundary], includedCommits, fullHeld };
}

// ---------------------------------------------------------------- advertisements

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

function listRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const line: RefLine = { oid, name };
    if (name.startsWith('refs/tags/')) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
        if (m) line.peeled = m[1] as string;
      }
    }
    out.push(line);
  }
  return out;
}

const UPLOAD_V0_CAPS = 'side-band-64k thin-pack ofs-delta multi_ack multi_ack_detailed shallow symref=HEAD:refs/heads/main agent=github-core-clone-forge/1.0';
const RECEIVE_V0_CAPS = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=github-core-clone-forge/1.0';

function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`)];
  const refs = listRefs(repo);
  const headTip = repo.refs.get('refs/heads/main');
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    // HEAD line first, carrying the capabilities.
    parts.push(pktLine(`${headTip ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    pktLine('version 2\n'),
    pktLine('fetch=shallow\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    FLUSH,
  ];
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- helpers

function sendRaw(res: ServerResponse, ctx: HandlerCtx, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': ctx.requestId,
  });
  res.end(body);
}

function ancestorsOf(repo: Repo, tips: string[]): Set<string> {
  const out = new Set<string>();
  const queue = [...tips];
  while (queue.length > 0) {
    const sha = queue.pop() as string;
    if (out.has(sha)) continue;
    out.add(sha);
    const meta = repo.commits.get(sha);
    if (meta) for (const p of meta.parents) queue.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- ls-refs (v2)

function handleLsRefs(repo: Repo, pkts: Pkt[]): Buffer {
  const args = new Set<string>();
  const prefixes: string[] = [];
  let limit = -1;
  for (const p of pkts) {
    const text = pktText(p);
    if (text === null || text === 'command=ls-refs\n') continue;
    const line = text.replace(/\n$/, '');
    if (line === 'peel' || line === 'unborn' || line === 'symrefs') args.add(line);
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    else if (line.startsWith('ref-limit ')) limit = parseInt(line.slice('ref-limit '.length), 10);
  }
  const out: Buffer[] = [];
  const refs = listRefs(repo);
  const headTip = repo.refs.get('refs/heads/main');
  const includeHead = prefixes.length === 0 || prefixes.some((pfx) => 'HEAD'.startsWith(pfx));
  const isUnborn = !headTip;
  if (includeHead && (headTip || args.has('unborn'))) {
    // Attributes are space-separated tokens on the SAME line; an unborn ref
    // uses the literal word `unborn` in place of the object id.
    const attrs: string[] = [];
    if (args.has('symrefs')) attrs.push('symref-target:refs/heads/main');
    if (isUnborn) attrs.push('unborn');
    const first = isUnborn ? 'unborn' : (headTip as string);
    out.push(pktLine(`${first} HEAD${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}\n`));
  }
  let count = out.length > 0 ? 1 : 0;
  for (const ref of refs) {
    if (prefixes.length > 0 && !prefixes.some((pfx) => ref.name.startsWith(pfx))) continue;
    if (limit >= 0 && count >= limit) break;
    count += 1;
    const attrs: string[] = [];
    if (args.has('peel') && ref.peeled) attrs.push(`peeled:${ref.peeled}`);
    out.push(pktLine(`${ref.oid} ${ref.name}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}\n`));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- fetch (v2)

function shallowLines(repo: Repo, collected: Collected, clientShallow: string[]): { shallow: string[]; unshallow: string[] } {
  const boundary = new Set(collected.boundary);
  const shallow = new Set<string>(collected.boundary);
  const unshallow = new Set<string>();
  for (const s of clientShallow) {
    // Unshallow when every parent is now present (included in this fetch or fully held).
    // A boundary commit that was re-sent and is still a boundary stays shallow.
    const meta = repo.commits.get(s);
    const parentsResolved = !meta || meta.parents.every((p) => collected.includedCommits.has(p) || collected.fullHeld.has(p));
    if (parentsResolved && !boundary.has(s)) unshallow.add(s);
    else shallow.add(s);
  }
  return { shallow: [...shallow], unshallow: [...unshallow] };
}

function handleFetchV2(repo: Repo, pkts: Pkt[]): Buffer {
  const wants: string[] = [];
  const haves = new Set<string>();
  const clientShallow: string[] = [];
  let depth: number | undefined;
  for (const p of pkts) {
    const text = pktText(p);
    if (text === null || text === 'command=fetch\n') continue;
    const line = text.replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.add(line.slice(5).trim());
    else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7), 10);
    else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8).trim());
  }
  if (wants.length === 0) throw new Error('fetch-no-want');
  for (const w of wants) {
    if (!repo.objects.has(w)) throw new Error(`fetch-unknown-object ${w}`);
  }
  const wantAncestors = ancestorsOf(repo, wants);
  const common = [...haves].filter((h) => wantAncestors.has(h));
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (common.length > 0) {
    parts.push(pktLine('ready\n'));
    for (const c of common) parts.push(pktLine(`ACK ${c}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(DELIM);
  const collected = collectReachable(repo, wants, haves, depth, clientShallow);
  const { shallow, unshallow } = shallowLines(repo, collected, clientShallow);
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(cachedPack(repo, wants, haves, depth, clientShallow, collected.objects)));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch (v0)

function handleFetchV0(repo: Repo, pkts: Pkt[]): Buffer {
  const wants: string[] = [];
  const haves = new Set<string>();
  const clientShallow: string[] = [];
  let depth: number | undefined;
  for (const p of pkts) {
    const text = pktText(p);
    if (text === null) continue;
    const line = text.replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.add(line.slice(5).trim());
    else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7), 10);
    else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8).trim());
    else if (line === 'done') break;
  }
  if (wants.length === 0) throw new Error('fetch-no-want');
  for (const w of wants) {
    if (!repo.objects.has(w)) throw new Error(`fetch-unknown-object ${w}`);
  }
  const parts: Buffer[] = [pktLine('NAK\n')];
  const collected = collectReachable(repo, wants, haves, depth, clientShallow);
  const { shallow, unshallow } = shallowLines(repo, collected, clientShallow);
  for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  parts.push(...sidebandPackets(cachedPack(repo, wants, haves, depth, clientShallow, collected.objects)));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack (v0)

interface RefUpdate {
  old: string;
  next: string;
  ref: string;
}

/** Split a receive-pack body into ref-update lines, client capabilities, and the trailing packfile. */
function splitReceiveBody(buf: Buffer): { updates: RefUpdate[]; pack: Buffer; capabilities: string[] } {
  const updates: RefUpdate[] = [];
  let capabilities: string[] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) throw new Error('pktline-truncated');
    const head = buf.subarray(i, i + 4).toString('ascii');
    if (head === '0000') {
      i += 4;
      break;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || len > PKT_MAX) throw new Error(`invalid pkt-line length ${head}`);
    if (i + len > buf.length) throw new Error('pktline-truncated');
    const line = buf.subarray(i + 4, i + len).toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const clean = nul === -1 ? line : line.slice(0, nul);
    if (nul !== -1 && updates.length === 0) capabilities = line.slice(nul + 1).split(' ').filter(Boolean);
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(clean);
    if (!m) throw new Error(`bad ref-update ${clean}`);
    updates.push({ old: m[1] as string, next: m[2] as string, ref: m[3] as string });
    i += len;
  }
  return { updates, pack: buf.subarray(i), capabilities };
}

/** Wrap a report-status stream in sideband band-1 frames when the client negotiated side-band-64k. */
function frameReport(report: Buffer, sideband: boolean): Buffer {
  if (!sideband) return report;
  const body = report.subarray(0, report.length - 4); // strip the trailing flush
  return Buffer.concat([...sidebandPackets(body, 1), FLUSH]);
}

function handleReceivePack(repo: Repo, ctx: HandlerCtx, body: Buffer): Buffer {
  const { updates, pack, capabilities } = splitReceiveBody(body);
  const sideband = capabilities.includes('side-band-64k');
  const failReport = (msg: string): Buffer => {
    const parts: Buffer[] = [pktLine(`unpack ${msg}\n`)];
    for (const u of updates) parts.push(pktLine(`ng ${u.ref} unpack failed\n`));
    parts.push(FLUSH);
    return frameReport(Buffer.concat(parts), sideband);
  };
  // Parse + store the pack first (all objects), then register commits.
  try {
    if (pack.length > 0) {
      const entries = parsePack(pack, repo);
      const stored: { type: string; data: Buffer; sha: string }[] = [];
      for (const entry of entries) {
        const sha = objectId(entry.type, entry.data);
        ctx.store.storeRawObject(repo, entry.type as 'blob' | 'tree' | 'commit' | 'tag', entry.data, sha);
        stored.push({ ...entry, sha });
      }
      for (const s of stored) {
        if (s.type === 'commit') ctx.store.registerCommitObject(repo, s.sha);
      }
    }
  } catch (err) {
    return failReport(err instanceof Error ? err.message : 'unpack failed');
  }
  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  for (const u of updates) {
    const current = repo.refs.get(u.ref);
    if (u.old !== ZERO_OID && current !== u.old) {
      results.push({ ref: u.ref, ok: false, reason: 'old value mismatch' });
      continue;
    }
    if (u.next === ZERO_OID) {
      if (current !== undefined) repo.refs.delete(u.ref);
      results.push({ ref: u.ref, ok: true });
      continue;
    }
    const target = repo.objects.get(u.next);
    if (!target) {
      results.push({ ref: u.ref, ok: false, reason: 'missing object' });
      continue;
    }
    let newCommit = u.next;
    if (target.type === 'tag') {
      const resolved = ctx.store.tagTarget(repo, u.next);
      if (!resolved) {
        results.push({ ref: u.ref, ok: false, reason: 'bad tag' });
        continue;
      }
      newCommit = resolved;
    }
    if (current !== undefined && current !== ZERO_OID && current !== u.next) {
      let curCommit = current;
      const curObj = repo.objects.get(current);
      if (curObj && curObj.type === 'tag') {
        const resolved = ctx.store.tagTarget(repo, current);
        if (resolved) curCommit = resolved;
      }
      if (!ctx.store.isAncestor(repo, curCommit, newCommit)) {
        results.push({ ref: u.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(u.ref, u.next);
    results.push({ ref: u.ref, ok: true });
  }
  const parts: Buffer[] = [pktLine('unpack ok\n')];
  for (const r of results) {
    parts.push(pktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason ?? 'failed'}\n`));
  }
  parts.push(FLUSH);
  return frameReport(Buffer.concat(parts), sideband);
}

// ---------------------------------------------------------------- router

export async function handleGit(req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx): Promise<boolean> {
  const m = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(req.url ? new URL(req.url, 'http://x').pathname : '');
  if (!m) return false;
  const owner = m[1] as string;
  const repoName = m[2] as string;
  const rest = m[3] ?? '';
  const repo = ctx.store.getRepo(owner, repoName);
  if (!repo) {
    jsonError(res, ctx, 404, 'Not Found');
    return true;
  }
  const method = req.method ?? 'GET';
  try {
    if (method === 'GET' && rest === '/info/refs') {
      const service = new URL(req.url ?? '', 'http://x').searchParams.get('service');
      if (service === 'git-upload-pack') {
        // Protocol v2 when the client asks for it (Git-Protocol: version=2).
        if ((req.headers['git-protocol'] ?? '') === 'version=2') {
          sendRaw(res, ctx, 200, 'application/x-git-upload-pack-advertisement', v2Advertisement());
          return true;
        }
        sendRaw(res, ctx, 200, 'application/x-git-upload-pack-advertisement', v0Advertisement('git-upload-pack', repo));
        return true;
      }
      if (service === 'git-receive-pack') {
        sendRaw(res, ctx, 200, 'application/x-git-receive-pack-advertisement', v0Advertisement('git-receive-pack', repo));
        return true;
      }
        jsonError(res, ctx, 404, 'Not Found');
      return true;
    }
    if (method === 'POST' && rest === '/git-upload-pack') {
      const body = await readBody(req);
      const pkts = parsePktLines(body);
      const first = pkts[0] ? pktText(pkts[0]) : null;
      if (first === 'command=ls-refs\n') {
        sendRaw(res, ctx, 200, 'application/x-git-upload-pack-result', handleLsRefs(repo, pkts));
        return true;
      }
      if (first === 'command=fetch\n') {
        sendRaw(res, ctx, 200, 'application/x-git-upload-pack-result', handleFetchV2(repo, pkts));
        return true;
      }
      // Protocol v0 fetch: want/have lines directly.
      sendRaw(res, ctx, 200, 'application/x-git-upload-pack-result', handleFetchV0(repo, pkts));
      return true;
    }
    if (method === 'POST' && rest === '/git-receive-pack') {
      const body = await readBody(req);
      sendRaw(res, ctx, 200, 'application/x-git-receive-pack-result', handleReceivePack(repo, ctx, body));
      return true;
    }
  } catch (err) {
    jsonError(res, ctx, 400, err instanceof Error ? err.message : 'Bad Request');
    return true;
  }
  jsonError(res, ctx, 404, 'Not Found');
  return true;
}
