import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CONFIG, type Config } from '../config';

/**
 * Cloudflare Turnstile check for public POST forms (registry submissions, disputes).
 * Disabled when TURNSTILE_SECRET is empty so local development needs no keys.
 */
@Injectable()
export class TurnstileGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: Config) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (!this.config.TURNSTILE_SECRET) return true;
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const token = (req.headers['cf-turnstile-response'] as string | undefined) ?? '';
    if (!token) throw new ForbiddenException('turnstile token missing');
    let data: { success?: boolean };
    try {
      const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret: this.config.TURNSTILE_SECRET, response: token, remoteip: req.ip }),
        signal: AbortSignal.timeout(5_000),
      });
      data = (await res.json()) as { success?: boolean };
    } catch {
      // Fail closed: a form submission is never worth accepting unverified.
      throw new ServiceUnavailableException('turnstile verification unavailable, retry shortly');
    }
    if (!data.success) throw new ForbiddenException('turnstile check failed');
    return true;
  }
}
