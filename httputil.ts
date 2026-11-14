// Shared HTTP helpers for the forge handlers.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

export interface HandlerCtx {
  store: Store;
  requestId: string;
  baseUrl: string; // e.g. http://127.0.0.1:41234 (from the Host header)
}

const JSON_TYPE = 'application/json; charset=utf-8';
export const MAX_BODY_BYTES = 64 * 1024 * 1024;

export function sendJson(res: ServerResponse, ctx: HandlerCtx, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.requestId,
    ...headers,
  });
  res.end(text);
}

export function sendEmpty(res: ServerResponse, ctx: HandlerCtx, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'x-github-request-id': ctx.requestId, ...headers });
  res.end();
}

export function jsonError(res: ServerResponse, ctx: HandlerCtx, status: number, message: string): void {
  sendJson(res, ctx, status, { message });
}

/** Read the full request body as a Buffer. Rejects on overflow. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        failed = true;
        reject(new Error('body_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

/**
 * Parse a request body as JSON. Returns { ok: true, value } (value may be undefined
 * when the body is empty), or { ok: false } when the body is present but not valid JSON.
 */
export function parseJsonBody(buf: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (buf.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

/** Path segments of a URL pathname, percent-decoded per segment. */
export function pathSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
}

/** Parse a query string into a URLSearchParams. */
export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}
