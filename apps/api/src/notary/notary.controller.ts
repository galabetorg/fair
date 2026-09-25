import { Body, Controller, Get, Headers, Param, Post, UnauthorizedException, UseInterceptors } from '@nestjs/common';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe';
import { NotaryService } from './notary.service';

const hex64 = z.string().trim().regex(/^[0-9a-fA-F]{64}$/).transform((s) => s.toLowerCase());
const escrowBody = z.object({ hash: hex64, at: z.number().int() }).strict();
const revealBody = z.object({ hash: hex64, serverSeed: hex64, at: z.number().int() }).strict();

function requireAuth(opId?: string, sig?: string) {
  if (!opId || !sig || !/^[a-z0-9-]{1,64}$/.test(opId) || !/^[0-9a-f]{128}$/i.test(sig)) {
    throw new UnauthorizedException('X-Operator-Id and X-Operator-Signature headers required');
  }
  return { opId, sig: sig.toLowerCase() };
}

@Controller('/api/notary')
@UseInterceptors(IdempotencyInterceptor)
export class NotaryController {
  constructor(private readonly notary: NotaryService) {}

  @Get('/key')
  key() {
    return { publicKey: this.notary.publicKey(), algorithm: 'Ed25519', receipt: 'canonicalJson({hash, operatorId, receivedAt, notary})' };
  }

  /** Body must include `at` (unix ms, within 5 minutes) so a captured request cannot be replayed later. */
  @Post('/commitments')
  @Throttle({ short: { limit: 10, ttl: 1_000 }, long: { limit: 600, ttl: 60_000 } })
  async escrow(
    @Headers('x-operator-id') opIdH: string | undefined,
    @Headers('x-operator-signature') sigH: string | undefined,
    @Body(new ZodPipe(escrowBody)) body: z.infer<typeof escrowBody>,
  ) {
    const { opId, sig } = requireAuth(opIdH, sigH);
    if (Math.abs(Date.now() - body.at) > 5 * 60_000) throw new UnauthorizedException('request timestamp out of window');
    await this.notary.authenticate(opId, body, sig);
    return this.notary.escrow(opId, body.hash);
  }

  @Post('/reveals')
  @Throttle({ short: { limit: 10, ttl: 1_000 } })
  async reveal(
    @Headers('x-operator-id') opIdH: string | undefined,
    @Headers('x-operator-signature') sigH: string | undefined,
    @Body(new ZodPipe(revealBody)) body: z.infer<typeof revealBody>,
  ) {
    const { opId, sig } = requireAuth(opIdH, sigH);
    if (Math.abs(Date.now() - body.at) > 5 * 60_000) throw new UnauthorizedException('request timestamp out of window');
    await this.notary.authenticate(opId, body, sig);
    return this.notary.reveal(opId, body.hash, body.serverSeed);
  }

  @Get('/commitments/:hash')
  lookup(@Param('hash', new ZodPipe(hex64)) hash: string) {
    return this.notary.lookup(hash);
  }
}
