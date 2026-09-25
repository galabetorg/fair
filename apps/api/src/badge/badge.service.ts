import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import { DB, type Db } from '../db/db.module';
import { REDIS } from '../redis/redis.module';
import { registryEntries } from '../db/schema';

import { renderBadge, type BadgeState } from './badge.render';

@Injectable()
export class BadgeService {
  constructor(@Inject(DB) private readonly db: Db, @Inject(REDIS) private readonly redis: Redis) {}

  async forOperator(operatorId: string): Promise<{ svg: string; state: BadgeState }> {
    const cacheKey = `badge:${operatorId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      const { svg, state } = JSON.parse(cached) as { svg: string; state: BadgeState };
      return { svg, state };
    }
    const row = operatorId ? await this.db.query.registryEntries.findFirst({ where: eq(registryEntries.operatorId, operatorId) }) : undefined;
    const state: BadgeState = !row ? 'unknown' : row.status === 'active' ? 'active' : row.status === 'revoked' ? 'revoked' : 'pending';
    const svg = renderBadge(state, row?.specVersion ?? 'GFS/1.0', row?.notary ?? false);
    // Unknown ids get a short cache so badge-URL spam cannot fill Redis; known ones a minute.
    if (operatorId) await this.redis.set(cacheKey, JSON.stringify({ svg, state }), 'EX', row ? 60 : 10);
    return { svg, state };
  }

  async invalidate(operatorId: string) {
    await this.redis.del(`badge:${operatorId}`);
  }
}
