import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { CONFIG, type Config } from '../config';

/** Bearer token for the admin API. Disabled entirely when ADMIN_TOKEN is empty. */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: Config) {}
  canActivate(ctx: ExecutionContext): boolean {
    const expected = this.config.ADMIN_TOKEN;
    if (!expected) throw new UnauthorizedException('admin api disabled');
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException('bad admin token');
    return true;
  }
}
