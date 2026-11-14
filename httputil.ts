// Small HTTP plumbing shared by every forge handler: JSON replies, body
// reading with a size cap, and URL parsing. Nothing here knows about repos,
// issues, or git — it only moves bytes and shapes responses.
import type {
  IncomingMessage,
  ServerResponse,
} from 'node:http';
import type { Store } from './store.ts';

/** Everything a handler needs to answer one request. */
export interface HandlerCtx {
  store: Store;
  requestId: string;
  /** Origin of this request, e.g. http://127.0.0.1:41234 (from Host). */
  baseUrl: string;
}

const JSON_MEDIA_TYPE = 'application/json; charset=utf-8';
/** Largest request body the forge will accept (64 MiB). */
export const MAX_BODY_BYTES = 64 * 1024 * 1024;

function requestIdHeader(ctx: HandlerCtx): Record<string, string> {
  return { 'x-github-request-id': ctx.requestId };
}

export function sendJson(res: ServerResponse, ctx: HandlerCtx, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_MEDIA_TYPE,
    'content-length': Buffer.byteLength(text),
    ...requestIdHeader(ctx),
    ...extra,
  });
  res.end(text);
}

export function sendEmpty(res: ServerResponse, ctx: HandlerCtx, status: number, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...requestIdHeader(ctx), ...extra });
  res.end();
}

export function jsonError(res: ServerResponse, ctx: HandlerCtx, status: number, message: string): void {
  sendJson(res, ctx, status, { message });
}

/** Slurp the whole request body. Rejects with Error('body_too_large') past the cap. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pieces: Buffer[] = [];
    let bytes = 0;
    let done = false;
    const fail = (err: Error): void => {
      if (done) return;
      done = true;
      reject(err);
    };
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        fail(new Error('body_too_large'));
        return;
      }
      pieces.push(chunk);
    });
    req.on('end', () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(pieces));
      }
    });
    req.on('error', fail);
  });
}

/**
 * Decode a body buffer as JSON. An empty body decodes to undefined (the
 * caller decides what that means); anything present-but-invalid fails.
 */
export function parseJsonBody(buf: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (buf.length === 0) {
    return { ok: true, value: undefined };
  }
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

/** Split a pathname into segments, percent-decoding each one (raw on failure). */
export function pathSegments(pathname: string): string[] {
  const out: string[] = [];
  for (const raw of pathname.split('/')) {
    if (raw.length === 0) continue;
    try {
      out.push(decodeURIComponent(raw));
    } catch {
      out.push(raw);
    }
  }
  return out;
}

function requestUrl(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? '/', 'http://entry');
  } catch {
    return null;
  }
}

/** Query string of the request as URLSearchParams (empty when unparseable). */
export function queryOf(req: IncomingMessage): URLSearchParams {
  return requestUrl(req)?.searchParams ?? new URLSearchParams();
}

/** Pathname of the request ('/' when unparseable). */
export function pathOf(req: IncomingMessage): string {
  return requestUrl(req)?.pathname ?? '/';
}
