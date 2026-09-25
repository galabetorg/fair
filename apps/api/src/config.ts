import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  SITE_ORIGIN: z.string().default('http://localhost:4321'),
  TURNSTILE_SECRET: z.string().optional().default(''),
  NOTARY_SIGNING_KEY: z.string().optional().default(''),
  BEACON_DRAND_URL: z.string().url().default('https://api.drand.sh'),
  BEACON_EVM_RPC: z.string().url().default('https://bsc-dataseed.binance.org'),
  DEMO_SESSION_TTL: z.coerce.number().int().positive().default(86400),
  DEMO_SESSIONS_PER_IP_PER_DAY: z.coerce.number().int().positive().default(30),
  /** Absolute path to the vectors directory. Defaults to <repo>/vectors relative to the built API. */
  VECTORS_DIR: z.string().optional().default(''),
  /** Bearer token for /api/admin/*. Empty disables the admin API entirely. */
  ADMIN_TOKEN: z.string().optional().default(''),
  /** Optional error tracking. */
  SENTRY_DSN: z.string().optional().default(''),
  /** Optional SMTP for operator notifications, e.g. smtp://user:pass@smtp.example.com:587 */
  SMTP_URL: z.string().optional().default(''),
  MAIL_FROM: z.string().optional().default('Galabet Fair <no-reply@galabets.org>'),
  /** Postgres over TLS on managed hosts. */
  DATABASE_SSL: z.enum(['true', 'false']).optional().default('false'),
  /** Virtual chips every demo session starts with. */
  DEMO_START_CHIPS: z.coerce.number().int().positive().default(1000),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}

export const CONFIG = 'CONFIG' as const;
