# ServerStart

Start all your local dev servers with one command.

ServerStart keeps one central list of the dev servers across all your projects (Node, Python,
Docker compose) and starts any subset with one command, in dependency order. It shows when each
one is actually ready, in a live terminal dashboard or a local web dashboard. Servers run
detached, so closing the dashboard never stops them.

It also has a JSON mode and a bundled Claude Code skill, so Claude Code can register new apps for you.

macOS only for now. Node 20 or newer.

```
╭─ ServerStart ───────────────────── ~/.config/serverstart/serverstart.yaml ─╮
│  ✓ 4 ready   ✕ 1 crashed   – 1 stopped   ◇ 1 external         7 services   │
╰────────────────────────────────────────────────────────────────────────────╯
     NAME             STATE        PORT   PID     RUNTIME         UPTIME
  SHOP
  ★  shop-db          ✓ ready      5432   –       docker             12m
  ★  shop-api         ✓ ready      8000   4121    python 3.12        11m
  ★  shop-web         ✓ ready      5173   4130    node 20.11         11m

  UNGROUPED
  ★  blog             ✓ ready      3000   4388    node 20.11          3m
❯ ★  ml-demo          ✕ crashed    8080   –       python 3.11
     └ ModuleNotFoundError: No module named 'torch'
     notes-app        – stopped    4000   –       node 22.1
     legacy-api       ◇ external   5000   9120    python3

  ⏎ error log   r restart   s start   o open   d default   , settings   q quit
```

## Install

```sh
git clone https://github.com/lakshsarda137/ServerStart.git
cd ServerStart
npm install          # also builds
npm install -g .     # puts `serverstart` on your PATH (or: npm link)
```

pnpm works too (`pnpm install && pnpm add -g .`).

## Quick start

```sh
cd ~/code/my-app
serverstart add      # wizard: detects the command, port and runtime; Enter accepts
serverstart          # start the default set and open the dashboard
```

After a reboot, a bare `serverstart` brings everything back.

## Commands

| Command | What it does |
|---|---|
| `serverstart` | Start the default set, then open the dashboard. |
| `serverstart up [svc\|group...]` | Start services and their dependencies. `--kill-port` frees a busy port without asking. |
| `serverstart down [svc\|group...]` | Stop services (all if none given), dependents first. |
| `serverstart restart <svc\|group...>` | Stop, then start. |
| `serverstart status` | State, port, PID, runtime and uptime of every service. |
| `serverstart dash` | Open the dashboard without starting anything. |
| `serverstart web [--port 7777] [--no-open]` | Serve the web dashboard on `127.0.0.1` until Ctrl-C. |
| `serverstart logs <svc> [-f] [-n 100]` | Print or follow a service's log. |
| `serverstart open <svc\|group> [-y]` | Open a service in the browser. For a group, opens its frontend (the service nothing else in the group depends on), starting the group first if needed. |
| `serverstart ls` | List configured services. |
| `serverstart add [flags]` | Register a service: a wizard on a terminal, or flags (see below). Every service gets a group (its project); without `--group` it's the project folder's name. |
| `serverstart remove <svc> [-y]` | Stop and remove a service. |
| `serverstart edit` | Open the config in `$EDITOR`, then validate it. |
| `serverstart settings` | Settings screen: the default set and global settings. |
| `serverstart settings set <key> <value>` | e.g. `serverstart settings set start_on_login true` |
| `serverstart default add\|remove\|ls <svc\|group...>` | Change the default set. |
| `serverstart doctor` | Check Docker, shells, venvs, ports, dependencies, the login agent and the skill. |
| `serverstart schema` | Print the config JSON Schema. |
| `serverstart install-skill [--force]` | Install the Claude Code skill. |

Global flags: `--json`, `--no-color`, `--config <path>`, `--quiet`, `--verbose`.

### Dashboard keys

`↑↓` move, `⏎` logs (with `f` follow and `/` find), `r` restart, `s` start or stop, `o` open,
`d` toggle default set, `,` settings, `q` quit. Quitting leaves every server running.

### The web dashboard

`serverstart web` serves the same view in your browser: live states, start, stop and restart,
live logs with search, and the default set and settings. It binds to `127.0.0.1` only, checks
the `Host` header, and requires an `X-ServerStart: 1` header on every change, so other sites
can't drive it. Stopping it never stops your servers.

## Config

`~/.config/serverstart/serverstart.yaml` (respects `$XDG_CONFIG_HOME`; override with `--config`
or `$SERVERSTART_CONFIG`). See [`examples/serverstart.example.yaml`](examples/serverstart.example.yaml).

- **Commands run in your login shell** (`zsh -lc` in the service's `cwd`), so anything that works
  with `cd <cwd> && <cmd>` in your terminal works here.
- **Python:** `python: { venv: .venv }`, `{ conda: <env> }` or `{ uv: true }`.
- **Node:** `node: { version: .nvmrc }` uses nvm or fnm when present.
- **Ready checks:** the port by default; or `ready: { http: <url> }` or `ready: { log: <regex> }`.
- **Default set:** services with `start_by_default: true` start with a bare `serverstart`.
  Their dependencies come along automatically.
- **Env:** `env` and `env_file`. Values never appear in output; `--json` shows only the keys.

State and logs live in `~/.local/state/serverstart/` (respects `$XDG_STATE_HOME`). Logs rotate at
10 MB.

## Agent mode (JSON)

Outside a terminal, or with `--json`, ServerStart never prompts and prints one JSON document.

```sh
serverstart add --name shop-api --cwd ~/code/shop/api --cmd "uvicorn main:app --port 8000" \
  --port 8000 --python-venv .venv --depends-on shop-db --group shop --json
serverstart add --detect --dry-run --json --cwd ~/code/blog   # see what detection proposes
serverstart up shop --json
serverstart status --json
```

Errors look like `{ "error": { "code": "PORT_CONFLICT", "message": "...", "hint": "...", "suggested_port": 5175 } }`.

| Exit code | Meaning |
|---|---|
| 0 | Success |
| 1 | A service failed to start or stop |
| 2 | Invalid usage or flags |
| 3 | Config invalid |
| 4 | Conflict (name exists, port in use) |
| 5 | Environment problem (Docker unavailable, cwd missing) |

## Claude Code

```sh
serverstart install-skill
```

This installs `~/.claude/skills/serverstart/SKILL.md`, which teaches Claude Code to register
new apps with ServerStart. Two optional steps you do yourself (ServerStart won't edit these files):

1. Have Claude register new apps without being asked. Add to `~/.claude/CLAUDE.md`:

   ```
   After creating a new web app or server, register it with ServerStart (see the serverstart skill).
   ```

2. Let the read-only and add commands run without prompts. Add to `~/.claude/settings.json`:

   ```json
   { "permissions": { "allow": ["Bash(serverstart ls:*)", "Bash(serverstart status:*)", "Bash(serverstart add:*)", "Bash(serverstart up:*)"] } }
   ```

   `down`, `remove` and `--kill-port` are left out on purpose, so they still ask.

## Start at login

```sh
serverstart settings set start_on_login true
```

This installs a LaunchAgent (`~/Library/LaunchAgents/dev.serverstart.login.plist`) that runs
`serverstart up --quiet` once at your next login. It doesn't keep anything running in the
background. `false` removes it, and `serverstart doctor` checks that it still matches the setting.

## Development

```sh
npm install
npm run build      # tsup: dist/cli.js plus the web app in dist/web
npm run check      # TypeScript
```

## License

MIT
