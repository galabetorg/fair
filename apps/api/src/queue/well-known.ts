import { z } from 'zod';

/**
 * The file an operator publishes at https://<domain>/.well-known/galabet-fair.json
 * Proves domain control and tells the runner where to test.
 */
export const wellKnownSchema = z
  .object({
    operatorId: z.string(),
    token: z.string(),
    /** POST endpoint that reproduces a result from { game, params, serverSeed, clientSeed, nonce } and returns { result, cursor }. */
    verifyUrl: z.string().url().optional(),
    /** GET endpoint returning recent { commitment, publishedAt, serverSeed? } for live checks. */
    commitmentsUrl: z.string().url().optional(),
    publicKey: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    /** Optional: signed POST on run results and status changes. */
    webhookUrl: z.string().url().optional(),
  })
  .passthrough();

export type WellKnown = z.infer<typeof wellKnownSchema>;

export async function fetchWellKnown(domain: string): Promise<WellKnown | null> {
  const res = await fetch(`https://${domain}/.well-known/galabet-fair.json`, {
    signal: AbortSignal.timeout(8_000),
    headers: { accept: 'application/json', 'user-agent': 'galabet-fair-runner/1.0' },
    redirect: 'error',
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const parsed = wellKnownSchema.safeParse(await res.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}
