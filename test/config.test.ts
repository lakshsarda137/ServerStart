import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConfig, loadConfig } from '../src/config/load.js';
import { addService, editConfig, removeService, setSetting } from '../src/config/write.js';
import { SSError } from '../src/errors.js';
import { jsonSchema } from '../src/config/schema.js';

function issuesOf(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    if (e instanceof SSError) return e.issues ?? [];
    throw e;
  }
  throw new Error('expected an error');
}

describe('config validation', () => {
  it('accepts an empty config with defaults', () => {
    const c = buildConfig({}, '/x.yaml', false);
    expect(c.settings.shell).toBe('zsh');
    expect(c.settings.readyTimeoutMs).toBe(60000);
    expect(c.order).toEqual([]);
  });

  it('suggests a close name for unknown depends_on', () => {
    const issues = issuesOf(() =>
      buildConfig(
        {
          services: {
            'shop-api': { cwd: '/tmp', cmd: 'x' },
            'shop-web': { cwd: '/tmp', cmd: 'y', depends_on: ['shop-apii'] },
          },
        },
        '/x.yaml',
        true,
      ),
    );
    expect(issues).toEqual([
      { path: 'shop-web.depends_on', message: 'unknown service "shop-apii"', hint: 'did you mean "shop-api"?' },
    ]);
  });

  it('names the service and field for type errors', () => {
    const issues = issuesOf(() => buildConfig({ services: { blog: { cwd: '/tmp', cmd: 'x', port: '80800' } } }, '/x', true));
    expect(issues[0]).toMatchObject({ path: 'blog.port', message: 'expected number, got string' });
  });

  it('rejects unknown fields and non-kebab names', () => {
    const issues = issuesOf(() => buildConfig({ services: { My_App: { cwd: '/tmp', cmd: 'x', prot: 1 } } }, '/x', true));
    expect(issues.map((i) => i.message)).toContain('unknown field "prot"');
  });

  it('requires cmd and cwd unless docker', () => {
    const issues = issuesOf(() => buildConfig({ services: { a: {} } }, '/x', true));
    expect(issues.map((i) => i.path)).toEqual(['a.cmd', 'a.cwd']);
    expect(() => buildConfig({ services: { db: { docker: { compose: '/tmp/c.yml' }, port: 5432 } } }, '/x', true)).not.toThrow();
  });

  it('detects dependency cycles with their path', () => {
    const issues = issuesOf(() =>
      buildConfig(
        {
          services: {
            a: { cwd: '/tmp', cmd: 'x', depends_on: ['b'] },
            b: { cwd: '/tmp', cmd: 'x', depends_on: ['c'] },
            c: { cwd: '/tmp', cmd: 'x', depends_on: ['a'] },
          },
        },
        '/x',
        true,
      ),
    );
    expect(issues[0].message).toBe('dependency cycle: a → b → c → a');
  });

  it('derives ready checks and defaults', () => {
    const c = buildConfig(
      {
        settings: { new_services_default: false },
        services: {
          a: { cwd: '/tmp', cmd: 'x', port: 3000 },
          b: { cwd: '/tmp', cmd: 'x', ready: { http: 'http://localhost:1/health' } },
          c: { cwd: '/tmp', cmd: 'x', start_by_default: true },
        },
      },
      '/x',
      true,
    );
    expect(c.services.a.ready).toEqual({ kind: 'port', port: 3000 });
    expect(c.services.b.ready.kind).toBe('http');
    expect(c.services.c.ready).toEqual({ kind: 'alive', ms: 3000 });
    expect(c.services.a.isDefault).toBe(false);
    expect(c.services.c.isDefault).toBe(true);
  });

  it('exports a JSON schema', () => {
    expect(JSON.stringify(jsonSchema())).toContain('depends_on');
  });
});

describe('config writing', () => {
  let file: string;
  beforeEach(() => {
    file = join(mkdtempSync(join(tmpdir(), 'ss-cfg-')), 'serverstart.yaml');
  });

  it('creates the file on first write and keeps comments on later edits', () => {
    editConfig(file, (doc) => addService(doc, 'blog', { cwd: '/tmp', cmd: 'npm run dev', port: 5173, start_by_default: true }));
    const withComment = readFileSync(file, 'utf8').replace('services:', '# my services\nservices:');
    writeFileSync(file, withComment);
    editConfig(file, (doc) => setSetting(doc, 'start_on_login', true));
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# my services');
    expect(text).toContain('start_on_login: true');
    const c = loadConfig(file);
    expect(c.services.blog.port).toBe(5173);
    expect(c.settings.startOnLogin).toBe(true);
  });

  it('removes a service and references to it', () => {
    editConfig(file, (doc) => {
      addService(doc, 'db', { docker: { compose: '/tmp/compose.yml' }, port: 5432 });
      addService(doc, 'api', { cwd: '/tmp', cmd: 'x', depends_on: ['db'] });
    });
    editConfig(file, (doc) => removeService(doc, 'db'));
    const c = loadConfig(file);
    expect(c.order).toEqual(['api']);
    expect(c.services.api.dependsOn).toEqual([]);
  });

  it('refuses to write an invalid config', () => {
    expect(() => editConfig(file, (doc) => addService(doc, 'x', { cwd: '/tmp', cmd: 'x', depends_on: ['nope'] }))).toThrow(SSError);
  });
});
