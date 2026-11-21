import { describe, expect, it } from 'vitest';
import { buildConfig } from '../src/config/load.js';
import { displayGroups, impliedDefaults, resolveTargets, waves, withDependencies, withDependents } from '../src/graph.js';

const config = buildConfig(
  {
    services: {
      'shop-db': { docker: { compose: '/tmp/compose.yml' }, port: 5432, group: 'shop', start_by_default: false },
      'shop-api': { cwd: '/tmp', cmd: 'x', depends_on: ['shop-db'], group: 'shop' },
      'shop-web': { cwd: '/tmp', cmd: 'x', depends_on: ['shop-api'], group: 'shop', start_by_default: false },
      blog: { cwd: '/tmp', cmd: 'x' },
      worker: { cwd: '/tmp', cmd: 'x', depends_on: ['shop-db'], group: ['jobs', 'shop'] },
    },
  },
  '/x',
  true,
);

describe('graph', () => {
  it('resolves the default set, names and groups', () => {
    expect(resolveTargets(config, [])).toEqual(['shop-api', 'blog', 'worker']);
    expect(resolveTargets(config, ['shop'])).toEqual(['shop-db', 'shop-api', 'shop-web', 'worker']);
    expect(resolveTargets(config, ['blog', 'jobs'])).toEqual(['blog', 'worker']);
  });

  it('suggests a name for unknown targets', () => {
    expect(() => resolveTargets(config, ['blgo'])).toThrow(/unknown service or group "blgo"/);
  });

  it('pulls in dependencies and dependents', () => {
    expect(withDependencies(config, ['shop-web'])).toEqual(['shop-db', 'shop-api', 'shop-web']);
    expect(withDependents(config, ['shop-db'])).toEqual(['shop-db', 'shop-api', 'shop-web', 'worker']);
  });

  it('orders services in dependency waves', () => {
    expect(waves(config, ['shop-db', 'shop-api', 'shop-web', 'blog', 'worker'])).toEqual([
      ['shop-db', 'blog'],
      ['shop-api', 'worker'],
      ['shop-web'],
    ]);
  });

  it('finds services implied by the default set', () => {
    expect([...impliedDefaults(config)]).toEqual([['shop-db', 'shop-api']]);
  });

  it('groups for display, ungrouped last', () => {
    expect(displayGroups(config)).toEqual([
      { group: 'shop', names: ['shop-db', 'shop-api', 'shop-web'] },
      { group: 'jobs', names: ['worker'] },
      { group: null, names: ['blog'] },
    ]);
  });
});
