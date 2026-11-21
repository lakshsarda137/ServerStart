import type { Config } from './config/load.js';
import { SSError, didYouMean } from './errors.js';

/** Resolve CLI targets (service or group names) to service names. Empty = the default set. */
export function resolveTargets(config: Config, targets: string[], opts: { emptyMeansAll?: boolean } = {}): string[] {
  const all = config.order;
  if (!targets.length) {
    return opts.emptyMeansAll ? [...all] : all.filter((n) => config.services[n].isDefault);
  }
  const groups = new Map<string, string[]>();
  for (const n of all) for (const g of config.services[n].groups) groups.set(g, [...(groups.get(g) ?? []), n]);
  const out = new Set<string>();
  for (const t of targets) {
    if (t in config.services) out.add(t);
    else if (groups.has(t)) for (const n of groups.get(t)!) out.add(n);
    else {
      const guess = didYouMean(t, [...all, ...groups.keys()]);
      throw new SSError('NOT_FOUND', `unknown service or group "${t}"`, {
        hint: guess ? `did you mean "${guess}"?` : 'serverstart ls',
      });
    }
  }
  return all.filter((n) => out.has(n));
}

/** Add transitive dependencies. */
export function withDependencies(config: Config, names: string[]): string[] {
  const out = new Set<string>();
  const visit = (n: string) => {
    if (out.has(n)) return;
    out.add(n);
    for (const d of config.services[n]?.dependsOn ?? []) visit(d);
  };
  names.forEach(visit);
  return config.order.filter((n) => out.has(n));
}

/** Add transitive dependents (services that depend on any of `names`), limited to `within`. */
export function withDependents(config: Config, names: string[], within: string[] = config.order): string[] {
  const out = new Set(names);
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of within) {
      if (out.has(n)) continue;
      if (config.services[n].dependsOn.some((d) => out.has(d))) {
        out.add(n);
        changed = true;
      }
    }
  }
  return config.order.filter((n) => out.has(n));
}

/**
 * Topological order as waves: each wave depends only on earlier waves.
 * Config validation already rejects cycles.
 */
export function waves(config: Config, names: string[]): string[][] {
  const set = new Set(names);
  const done = new Set<string>();
  const result: string[][] = [];
  while (done.size < set.size) {
    const wave = names.filter(
      (n) => !done.has(n) && config.services[n].dependsOn.filter((d) => set.has(d)).every((d) => done.has(d)),
    );
    if (!wave.length) throw new SSError('CONFIG_INVALID', 'dependency cycle');
    wave.forEach((n) => done.add(n));
    result.push(wave);
  }
  return result;
}

export function topoOrder(config: Config, names: string[]): string[] {
  return waves(config, names).flat();
}

/** Services included in a bare `serverstart` only because a default service needs them. */
export function impliedDefaults(config: Config): Map<string, string> {
  const implied = new Map<string, string>();
  const defaults = config.order.filter((n) => config.services[n].isDefault);
  for (const d of defaults) {
    for (const dep of withDependencies(config, [d])) {
      if (dep !== d && !config.services[dep].isDefault && !implied.has(dep)) implied.set(dep, d);
    }
  }
  return implied;
}

/** Dashboard order: grouped by first group (ungrouped last), dependency order within a group. */
export function displayGroups(config: Config, names: string[] = config.order): { group: string | null; names: string[] }[] {
  const order = topoOrder(config, names);
  const groups: { group: string | null; names: string[] }[] = [];
  const byGroup = new Map<string | null, string[]>();
  for (const n of order) {
    const g = config.services[n].groups[0] ?? null;
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(n);
  }
  for (const [g, ns] of byGroup) if (g !== null) groups.push({ group: g, names: ns });
  if (byGroup.has(null)) groups.push({ group: null, names: byGroup.get(null)! });
  return groups;
}
