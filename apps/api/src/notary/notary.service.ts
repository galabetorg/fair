import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { canonicalJson, sign, verifyCommitment, verifySignature } from '@galabet/fair';
import { CONFIG, type Config } from '../config';
import { DB, type Db } from '../db/db.module';
import { commitments, operators } from '../db/schema';

/**
 * Commitment escrow. An operator posts each server-seed commitment before use; we timestamp it and
 * return a receipt signed with the notary key. On rotation they post the reveal and we check it.
 * A player can then prove the casino committed to a seed before the bet, even if the casino is gone.
 *
 * Operator requests are authenticated by an Ed25519 signature over the canonical body,
 * using the public key on their registry record. No passwords, no API keys.
 */
@Injectable()
export class NotaryService {
  constructor(@Inject(DB) private readonly db: Db, @Inject(CONFIG) private readonly config: Config) {}

  publicKey(): string {
    const k = this.config.NOTARY_SIGNING_KEY;
    if (!/^[0-9a-f]{128}$/.test(k)) return '';
    return k.slice(64);
  }

  private secret(): string {
    const k = this.config.NOTARY_SIGNING_KEY;
    if (!/^[0-9a-f]{128}$/.test(k)) throw new BadRequestException('notary is not configured on this server');
    return k;
  }

  async authenticate(operatorId: string, body: unknown, signature: string) {
    const op = await this.db.query.operators.findFirst({ where: eq(operators.id, operatorId) });
    if (!op) throw new NotFoundException('operator not registered');
    if (!op.publicKey) throw new ForbiddenException('operator has no public key on file');
    if (!op.domainVerifiedAt) throw new ForbiddenException('operator domain not verified yet');
    const ok = await verifySignature(canonicalJson(body), signature, op.publicKey);
    if (!ok) throw new ForbiddenException('bad request signature');
    return op;
  }

  async escrow(operatorId: string, hash: string) {
    const existing = await this.db.query.commitments.findFirst({ where: eq(commitments.hash, hash) });
    if (existing) {
      // Same operator asking again gets the original receipt back. Another operator claiming the same hash is a conflict.
      if (existing.operatorId !== operatorId) throw new ConflictException('commitment already escrowed by another operator');
      return { hash, operatorId, receivedAt: existing.receivedAt.toISOString(), notary: this.publicKey(), receiptSignature: existing.receiptSignature, replayed: true };
    }
    const receivedAt = new Date();
    const receiptPayload = { hash, operatorId, receivedAt: receivedAt.toISOString(), notary: this.publicKey() };
    const receiptSignature = await sign(canonicalJson(receiptPayload), this.secret());
    await this.db.insert(commitments).values({ hash, operatorId, receivedAt, receiptSignature });
    return { ...receiptPayload, receiptSignature };
  }

  async reveal(operatorId: string, hash: string, serverSeed: string) {
    const row = await this.db.query.commitments.findFirst({ where: eq(commitments.hash, hash) });
    if (!row || row.operatorId !== operatorId) throw new NotFoundException('commitment not found for this operator');
    if (row.revealedAt) {
      // Repeating the same reveal is fine; revealing a different seed for an already revealed hash is not.
      if (row.serverSeed === serverSeed || (row.revealValid === false && !row.serverSeed)) {
        return { hash, valid: row.revealValid ?? false, revealedAt: row.revealedAt.toISOString(), replayed: true };
      }
      throw new ConflictException('already revealed with a different seed');
    }
    const valid = await verifyCommitment(serverSeed, hash);
    await this.db.update(commitments).set({ revealedAt: new Date(), serverSeed: valid ? serverSeed : null, revealValid: valid }).where(eq(commitments.hash, hash));
    return { hash, valid, revealedAt: new Date().toISOString() };
  }

  async lookup(hash: string) {
    const row = await this.db.query.commitments.findFirst({ where: eq(commitments.hash, hash) });
    if (!row) throw new NotFoundException('commitment not escrowed');
    return {
      hash: row.hash,
      operatorId: row.operatorId,
      receivedAt: row.receivedAt,
      receiptSignature: row.receiptSignature,
      revealedAt: row.revealedAt,
      revealValid: row.revealValid,
      serverSeed: row.revealValid ? row.serverSeed : null,
      notary: this.publicKey(),
    };
  }
}
