import { Controller, Get, Param, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply } from 'fastify';
import { BadgeService } from './badge.service';

const slug = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** GET /badge/:operator.svg. Cached 60s in Redis and at Cloudflare. */
@Controller('/badge')
export class BadgeController {
  constructor(private readonly badges: BadgeService) {}

  @Get('/:file')
  @Throttle({ short: { limit: 30, ttl: 1_000 } })
  async badge(@Param('file') file: string, @Res() reply: FastifyReply) {
    const id = file.endsWith('.svg') ? file.slice(0, -4) : file;
    const safeId = slug.test(id) ? id : '';
    const { svg, state } = await this.badges.forOperator(safeId);
    reply
      .header('content-type', 'image/svg+xml; charset=utf-8')
      .header('cache-control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300')
      .header('x-badge-state', state)
      .send(svg);
  }
}
