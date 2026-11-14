# github-core-clone-01 — forge

A standalone GitHub-compatible git forge in one Node 22 process, standard library only.
No dependencies, no git binary, no network, no UI.

## Run

```sh
node --experimental-strip-types main.ts
```

The process binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL/register`,
serves until `$MAKEFUN_ENV_URL/done` answers `{"done": true}`, then exits 0.

## Surface

| Route | What it serves |
| --- | --- |
| `GET /healthz` | 200 `{"ok": true}` |
| `GET /api/v3/` | API root, `X-OAuth-Scopes: repo, read:org` |
| `/api/v3/...` | REST v3: repos, branches, commits, contents, issues, comments, labels, pulls, merges |
| `POST /api/graphql` | GraphQL v4 (the documents `gh` and `github-mcp-server` send) |
| `POST /mcp` | MCP over streamable HTTP (revision 2026-07-28 + legacy handshake) |
| `/<owner>/<repo>.git/...` | git smart HTTP: upload-pack v2/v0, receive-pack v0 |

## Layout

- `main.ts` — entry ↔ env lifecycle (bind, register, poll done, exit 0).
- `app.ts` — HTTP server, router, auth.
- `store.ts` — in-memory forge state (repos, issues, PRs, git objects, refs).
- `gitobj.ts` — pure git object model (SHA-1, blob/tree/commit bytes).
- `git.ts` — smart-HTTP protocol (pkt-lines, v2/v0, packfiles, shallow, FF rules).
- `rest.ts` — REST v3 handlers.
- `graphql.ts` — GraphQL v4 executor.
- `mcp.ts` — MCP tools endpoint.
- `httputil.ts` — shared HTTP helpers.

## Notes

- The viewer login is derived from the kit's published constant scenario seed
  (`SCENARIO_SEED`), reimplemented in `store.ts` — the sealed env builds its
  scenario from the same seed, so the entry knows who its token belongs to.
- Timestamps come from a logical clock (base `MAKEFUN_TRIAL_NOW`, else
  2025-01-01), never the wall clock, so two runs behave identically.
- Objects are stored content-addressed by SHA-1 and returned byte-for-byte.
- License: MIT.
