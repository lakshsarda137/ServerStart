---
name: serverstart
description: Register, start, stop, or check local dev servers with the serverstart CLI. Use when
  creating or scaffolding a new web app, API, or anything with a dev server; when the user asks
  to add a project to ServerStart or "make it start with my other servers"; or when asked which local
  servers are running.
---

<!-- version: 3 -->

# ServerStart

`serverstart` keeps one central list of the user's local dev servers (Node, Python, Docker
compose) and starts any subset with one command. You register servers with it; the user starts
them with a bare `serverstart` after a reboot.

The user has many projects, and each project's own Claude Code session registers its own
servers. So: always pass an **absolute** `--cwd`, and never touch services that belong to
other projects.

## Registering a new app

1. **See what exists:** `serverstart ls --json` (names, ports, groups, docker services).
2. **Work out the command and port.** Prefer detection, then check it:
   `serverstart add --detect --dry-run --json --cwd <abs path>`
   Compare `service.cmd` and `service.port` with the project's package.json scripts, framework
   config (vite.config, next, uvicorn flags), pyproject or compose file. Fix anything wrong with
   explicit flags.
3. **Register, non-interactively, with explicit flags:**
   ```
   serverstart add --name <kebab> --cwd <abs path> --cmd "<cmd>" --port <n> \
     [--group <project>] [--depends-on <svc>] [--python-venv .venv | --uv] [--node-version .nvmrc] --json
   ```
   **Always pass `--group`**, even for a project with a single service: every project is its
   own group (the dashboard shows each group as an app with Start, Stop and Open). Use a short
   kebab-case name for the project, e.g. `resumebuilder`, `application-logger`.
4. **Port clash:** if the result is `PORT_CONFLICT` (exit 4), take `error.suggested_port`, **change
   the app's own config to match** (`error.app_hint`, e.g. `server.port` in vite.config.ts, the
   uvicorn `--port` flag, `next dev -p`), then run `add` again with that port.
5. **Verify:** `serverstart up <name> --json`, then `serverstart status --json`. Tell the user
   the name, port and URL. If it crashed, read `error` and `serverstart logs <name> -n 50`, fix
   the cause, and run `serverstart restart <name> --json`.

## Rules

- Never hand-edit `serverstart.yaml`. Use `serverstart add`, `remove`, `default`, `settings set`.
- **Changing an existing registration** (group, command, port, ready check): run `serverstart ls
  --json` to see its current fields, then `serverstart add --force` with the same name and the
  complete set of flags you want. `--force` replaces the entry. Keep `--no-default` only if it
  had `"default": false`.
- Never run `serverstart down` (or `remove`) unless the user asks.
- Never use `--kill-port` without the user's OK: it kills a process ServerStart didn't start.
- **Default set:** new services follow `settings.new_services_default`. Don't pass `--no-default`
  or change other services' defaults unless asked. "Start this with my other servers" →
  `serverstart default add <name>`; "don't start this by default" → `serverstart default remove <name>`.
- **Databases:** before registering a database, check `serverstart ls --json` for a matching
  Docker service and use `--depends-on <it>` instead of registering a duplicate. For a new one,
  register the compose service: `serverstart add --name <app>-db --docker-compose <abs file>
  --docker-service <svc> --port <published port> --group <app> --json`.
- Always pass `--json`, and run each `serverstart` command on its own (no `; echo $?` or
  pipes): the JSON already says what happened (`ok`, `state`, `error`). Exit codes: 0 ok,
  1 start failed, 2 usage, 3 config invalid, 4 conflict (name or port), 5 environment.
- **Already running by hand:** if `up` reports a service as `external` (`already_running: true`,
  `external.pid`), the user started that app themselves in its own folder. That's fine: it is
  registered and will start under ServerStart next time. Don't stop it. If the port is held by
  some *other* program, the error names it (`port 3001 in use: node 8770`); you don't need `ps`
  or `lsof` to identify it.
- **Wrapper scripts:** if the project has its own start script that reads the port from config
  (e.g. `scripts/start.sh`), registering that script as `--cmd` is fine; set `--port` to the port
  it uses and prefer an `--ready-http` health route if one exists.

## Example: Vite + FastAPI + Postgres

```
serverstart ls --json
serverstart add --name shop-db --docker-compose /Users/me/code/shop/compose.yaml \
  --docker-service db --port 5432 --group shop --json
serverstart add --name shop-api --cwd /Users/me/code/shop/api \
  --cmd "uvicorn main:app --reload --port 8000" --port 8000 --python-venv .venv \
  --ready-http http://localhost:8000/docs --depends-on shop-db --group shop --json
serverstart add --name shop-web --cwd /Users/me/code/shop/web --cmd "pnpm run dev" \
  --port 5173 --node-version .nvmrc --depends-on shop-api --group shop --json
serverstart up shop --json
serverstart status --json
```

Report: `shop-web` on http://localhost:5173, `shop-api` on http://localhost:8000.

## Example: a single Next.js app

```
serverstart add --detect --dry-run --json --cwd /Users/me/code/blog
# → cmd "npm run dev", port 3000; port_conflict says 3000 is taken, suggested 3001
# change package.json: "dev": "next dev -p 3001"
serverstart add --name blog --cwd /Users/me/code/blog --cmd "npm run dev" --port 3001 --group blog --json
serverstart up blog --json
```

Report: `blog` on http://localhost:3001.

## Other useful commands

- `serverstart status --json`: every service's state, port, PID, URL, last error.
- `serverstart logs <name> -n 100`: recent log output.
- `serverstart restart <name> --json` after changing a service's code or config.
- `serverstart web`: the user's browser dashboard (don't run it yourself; it blocks).
