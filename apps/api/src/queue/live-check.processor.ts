import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { verifyCommitment } from '@galabet/fair';
import { DB, type Db } from '../db/db.module';
import { liveChecks, operators, registryEntries } from '../db/schema';
import { BadgeService } from '../badge/badge.service';
import { fetchWellKnown } from './well-known';
import { NotifyService } from '../notify/notify.service';
import { auditLog } from '../db/schema';

const commitmentsSchema = z.array(
  z.object({
    commitment: z.string().regex(/^[0-9a-f]{64}$/i),
    publishedAt: z.union([z.string(), z.number()]),
    serverSeed: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  }),
).max(500);

const REVOKE_AFTER_FAILURES = 3;

/**
 * Live checks for active operators. Runs on a schedule for every active entry:
 * fetch their commitmentsUrl; record commitments we have not seen; for commitments we recorded
 * earlier that now carry a serverSeed, verify the reveal. Three bad reveals revoke the badge.
 */
@Injectable()
export class LiveCheckProcessor {
  private readonly log = new Logger(LiveCheckProcessor.name);

  constructor(@Inject(DB) private readonly db: Db, private readonly badges: BadgeService, private readonly notify: NotifyService) {}

  async processAll() {
    const active = await this.db
      .select({ id: operators.id, domain: operators.domain })
      .from(registryEntries)
      .innerJoin(operators, eq(operators.id, registryEntries.operatorId))
      .where(eq(registryEntries.status, 'active'));
    for (const op of active) await this.processOne(op.id, op.domain).catch((e) => this.log.warn(`${op.id}: ${String(e)}`));
  }

  async processOne(operatorId: string, domain: string) {
    const wk = await fetchWellKnown(domain);
    if (!wk?.commitmentsUrl) return;
    const res = await fetch(wk.commitmentsUrl, { signal: AbortSignal.timeout(8_000), headers: { 'user-agent': 'galabet-fair-runner/1.0' } }).catch(() => null);
    if (!res || !res.ok) return;
    const parsed = commitmentsSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) return;

    const pending = await this.db
      .select()
      .from(liveChecks)
      .where(and(eq(liveChecks.operatorId, operatorId), isNull(liveChecks.revealedAt)));
    const pendingByHash = new Map(pending.map((p) => [p.commitmentHash, p]));

    let badReveals = 0;
    for (const item of parsed.data) {
      const hash = item.commitment.toLowerCase();
      const seen = pendingByHash.get(hash);
      if (!seen) {
        if (!item.serverSeed) await this.db.insert(liveChecks).values({ id: randomUUID(), operatorId, commitmentHash: hash }).onConflictDoNothing();
        continue;
      }
      if (item.serverSeed) {
        const valid = await verifyCommitment(item.serverSeed.toLowerCase(), hash);
        await this.db.update(liveChecks).set({ revealedAt: new Date(), valid }).where(eq(liveChecks.id, seen.id));
        if (!valid) badReveals++;
      }
    }

    if (badReveals > 0) {
      const recentBad = await this.db.select().from(liveChecks).where(and(eq(liveChecks.operatorId, operatorId), eq(liveChecks.valid, false)));
      if (recentBad.length >= REVOKE_AFTER_FAILURES) {
        await this.db
          .update(registryEntries)
          .set({ status: 'revoked', revokedReason: `${recentBad.length} revealed seeds did not match their commitments`, updatedAt: new Date() })
          .where(eq(registryEntries.operatorId, operatorId));
        await this.badges.invalidate(operatorId);
        await this.db.insert(auditLog).values({ id: randomUUID(), actor: 'live-check', action: 'entry.revoked', subject: operatorId, detail: { badReveals: recentBad.length } });
        const op = await this.db.query.operators.findFirst({ where: eq(operators.id, operatorId) });
        await this.notify.send({ operatorId, event: 'entry.revoked', detail: { badReveals: recentBad.length } }, { webhookUrl: op?.webhookUrl, email: op?.contact });
        this.log.warn(`revoked ${operatorId}`);
      }
    } else {
      await this.db.update(registryEntries).set({ lastPass: new Date(), updatedAt: new Date() }).where(eq(registryEntries.operatorId, operatorId));
    }
  }
}
