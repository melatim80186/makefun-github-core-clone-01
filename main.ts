// Forge entrypoint: boots the HTTP server, tells the trial environment where
// to find it, then waits until the environment says the run is over.
//
// The harness drives everything from outside: it starts this process with
// MAKEFUN_ENV_URL pointing at the environment server, and this file only
// speaks the environment's two endpoints (/register and /done). All of the
// GitHub-compatible behaviour lives in app.ts and the modules behind it.
import { createApp } from './app.ts';

const REGISTER_PATH = '/register';
const DONE_PATH = '/done';
const REGISTER_RETRY_MS = 250;
const REGISTER_BUDGET_MS = 18_000;
const DONE_POLL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envRoot(): string {
  const root = process.env.MAKEFUN_ENV_URL;
  if (root === undefined || root === '') {
    throw new Error('MAKEFUN_ENV_URL is not set');
  }
  return root.replace(/\/+$/, '');
}

async function announcePort(root: string, port: number): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${root}${REGISTER_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (res.status === 200) return true;
      if (res.status === 409) {
        // A slot is already taken. If this process is the one that took it
        // (a retry after a dropped response), the environment still knows
        // this port, so carry on to the /done poll instead of dying here.
        console.error('[forge] register: slot already taken, continuing to poll /done');
        return true;
      }
      console.error(`[forge] register: env answered ${res.status}, retrying`);
    } catch (err) {
      console.error(`[forge] register: ${err instanceof Error ? err.message : String(err)}, retrying`);
    }
    if (Date.now() - started > REGISTER_BUDGET_MS) return false;
    await sleep(REGISTER_RETRY_MS);
  }
}

async function waitForDone(root: string): Promise<void> {
  for (;;) {
    try {
      const res = await fetch(`${root}${DONE_PATH}`);
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The environment can be briefly unreachable between phases; keep asking.
    }
    await sleep(DONE_POLL_MS);
  }
}

async function main(): Promise<void> {
  const root = envRoot();
  const server = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('server did not bind a port'));
        return;
      }
      resolve(addr.port);
    });
  });
  console.error(`[forge] listening on 127.0.0.1:${port}, registering`);
  const ok = await announcePort(root, port);
  if (!ok) {
    console.error('[forge] register: gave up, exiting');
    server.close();
    process.exitCode = 1;
    return;
  }
  await waitForDone(root);
  server.close();
  const closable = server as unknown as { closeAllConnections?: () => void };
  if (typeof closable.closeAllConnections === 'function') closable.closeAllConnections();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(`[forge] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
