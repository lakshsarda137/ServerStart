import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import type { Config } from './config/load.js';
import { home, logsDir, stateDir } from './paths.js';

export const LABEL = 'dev.serverstart.login';

export function plistPath(): string {
  return join(home(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function scriptPath(): string {
  return join(stateDir(), 'login.sh');
}

function dashboardCommandPath(): string {
  return join(stateDir(), 'dashboard.command');
}

/** Absolute path of the running serverstart entry point. */
export function cliPath(): string {
  try {
    return realpathSync(process.argv[1]);
  } catch {
    return process.argv[1];
  }
}

const q = (s: string) => `"${s.replace(/(["\\$`])/g, '\\$1')}"`;

function plist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>${scriptPath()}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(logsDir(), 'login.log')}</string>
  <key>StandardErrorPath</key>
  <string>${join(logsDir(), 'login.log')}</string>
</dict>
</plist>
`;
}

/**
 * A stable path to node: prefer the `node` on PATH that resolves to the running binary
 * (e.g. /opt/homebrew/bin/node) over the versioned Cellar path, which breaks on upgrade.
 */
export function nodePath(): string {
  let real = process.execPath;
  try {
    real = realpathSync(process.execPath);
  } catch {
    /* keep execPath */
  }
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const candidate = join(dir, 'node');
    try {
      if (existsSync(candidate) && realpathSync(candidate) === real) return candidate;
    } catch {
      /* skip */
    }
  }
  return process.execPath;
}

function loginScript(config: Config): string {
  const node = nodePath();
  const cli = cliPath();
  const configArg = ` --config ${q(config.path)}`;
  // keep the same state/config locations the user's terminal uses
  const env = ['XDG_STATE_HOME', 'XDG_CONFIG_HOME'].filter((k) => process.env[k]).map((k) => `export ${k}=${q(process.env[k]!)}`);
  const lines = ['#!/bin/zsh', '# Written by serverstart (start_on_login). Do not edit.', ...env, `${q(node)} ${q(cli)} up --quiet${configArg}`];
  if (config.settings.openDashboardOnLogin) lines.push(`open -a Terminal ${q(dashboardCommandPath())}`);
  return lines.join('\n') + '\n';
}

function dashboardCommand(config: Config): string {
  const env = ['XDG_STATE_HOME', 'XDG_CONFIG_HOME'].filter((k) => process.env[k]).map((k) => `export ${k}=${q(process.env[k]!)}\n`).join('');
  return `#!/bin/zsh -l\n${env}exec ${q(nodePath())} ${q(cliPath())} dash --config ${q(config.path)}\n`;
}

const uid = () => process.getuid?.() ?? 501;

/**
 * Make the LaunchAgent match `settings.start_on_login` (PRD §5.3).
 * The agent is installed for the next login; it isn't started now, so toggling the
 * setting doesn't start servers immediately.
 */
export async function applyLoginSetting(config: Config): Promise<{ ok: boolean; message: string }> {
  const plistFile = plistPath();
  if (!config.settings.startOnLogin) {
    if (existsSync(plistFile)) {
      await execa('launchctl', ['bootout', `gui/${uid()}`, plistFile], { reject: false });
      unlinkSync(plistFile);
    }
    for (const f of [scriptPath(), dashboardCommandPath()]) if (existsSync(f)) unlinkSync(f);
    return { ok: true, message: 'LaunchAgent removed' };
  }
  try {
    mkdirSync(stateDir(), { recursive: true });
    mkdirSync(logsDir(), { recursive: true });
    mkdirSync(dirname(plistFile), { recursive: true });
    writeFileSync(scriptPath(), loginScript(config));
    chmodSync(scriptPath(), 0o755);
    writeFileSync(dashboardCommandPath(), dashboardCommand(config));
    chmodSync(dashboardCommandPath(), 0o755);
    writeFileSync(plistFile, plist());
    const lint = await execa('plutil', ['-lint', plistFile], { reject: false });
    if (lint.exitCode !== 0) return { ok: false, message: `plutil exit ${lint.exitCode}` };
    return { ok: true, message: 'LaunchAgent installed' };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export interface LoginStatus {
  enabled: boolean;
  plist: boolean;
  matches: boolean;
  binaryOk: boolean;
  detail: string;
}

export function loginStatus(config: Config): LoginStatus {
  const plist = existsSync(plistPath());
  const enabled = config.settings.startOnLogin;
  let binaryOk = true;
  if (plist && existsSync(scriptPath())) {
    const paths = [...readFileSync(scriptPath(), 'utf8').matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((p) => p.startsWith('/'));
    binaryOk = paths.slice(0, 2).every((p) => existsSync(p));
  } else if (plist) binaryOk = false;
  const matches = enabled === plist && (!plist || binaryOk);
  const detail = !enabled ? (plist ? 'off   plist still installed' : 'off   matches setting') : !plist ? 'on   plist missing' : !binaryOk ? 'on   binary path moved' : 'on   installed';
  return { enabled, plist, matches, binaryOk, detail };
}
