// HTTP server + router for the forge. Auth is enforced here for /api/v3 and git;
// /api/graphql and /mcp check auth themselves (they must answer 401 with their
// own envelopes). /healthz takes no auth.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { SHOP_TOKEN, VIEWER, createStore } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './git.ts';
import { jsonError, pathOf, sendJson, type HandlerCtx } from './httputil.ts';

let requestCounter = 0;

function isAuthed(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  if (SHOP_TOKEN === '') return header.startsWith('Bearer ') && header.length > 7;
  return header === `Bearer ${SHOP_TOKEN}`;
}

export function createApp(): Server {
  const store = createStore();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      requestCounter += 1;
      const requestId = `req-${String(requestCounter).padStart(6, '0')}`;
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      const host = req.headers.host ?? '127.0.0.1';
      const ctx: HandlerCtx = { store, requestId, baseUrl: `http://${host}` };

      try {
        // Boot probe: no auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, ctx, 200, { ok: true });
          return;
        }

        // REST v3: auth enforced here.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!isAuthed(req)) {
            jsonError(res, ctx, 401, 'Unauthorized');
            return;
          }
          if (await handleRest(req, res, ctx)) return;
        }

        // GraphQL: handler enforces auth (must answer exactly 401 itself).
        if (method === 'POST' && path === '/api/graphql') {
          if (await handleGraphQL(req, res, ctx)) return;
        }

        // MCP: handler enforces auth.
        if ((method === 'POST' || method === 'DELETE') && path === '/mcp') {
          if (await handleMcp(req, res, ctx)) return;
        }

        // Git smart HTTP: auth enforced here.
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
        if (gitMatch) {
          if (!isAuthed(req)) {
            jsonError(res, ctx, 401, 'Unauthorized');
            return;
          }
          if (await handleGit(req, res, ctx)) return;
        }

        jsonError(res, ctx, 404, 'Not Found');
      } catch (err) {
        try {
          jsonError(res, ctx, 500, err instanceof Error ? err.message : 'Internal Server Error');
        } catch {
          // Response already gone; nothing to do.
        }
      }
    })();
  });
}

// Keep the viewer derivation referenced so a future reader sees why the login is fixed.
void VIEWER;
