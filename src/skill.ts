import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { EXIT } from './errors.js';
import { c, pal } from './output/term.js';
import { home, tildify } from './paths.js';

/** The bundled skill sits at <package>/skills/serverstart/SKILL.md; the bundle is <package>/dist/*.js. */
export function bundledSkillPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../skills/serverstart/SKILL.md', '../../skills/serverstart/SKILL.md']) {
    const p = join(here, rel);
    if (existsSync(p)) return p;
  }
  return join(here, '../skills/serverstart/SKILL.md');
}

export function installedSkillPath(): string {
  return join(home(), '.claude', 'skills', 'serverstart', 'SKILL.md');
}

function versionOf(text: string): number {
  const m = /version:\s*(\d+)/.exec(text);
  return m ? Number(m[1]) : 0;
}

export function skillStatus(): { installed: boolean; installedVersion: number; bundledVersion: number } {
  const bundled = existsSync(bundledSkillPath()) ? readFileSync(bundledSkillPath(), 'utf8') : '';
  const target = installedSkillPath();
  const installed = existsSync(target);
  return { installed, installedVersion: installed ? versionOf(readFileSync(target, 'utf8')) : 0, bundledVersion: versionOf(bundled) };
}

const CLAUDE_MD = 'After creating a new web app or server, register it with ServerStart (see the serverstart skill).';
const SETTINGS_JSON = '{ "permissions": { "allow": ["Bash(serverstart ls:*)", "Bash(serverstart status:*)", "Bash(serverstart add:*)", "Bash(serverstart up:*)"] } }';

function snippetBox(text: string, width: number): string[] {
  const p = pal();
  const inner = width - 4;
  const words = text.split(' ');
  const rows: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > inner) {
      rows.push(cur);
      cur = w;
    } else cur = (cur + ' ' + w).trim();
  }
  if (cur) rows.push(cur);
  return [
    '  ' + c(p.line, '┌' + '─'.repeat(inner + 2) + '┐'),
    ...rows.map((r) => '  ' + c(p.line, '│ ') + c(p.text, r.padEnd(inner)) + c(p.line, ' │')),
    '  ' + c(p.line, '└' + '─'.repeat(inner + 2) + '┘'),
  ];
}

export async function installSkill(opts: { force: boolean; json: boolean }): Promise<number> {
  const src = bundledSkillPath();
  const dest = installedSkillPath();
  const p = pal();
  const content = readFileSync(src, 'utf8');
  if (existsSync(dest)) {
    const current = readFileSync(dest, 'utf8');
    if (current !== content && !opts.force) {
      const diff = await execa('diff', ['-u', dest, src], { reject: false });
      if (opts.json) {
        process.stdout.write(JSON.stringify({ error: { code: 'NAME_EXISTS', message: 'installed skill differs from the bundled one', hint: 'serverstart install-skill --force', diff: diff.stdout } }, null, 2) + '\n');
      } else {
        for (const line of diff.stdout.split('\n')) {
          const col = line.startsWith('+') ? p.ok : line.startsWith('-') ? p.err : line.startsWith('@@') ? p.logInfo : p.muted;
          process.stdout.write(c(col, line) + '\n');
        }
        process.stdout.write('\n  ' + c(p.accent, '→ ') + c(p.cmd, 'serverstart install-skill --force') + '\n');
      }
      return EXIT.CONFLICT;
    }
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, content);
  if (opts.json) {
    process.stdout.write(JSON.stringify({ installed: dest, version: versionOf(content), claude_md: CLAUDE_MD, settings_json: JSON.parse(SETTINGS_JSON) }, null, 2) + '\n');
    return EXIT.OK;
  }
  const width = Math.min(process.stdout.columns || 80, 80) - 2;
  const lines = [
    '  ' + c(p.ok, '✓ skill installed') + '   ' + c(p.path, tildify(dest)),
    '',
    '  ' + c(p.path, '~/.claude/CLAUDE.md') + '   ' + c(p.muted, 'add manually'),
    ...snippetBox(CLAUDE_MD, width),
    '',
    '  ' + c(p.path, '~/.claude/settings.json') + '   ' + c(p.muted, 'add manually'),
    ...snippetBox(SETTINGS_JSON, width),
  ];
  process.stdout.write(lines.join('\n') + '\n');
  return EXIT.OK;
}
