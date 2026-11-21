import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const duration = z.union([
  z.number().int().positive().describe('milliseconds'),
  z.string().regex(/^\d+(?:\.\d+)?(?:ms|s|m)$/, 'expected a duration like "60s", "500ms" or "2m"'),
]);

export const settingsSchema = z
  .object({
    shell: z.string().default('zsh').describe('Commands run via `<shell> -lc`'),
    ready_timeout: duration.default('60s'),
    new_services_default: z.boolean().default(true).describe('Whether newly added services join the default set'),
    start_on_login: z.boolean().default(false).describe('Run `serverstart up` once at login'),
    open_dashboard_on_login: z.boolean().default(false).describe('With start_on_login: also open a Terminal window with the dashboard'),
  })
  .strict();

const readySchema = z
  .object({
    port: z.boolean().optional(),
    http: z.string().url().optional(),
    log: z.string().optional(),
  })
  .strict()
  .refine((r) => [r.port, r.http, r.log].filter((v) => v !== undefined).length <= 1, {
    message: 'use only one of port, http or log',
  });

export const serviceSchema = z
  .object({
    cwd: z.string().optional(),
    cmd: z.string().min(1).optional(),
    docker: z
      .object({
        compose: z.string(),
        service: z.string().optional(),
      })
      .strict()
      .optional(),
    port: z.number().int().min(1).max(65535).optional(),
    ready: readySchema.optional(),
    depends_on: z.array(z.string()).optional(),
    group: z.union([z.string(), z.array(z.string())]).optional(),
    env: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
    env_file: z.string().optional(),
    python: z
      .object({
        venv: z.string().optional(),
        conda: z.string().optional(),
        uv: z.boolean().optional(),
      })
      .strict()
      .refine((p) => [p.venv, p.conda, p.uv].filter((v) => v !== undefined && v !== false).length <= 1, {
        message: 'use only one of venv, conda or uv',
      })
      .optional(),
    node: z.object({ version: z.string().optional() }).strict().optional(),
    start_by_default: z.boolean().optional(),
    url: z.string().url().optional(),
  })
  .strict();

export const configSchema = z
  .object({
    version: z.literal(1).default(1),
    settings: settingsSchema.default({}),
    services: z.record(serviceSchema).nullable().default({}),
  })
  .strict();

export type RawSettings = z.infer<typeof settingsSchema>;
export type RawService = z.infer<typeof serviceSchema>;
export type RawConfig = z.infer<typeof configSchema>;

export const SETTING_KEYS = Object.keys(settingsSchema.shape) as (keyof RawSettings)[];

export function jsonSchema(): object {
  return zodToJsonSchema(configSchema, { name: 'ServerStartConfig', $refStrategy: 'none' });
}

export function parseDuration(v: string | number): number {
  if (typeof v === 'number') return v;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(v);
  if (!m) return 60000;
  const n = Number(m[1]);
  return m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : n * 60000;
}
