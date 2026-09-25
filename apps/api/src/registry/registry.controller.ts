import { Body, Controller, Get, Param, Post, Res, UseGuards, UseInterceptors } from '@nestjs/common';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import type { FairRecord } from '@galabet/fair';
import { ZodPipe } from '../common/zod.pipe';
import { TurnstileGuard } from '../common/turnstile.guard';
import { recordBody } from '../verify/verify.dto';
import { RegistryService } from './registry.service';

const slug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, 'lowercase letters, digits and hyphens');
const domain = z.string().regex(/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.[a-z0-9-]{1,63})+$/i, 'a bare domain like casino.example');

const submissionBody = z
  .object({
    operatorId: slug,
    name: z.string().min(2).max(80),
    domain,
    contact: z.string().email(),
    publicKey: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    specVersion: z.literal('GFS/1.0'),
    profiles: z.array(z.enum(['single-player', 'crash'])).min(1),
    extensions: z.array(z.enum(['beacon'])).default([]),
    verifyUrl: z.string().url().optional(),
  })
  .strict();

const disputeBody = z
  .object({
    operatorDomain: domain,
    record: recordBody,
    contact: z.string().email().optional(),
  })
  .strict();

@Controller()
@UseInterceptors(IdempotencyInterceptor)
export class RegistryController {
  constructor(private readonly registry: RegistryService) {}

  @Get('/api/registry.json')
  @SkipThrottle()
  async snapshot(@Res() reply: FastifyReply) {
    const body = await this.registry.snapshot();
    reply.header('cache-control', 'public, max-age=60, s-maxage=60').send(body);
  }

  @Post('/api/registry/submissions')
  @UseGuards(TurnstileGuard)
  @Throttle({ long: { limit: 5, ttl: 60_000 } })
  submit(@Body(new ZodPipe(submissionBody)) body: z.infer<typeof submissionBody>) {
    return this.registry.submit(body);
  }

  @Get('/api/registry/disputes')
  disputes() {
    return this.registry.disputesList();
  }

  @Get('/api/registry/:id')
  operator(@Param('id', new ZodPipe(slug)) id: string) {
    return this.registry.operator(id);
  }

  @Post('/api/registry/disputes')
  @UseGuards(TurnstileGuard)
  @Throttle({ long: { limit: 5, ttl: 60_000 } })
  dispute(@Body(new ZodPipe(disputeBody)) body: z.infer<typeof disputeBody>) {
    return this.registry.dispute({ operatorDomain: body.operatorDomain, record: body.record as FairRecord, contact: body.contact });
  }
}
