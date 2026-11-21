import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConfig } from '../src/config/load.js';
import { buildLaunch, parseDotenv, redactedEnvKeys, serviceEnv } from '../src/runtime/env.js';
import { extractError, stripAnsi } from '../src/runtime/logs.js';
import { parseUpSeconds } from '../src/runtime/docker.js';

describe('env', () => {
  it('parses dotenv files', () => {
    expect(
      parseDotenv(`# comment
export A=1
B="two words"
C='single # not comment'
D=plain # trailing comment
bad line
`),
    ).toEqual({ A: '1', B: 'two words', C: 'single # not comment', D: 'plain' });
  });

  it('merges env over env_file and only exposes keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ss-env-'));
    writeFileSync(join(dir, '.env'), 'SECRET=hunter2\nDATABASE_URL=from-file\n');
    const c = buildConfig({ services: { api: { cwd: dir, cmd: 'x', env_file: '.env', env: { DATABASE_URL: 'from-config' } } } }, '/x', true);
    expect(serviceEnv(c.services.api)).toEqual({ SECRET: 'hunter2', DATABASE_URL: 'from-config' });
    expect(redactedEnvKeys(c.services.api)).toEqual(['DATABASE_URL', 'SECRET']);
  });

  it('builds a login-shell launch with venv, conda and uv', () => {
    const c = buildConfig(
      {
        services: {
          a: { cwd: '/srv/a', cmd: 'uvicorn main:app', python: { venv: '.venv' }, port: 8000 },
          b: { cwd: '/srv/b', cmd: 'python app.py', python: { conda: 'ml' } },
          d: { cwd: '/srv/d', cmd: 'python app.py', python: { uv: true } },
          n: { cwd: '/srv/n', cmd: 'pnpm dev', node: { version: '20' } },
        },
      },
      '/x',
      true,
    );
    const a = buildLaunch(c.services.a, c.settings);
    expect(a.file).toBe('zsh');
    expect(a.args[0]).toBe('-lc');
    expect(a.script).toBe(`export VIRTUAL_ENV='/srv/a/.venv'\nexport PATH="$VIRTUAL_ENV/bin:$PATH"\nexec uvicorn main:app`);
    expect(a.env.PORT).toBe('8000');
    expect(buildLaunch(c.services.b, c.settings).script).toBe(`exec conda run --no-capture-output -n 'ml' python app.py`);
    expect(buildLaunch(c.services.d, c.settings).script).toBe('exec uv run python app.py');
    expect(buildLaunch(c.services.n, c.settings).script).toMatch(/nvm use '20'.*fnm use '20'.*\nexec pnpm dev$/s);
  });
});

describe('log error extraction', () => {
  it('finds the Python exception line, not the traceback header', () => {
    expect(
      extractError(`INFO:     Started reloader process [9312]
Traceback (most recent call last):
  File "main.py", line 3, in <module>
    import torch
ModuleNotFoundError: No module named 'torch'
`),
    ).toBe("ModuleNotFoundError: No module named 'torch'");
  });

  it('finds node errors and strips ANSI', () => {
    expect(extractError('\u001b[31mError: Cannot find module \'vite\'\u001b[39m\n    at Module._resolve\n')).toBe("Error: Cannot find module 'vite'");
    expect(extractError('listen EADDRINUSE: address already in use :::3000\n')).toBe('listen EADDRINUSE: address already in use :::3000');
  });

  it('falls back to weak matches, then the last line', () => {
    expect(extractError('starting\nbuild failed with 2 errors\ndone\n')).toBe('build failed with 2 errors');
    expect(extractError('one\ntwo\n')).toBe('two');
    expect(extractError('')).toBeNull();
    expect(stripAnsi('\u001b[1mbold\u001b[0m')).toBe('bold');
  });
});

describe('docker', () => {
  it('parses compose uptime', () => {
    expect(parseUpSeconds('Up 12 minutes')).toBe(720);
    expect(parseUpSeconds('Up About an hour (healthy)')).toBe(3600);
    expect(parseUpSeconds('Up 3 seconds')).toBe(3);
    expect(parseUpSeconds('Exited (1) 2 minutes ago')).toBeNull();
  });
});
