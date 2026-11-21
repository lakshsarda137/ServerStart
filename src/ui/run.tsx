import React from 'react';
import { render } from 'ink';
import type { Config } from '../config/load.js';
import { applyTheme, c, envTheme, pal, queryBackground } from '../output/term.js';
import type { Engine } from '../runtime/engine.js';
import { AddWizard } from './AddWizard.js';
import { Dashboard, type DashboardResult } from './Dashboard.js';
import { Progress } from './Progress.js';
import { Settings } from './Settings.js';

const ALT_ON = '\u001b[?1049h\u001b[H';
const ALT_OFF = '\u001b[?1049l';

async function detectTheme(): Promise<void> {
  const env = envTheme();
  applyTheme(env ?? (await queryBackground()));
}

/** Full-screen dashboard in the alternate screen buffer; prints one line on quit. */
export async function runDashboard(opts: { config: Config; configOverride?: string; up?: string[]; killPort?: boolean }): Promise<void> {
  await detectTheme();
  let result: DashboardResult = { running: 0 };
  process.stdout.write(ALT_ON);
  const restore = () => process.stdout.write(ALT_OFF);
  process.once('exit', restore);
  const app = render(<Dashboard config={opts.config} configOverride={opts.configOverride} up={opts.up} killPort={opts.killPort} onExit={(r) => (result = r)} />, {
    exitOnCtrlC: false,
  });
  await app.waitUntilExit();
  app.cleanup();
  restore();
  process.off('exit', restore);
  const p = pal();
  process.stdout.write('  ' + c(p.text, `${result.running} services running`) + '   ' + c(p.cmd, 'serverstart down') + '\n');
  // detached servers keep running; exit even if timers linger
  process.exit(0);
}

export async function runSettings(opts: { config: Config; configOverride?: string }): Promise<void> {
  await detectTheme();
  const cols = Math.min(process.stdout.columns || 80, 100);
  const rows = process.stdout.rows || 24;
  process.stdout.write(ALT_ON);
  const app = render(<Settings config={opts.config} configOverride={opts.configOverride} width={cols} height={rows - 1} active onClose={() => app.unmount()} />);
  await app.waitUntilExit();
  process.stdout.write(ALT_OFF);
  process.exit(0);
}

export async function runAddWizard(opts: { config: Config; configOverride?: string }): Promise<number> {
  await detectTheme();
  let code = 0;
  let lines: string[] = [];
  const app = render(
    <AddWizard
      config={opts.config}
      configOverride={opts.configOverride}
      onDone={(c2, l) => {
        code = c2;
        lines = l;
      }}
    />,
  );
  await app.waitUntilExit();
  app.clear();
  app.cleanup();
  for (const l of lines) process.stdout.write(l + '\n');
  return code;
}

export async function runProgress<T>(opts: { engine: Engine; kind: 'up' | 'down'; names: string[]; run: () => Promise<T> }): Promise<T> {
  let result!: T;
  const app = render(<Progress engine={opts.engine} config={opts.engine.config} names={opts.names} run={opts.run} onDone={(r) => (result = r)} />);
  await app.waitUntilExit();
  return result;
}
