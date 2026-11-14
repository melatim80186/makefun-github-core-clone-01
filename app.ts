// HTTP server + router for the forge. Auth lives here for /api/v3 and git;
// /api/graphql and /mcp answer their own 401s, so they check auth themselves.
// /healthz takes no auth at all.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { SHOP_TOKEN, VIEWER, createStore } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './git.ts';
import { jsonError, pathOf, sendJson, type HandlerCtx } from './httputil.ts';

let requestCounter = 0;

/** True when the request carries the shop token (or any Bearer token in local dev). */
function hasValidToken(req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string') return false;
  if (SHOP_TOKEN === '') return auth.startsWith('Bearer ') && auth.length > 7;
  return auth === `Bearer ${SHOP_TOKEN}`;
}

function deny(res: ServerResponse, ctx: HandlerCtx): void {
  jsonError(res, ctx, 401, 'Unauthorized');
}

async function dispatch(req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx): Promise<void> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';
  try {
    // Boot probe: no auth.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, ctx, 200, { ok: true });
      return;
    }

    // REST v3: auth enforced here, before the handler runs.
    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      if (!hasValidToken(req)) {
        deny(res, ctx);
        return;
      }
      if (await handleRest(req, res, ctx)) return;
    }

    // GraphQL: the handler enforces auth itself (it must answer exactly 401).
    if (method === 'POST' && path === '/api/graphql') {
      if (await handleGraphQL(req, res, ctx)) return;
    }

    // MCP: the handler enforces auth itself.
    if ((method === 'POST' || method === 'DELETE') && path === '/mcp') {
      if (await handleMcp(req, res, ctx)) return;
    }

    // Git smart HTTP: auth enforced here, before the handler runs.
    const gitPath = path.match(/^\/([^/]+)\/([^/]+)\.git(\/.*)?$/);
    if (gitPath !== null) {
      if (!hasValidToken(req)) {
        deny(res, ctx);
        return;
      }
      if (await handleGit(req, res, ctx)) return;
    }

    jsonError(res, ctx, 404, 'Not Found');
  } catch (err) {
    try {
      jsonError(res, ctx, 500, err instanceof Error ? err.message : 'Internal Server Error');
    } catch {
      // The response is already gone; nothing left to do.
    }
  }
}

export function createApp(): Server {
  const store = createStore();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    requestCounter += 1;
    const requestId = `req-${String(requestCounter).padStart(6, '0')}`;
    const host = req.headers.host ?? '127.0.0.1';
    const ctx: HandlerCtx = { store, requestId, baseUrl: `http://${host}` };
    void dispatch(req, res, ctx);
  });
}

// Keep the viewer derivation referenced so a future reader sees why the login is fixed.
void VIEWER;
