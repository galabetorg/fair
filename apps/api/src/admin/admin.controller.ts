import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe';
import { AdminGuard } from '../common/admin.guard';
import { AdminService } from './admin.service';

const slug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const statusBody = z.object({ status: z.enum(['active', 'revoked', 'lapsed', 'pending']), reason: z.string().max(500).optional() }).strict();
const notaryBody = z.object({ notary: z.boolean() }).strict();
const resolveBody = z.object({ outcome: z.enum(['upheld', 'rejected']), note: z.string().max(1000).optional() }).strict();

/**
 * Operator-side admin. Bearer ADMIN_TOKEN. Everything here writes to the audit log.
 * Mount behind Nginx basic auth or an allow-list too if you want belt and braces.
 */
@Controller('/api/admin')
@UseGuards(AdminGuard)
@Throttle({ long: { limit: 120, ttl: 60_000 } })
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('/operators')
  operators() {
    return this.admin.operators();
  }

  @Post('/operators/:id/status')
  setStatus(@Param('id', new ZodPipe(slug)) id: string, @Body(new ZodPipe(statusBody)) body: z.infer<typeof statusBody>) {
    return this.admin.setStatus(id, body.status, body.reason);
  }

  @Post('/operators/:id/notary')
  setNotary(@Param('id', new ZodPipe(slug)) id: string, @Body(new ZodPipe(notaryBody)) body: z.infer<typeof notaryBody>) {
    return this.admin.setNotary(id, body.notary);
  }

  @Post('/operators/:id/rerun')
  rerun(@Param('id', new ZodPipe(slug)) id: string) {
    return this.admin.rerun(id);
  }

  @Get('/operators/:id/runs')
  runs(@Param('id', new ZodPipe(slug)) id: string) {
    return this.admin.runs(id);
  }

  @Get('/disputes')
  disputes() {
    return this.admin.disputes();
  }

  @Post('/disputes/:id/resolve')
  resolve(@Param('id', new ZodPipe(z.string().uuid())) id: string, @Body(new ZodPipe(resolveBody)) body: z.infer<typeof resolveBody>) {
    return this.admin.resolveDispute(id, body.outcome, body.note);
  }

  @Get('/audit')
  audit(@Query('subject') subject?: string) {
    return this.admin.audits(subject);
  }
}
