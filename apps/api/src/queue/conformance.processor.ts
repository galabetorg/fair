import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { canonicalJson, play } from '@galabet/fair';
import type { GameName, GameParams } from '@galabet/fair';
import { DB, type Db } from '../db/db.module';
import { conformanceRuns, operators, registryEntries } from '../db/schema';
import { BadgeService } from '../badge/badge.service';
import { fetchWellKnown } from './well-known';
import { NotifyService } from '../notify/notify.service';
import { MetricsService } from '../metrics/metrics.service';
import { randomUUID } from 'node:crypto';
import { auditLog } from '../db/schema';

interface VectorGame {
  game: GameName;
  params: GameParams;
  serverSeed: string;
  clientSeed: string;
  nonce: number;
  cursor: number;
  result: unknown;
}

export interface ConformanceJob {
  runId: string;
}

const SAMPLE = 200;

/**
 * Executes a conformance run:
 * 1. Fetch the operator's well-known file; the token must match or the run is skipped.
 * 2. POST a sample of published vectors to their verifyUrl; every result must match canonically.
 * 3. Pass flips the registry entry to active and stamps first/last pass. Fail records the log.
 */
@Injectable()
export class ConformanceProcessor {
  private readonly log = new Logger(ConformanceProcessor.name);
  private vectors?: VectorGame[];

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly badges: BadgeService,
    private readonly notify: NotifyService,
    private readonly metrics: MetricsService,
  ) {}

  private async loadVectors(): Promise<VectorGame[]> {
    if (!this.vectors) {
      const dir = process.env.VECTORS_DIR || resolve(__dirname, '../../../../vectors');
      const raw = JSON.parse(await readFile(resolve(dir, 'gfs-1.0.json'), 'utf8')) as { games: VectorGame[] };
      this.vectors = raw.games;
    }
    return this.vectors;
  }

  async process(job: ConformanceJob) {
    const run = await this.db.query.conformanceRuns.findFirst({ where: eq(conformanceRuns.id, job.runId) });
    if (!run) return;
    const op = await this.db.query.operators.findFirst({ where: eq(operators.id, run.operatorId) });
    if (!op) return;

    const log: string[] = [];
    const finish = async (passed: boolean) => {
      await this.db.update(conformanceRuns).set({ passed, log, ranAt: new Date() }).where(eq(conformanceRuns.id, run.id));
      if (passed) {
        const now = new Date();
        await this.db
          .update(registryEntries)
          .set({ status: 'active', profiles: run.profiles, extensions: run.extensions, lastPass: now, updatedAt: now })
          .where(eq(registryEntries.operatorId, op.id));
        const entry = await this.db.query.registryEntries.findFirst({ where: eq(registryEntries.operatorId, op.id) });
        if (entry && !entry.firstPass) await this.db.update(registryEntries).set({ firstPass: now }).where(eq(registryEntries.operatorId, op.id));
      }
      await this.badges.invalidate(op.id);
      await this.db.insert(auditLog).values({ id: randomUUID(), actor: 'runner', action: passed ? 'run.passed' : 'run.failed', subject: op.id, detail: { runId: run.id, log } });
      this.metrics.conformanceRuns.inc({ result: passed ? 'pass' : 'fail' });
      await this.notify.send({ operatorId: op.id, event: passed ? 'run.passed' : 'run.failed', detail: { runId: run.id, log } }, { webhookUrl: op.webhookUrl, email: op.contact });
      this.log.log(`run ${run.id} for ${op.id}: ${passed ? 'PASS' : 'FAIL'}`);
    };

    // 1. domain proof
    const wk = await fetchWellKnown(op.domain);
    if (!wk || wk.operatorId !== op.id || wk.token !== op.verificationToken) {
      log.push('well-known file missing or token mismatch; publish it and resubmit');
      return finish(false);
    }
    if (!op.domainVerifiedAt) await this.db.update(operators).set({ domainVerifiedAt: new Date() }).where(eq(operators.id, op.id));
    if (wk.publicKey && !op.publicKey) await this.db.update(operators).set({ publicKey: wk.publicKey }).where(eq(operators.id, op.id));
    if (wk.webhookUrl && wk.webhookUrl !== op.webhookUrl) await this.db.update(operators).set({ webhookUrl: wk.webhookUrl }).where(eq(operators.id, op.id));

    const verifyUrl = wk.verifyUrl ?? run.verifyUrl;
    if (!verifyUrl) {
      log.push('no verifyUrl in well-known file or submission');
      return finish(false);
    }

    // 2. sample vectors, deterministic per run id so reruns hit the same set
    const all = await this.loadVectors();
    const seedNum = parseInt(run.id.replace(/-/g, '').slice(0, 8), 16);
    const sample = all.filter((_, i) => (i * 2654435761 + seedNum) % Math.ceil(all.length / SAMPLE) === 0).slice(0, SAMPLE);

    let failures = 0;
    for (const v of sample) {
      const expected = await play({ game: v.game, params: v.params, serverSeed: v.serverSeed, clientSeed: v.clientSeed, nonce: v.nonce });
      let theirs: { result?: unknown; cursor?: number } | null = null;
      try {
        const res = await fetch(verifyUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'galabet-fair-runner/1.0' },
          body: JSON.stringify({ game: v.game, params: v.params, serverSeed: v.serverSeed, clientSeed: v.clientSeed, nonce: v.nonce }),
          signal: AbortSignal.timeout(10_000),
        });
        theirs = res.ok ? ((await res.json()) as { result?: unknown; cursor?: number }) : null;
      } catch {
        theirs = null;
      }
      const ok = theirs && canonicalJson(theirs.result) === canonicalJson(expected.result) && (theirs.cursor === undefined || theirs.cursor === expected.cursor);
      if (!ok) {
        failures++;
        if (log.length < 25) log.push(`${v.game} nonce ${v.nonce}: expected ${canonicalJson(expected.result)} got ${theirs ? canonicalJson(theirs.result) : 'no response'}`);
        if (failures > 10) break;
      }
    }
    log.push(`${sample.length - failures}/${sample.length} vectors matched`);
    return finish(failures === 0);
  }
}
