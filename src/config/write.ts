import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Document, isMap, parseDocument, YAMLMap } from 'yaml';
import { configPath } from '../paths.js';
import { buildConfig, type Config } from './load.js';
import type { RawService } from './schema.js';

const HEADER = `# ServerStart config. Edit with \`serverstart edit\`; schema: \`serverstart schema\`.
`;

function newDocument(): Document {
  const doc = parseDocument(
    `${HEADER}version: 1\nsettings:\n  shell: zsh\n  ready_timeout: 60s\n  new_services_default: true\n  start_on_login: false\n  open_dashboard_on_login: false\nservices: {}\n`,
  );
  return doc;
}

export function readDocument(path: string): Document {
  if (!existsSync(path)) return newDocument();
  return parseDocument(readFileSync(path, 'utf8'));
}

/** Atomic write: temp file + rename. */
export function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/**
 * Edit the config through the YAML Document API so comments and key order survive.
 * The edited document is validated before it's written.
 */
export function editConfig(override: string | undefined, fn: (doc: Document) => void): Config {
  const path = configPath(override);
  const doc = readDocument(path);
  fn(doc);
  const config = buildConfig(doc.toJS(), path, true);
  atomicWrite(path, doc.toString({ lineWidth: 0 }));
  return config;
}

function servicesMap(doc: Document): YAMLMap {
  const services = doc.get('services');
  if (isMap(services)) {
    services.flow = false;
    return services as YAMLMap;
  }
  const m = new YAMLMap();
  doc.set('services', m);
  return m;
}

export function addService(doc: Document, name: string, service: RawService): void {
  const map = servicesMap(doc);
  map.flow = false;
  map.set(name, doc.createNode(service));
}

export function removeService(doc: Document, name: string): void {
  const map = servicesMap(doc);
  map.delete(name);
  // drop references from other services' depends_on
  for (const item of map.items) {
    const svc = item.value;
    if (!isMap(svc)) continue;
    const deps = svc.get('depends_on');
    if (deps && typeof (deps as { toJSON?: unknown }).toJSON === 'function') {
      const arr = (deps as { toJSON(): unknown }).toJSON();
      if (Array.isArray(arr) && arr.includes(name)) {
        const next = arr.filter((d) => d !== name);
        if (next.length) svc.set('depends_on', doc.createNode(next));
        else svc.delete('depends_on');
      }
    }
  }
}

export function setServiceField(doc: Document, name: string, key: string, value: unknown): void {
  doc.setIn(['services', name, key], value);
}

export function setSetting(doc: Document, key: string, value: unknown): void {
  if (!isMap(doc.get('settings'))) doc.set('settings', doc.createNode({}));
  doc.setIn(['settings', key], value);
}
