import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import { DB, type Db } from '../db/db.module';
import { auditLog, conformanceRuns, disputes, operators, registryEntries } from '../db/schema';
import { BadgeService } from '../badge/badge.service';
import { NotifyService } from '../notify/notify.service';
import { CONFORMANCE_QUEUE } from '../queue/queue.module';

@Injectable()
export class AdminService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly badges: BadgeService,
    private readonly notify: NotifyService,
    @Inject(CONFORMANCE_QUEUE) private readonly conformance: Queue,
  ) {}

  private audit(action: string, subject: string, detail?: unknown) {
    return this.db.insert(auditLog).values({ id: randomUUID(), actor: 'admin', action, subject, detail: detail ?? null });
  }

  async operators() {
    return this.db
      .select({
        id: operators.id,
        name: operators.name,
        domain: operators.domain,
        contact: operators.contact,
        domainVerifiedAt: operators.domainVerifiedAt,
        status: registryEntries.status,
        lastPass: registryEntries.lastPass,
        notary: registryEntries.notary,
      })
      .from(operators)
      .leftJoin(registryEntries, eq(registryEntries.operatorId, operators.id))
      .orderBy(desc(operators.createdAt));
  }

  async setStatus(operatorId: string, status: 'active' | 'revoked' | 'lapsed' | 'pending', reason?: string) {
    const entry = await this.db.query.registryEntries.findFirst({ where: eq(registryEntries.operatorId, operatorId) });
    if (!entry) throw new NotFoundException('operator not found');
    await this.db.update(registryEntries).set({ status, revokedReason: status === 'revoked' ? (reason ?? 'revoked by admin') : null, updatedAt: new Date() }).where(eq(registryEntries.operatorId, operatorId));
    await this.audit('status.set', operatorId, { from: entry.status, to: status, reason });
    await this.badges.invalidate(operatorId);
    const op = await this.db.query.operators.findFirst({ where: eq(operators.id, operatorId) });
    if (op && (status === 'revoked' || status === 'active')) {
      await this.notify.send({ operatorId, event: status === 'revoked' ? 'entry.revoked' : 'entry.restored', detail: { reason: reason ?? null } }, { webhookUrl: op.webhookUrl, email: op.contact });
    }
    return { operatorId, status };
  }

  async setNotary(operatorId: string, notary: boolean) {
    await this.db.update(registryEntries).set({ notary, updatedAt: new Date() }).where(eq(registryEntries.operatorId, operatorId));
    await this.audit('notary.set', operatorId, { notary });
    await this.badges.invalidate(operatorId);
    return { operatorId, notary };
  }

  async rerun(operatorId: string) {
    const [last] = await this.db.select().from(conformanceRuns).where(eq(conformanceRuns.operatorId, operatorId)).orderBy(desc(conformanceRuns.createdAt)).limit(1);
    if (!last) throw new NotFoundException('no previous run to repeat');
    const id = randomUUID();
    await this.db.insert(conformanceRuns).values({ id, operatorId, specVersion: last.specVersion, profiles: last.profiles, extensions: last.extensions, verifyUrl: last.verifyUrl, vectorsHash: last.vectorsHash });
    await this.conformance.add('run', { runId: id }, { jobId: id, attempts: 3, backoff: { type: 'exponential', delay: 60_000 } });
    await this.audit('run.rerun', operatorId, { runId: id });
    return { runId: id };
  }

  async runs(operatorId: string) {
    return this.db.select().from(conformanceRuns).where(eq(conformanceRuns.operatorId, operatorId)).orderBy(desc(conformanceRuns.createdAt)).limit(50);
  }

  async disputes() {
    return this.db.select().from(disputes).orderBy(desc(disputes.filedAt)).limit(200);
  }

  async resolveDispute(id: string, outcome: 'upheld' | 'rejected', note?: string) {
    const d = await this.db.query.disputes.findFirst({ where: eq(disputes.id, id) });
    if (!d) throw new NotFoundException('dispute not found');
    await this.db.update(disputes).set({ outcome }).where(eq(disputes.id, id));
    await this.audit('dispute.resolve', id, { outcome, note, operatorId: d.operatorId });
    return { id, outcome };
  }

  async audits(subject?: string) {
    const q = this.db.select().from(auditLog).orderBy(desc(auditLog.at)).limit(200);
    return subject ? q.where(eq(auditLog.subject, subject)) : q;
  }
}
