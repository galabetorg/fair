import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { verifyRecord } from '@galabet/fair';
import type { FairRecord } from '@galabet/fair';
import { DB, type Db } from '../db/db.module';
import { conformanceRuns, disputes, operators, registryEntries } from '../db/schema';
import { BadgeService } from '../badge/badge.service';
import type { Queue } from 'bullmq';
import { CONFORMANCE_QUEUE } from '../queue/queue.module';

export interface SubmissionInput {
  operatorId: string;
  name: string;
  domain: string;
  contact: string;
  publicKey?: string;
  specVersion: 'GFS/1.0';
  profiles: string[];
  extensions: string[];
  verifyUrl?: string;
}

export interface DisputeInput {
  operatorDomain: string;
  record: FairRecord;
  contact?: string;
}

@Injectable()
export class RegistryService {
  private vectorsHashCache?: string;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly badges: BadgeService,
    @Inject(CONFORMANCE_QUEUE) private readonly conformance: Queue,
  ) {}

  private async vectorsHash() {
    if (!this.vectorsHashCache) {
      const dir = process.env.VECTORS_DIR || resolve(__dirname, '../../../../vectors');
      const vectors = await readFile(resolve(dir, 'gfs-1.0.json'), 'utf8');
      this.vectorsHashCache = createHash('sha256').update(vectors).digest('hex');
    }
    return this.vectorsHashCache;
  }

  /** Public snapshot. Cached by Cloudflare for a minute. */
  async snapshot() {
    const rows = await this.db
      .select({
        id: operators.id,
        name: operators.name,
        domain: operators.domain,
        publicKey: operators.publicKey,
        status: registryEntries.status,
        specVersion: registryEntries.specVersion,
        profiles: registryEntries.profiles,
        extensions: registryEntries.extensions,
        firstPass: registryEntries.firstPass,
        lastPass: registryEntries.lastPass,
        notary: registryEntries.notary,
      })
      .from(registryEntries)
      .innerJoin(operators, eq(operators.id, registryEntries.operatorId))
      .orderBy(desc(registryEntries.lastPass));
    return { generatedAt: new Date().toISOString(), count: rows.length, entries: rows };
  }

  async operator(id: string) {
    const op = await this.db.query.operators.findFirst({ where: eq(operators.id, id) });
    if (!op) throw new NotFoundException('operator not found');
    const entry = await this.db.query.registryEntries.findFirst({ where: eq(registryEntries.operatorId, id) });
    const runs = await this.db
      .select({
        id: conformanceRuns.id,
        specVersion: conformanceRuns.specVersion,
        profiles: conformanceRuns.profiles,
        extensions: conformanceRuns.extensions,
        passed: conformanceRuns.passed,
        ranAt: conformanceRuns.ranAt,
        createdAt: conformanceRuns.createdAt,
      })
      .from(conformanceRuns)
      .where(eq(conformanceRuns.operatorId, id))
      .orderBy(desc(conformanceRuns.createdAt))
      .limit(20);
    // Never expose contact email or the verification token.
    const { contact: _c, verificationToken: _t, ...publicOperator } = op;
    return { operator: publicOperator, entry, runs };
  }

  /**
   * Submit a conformance run. Creates the operator on first submission, files the run as pending.
   * The runner (batch 3, BullMQ) re-executes the vectors against verifyUrl and flips the entry to active.
   */
  async submit(input: SubmissionInput) {
    const vectorsHash = await this.vectorsHash();

    const existing = await this.db.query.operators.findFirst({ where: eq(operators.id, input.operatorId) });
    if (existing && existing.domain !== input.domain) throw new ConflictException('operator id already registered to a different domain');
    const byDomain = existing ? null : await this.db.query.operators.findFirst({ where: eq(operators.domain, input.domain) });
    if (byDomain) throw new ConflictException('domain already registered under another operator id');
    const verificationToken = existing?.verificationToken ?? randomBytes(16).toString('hex');

    // A pending run for this operator against the same vectors is the same request: return it instead of queueing twice.
    if (existing) {
      const [pending] = await this.db
        .select({ id: conformanceRuns.id })
        .from(conformanceRuns)
        .where(and(eq(conformanceRuns.operatorId, input.operatorId), eq(conformanceRuns.vectorsHash, vectorsHash), isNull(conformanceRuns.passed)))
        .limit(1);
      if (pending) {
        return {
          ok: true,
          operatorId: input.operatorId,
          runId: pending.id,
          status: 'pending',
          vectorsHash,
          domainVerified: Boolean(existing.domainVerifiedAt),
          verification: { url: `https://${input.domain}/.well-known/galabet-fair.json`, body: { operatorId: input.operatorId, token: verificationToken } },
          replayed: true,
        };
      }
    }
    const runId = randomUUID();
    await this.db.transaction(async (tx) => {
      if (!existing) {
        await tx.insert(operators).values({
          id: input.operatorId,
          name: input.name,
          domain: input.domain,
          contact: input.contact,
          publicKey: input.publicKey ?? null,
          verificationToken,
        });
        await tx.insert(registryEntries).values({ operatorId: input.operatorId, status: 'pending', specVersion: input.specVersion, profiles: [], extensions: [] });
      }
      await tx.insert(conformanceRuns).values({
        id: runId,
        operatorId: input.operatorId,
        specVersion: input.specVersion,
        profiles: input.profiles,
        extensions: input.extensions,
        verifyUrl: input.verifyUrl ?? null,
        vectorsHash,
        passed: null,
      });
    });
    await this.badges.invalidate(input.operatorId);
    // The worker picks this up, checks the well-known file, runs the vectors.
    await this.conformance.add('run', { runId }, { jobId: runId, attempts: 3, backoff: { type: 'exponential', delay: 60_000 }, removeOnComplete: 100, removeOnFail: 100 });
    return {
      ok: true,
      runId,
      operatorId: input.operatorId,
      status: 'pending',
      vectorsHash,
      domainVerified: Boolean(existing?.domainVerifiedAt),
      /** Publish this file before the run is executed, otherwise the run is skipped. */
      verification: {
        url: `https://${input.domain}/.well-known/galabet-fair.json`,
        body: { operatorId: input.operatorId, token: verificationToken },
      },
    };
  }

  /** File a dispute: a record that fails to verify against a listed operator. */
  async dispute(input: DisputeInput) {
    const outcome = await verifyRecord(input.record);
    if (outcome.ok) throw new ConflictException('this record verifies; there is nothing to dispute');
    const op = await this.db.query.operators.findFirst({ where: eq(operators.domain, input.operatorDomain) });
    const id = randomUUID();
    await this.db.insert(disputes).values({
      id,
      operatorId: op?.id ?? null,
      operatorDomain: input.operatorDomain,
      record: input.record,
      verifyReasons: outcome.reasons,
      contact: input.contact ?? null,
    });
    return { id, reasons: outcome.reasons, recordHash: outcome.recordHash };
  }

  async disputesList(limit = 50) {
    return this.db
      .select({ id: disputes.id, operatorDomain: disputes.operatorDomain, verifyReasons: disputes.verifyReasons, outcome: disputes.outcome, filedAt: disputes.filedAt })
      .from(disputes)
      .orderBy(desc(disputes.filedAt))
      .limit(limit);
  }
}
