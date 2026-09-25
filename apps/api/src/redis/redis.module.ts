import { Global, Logger, Module } from '@nestjs/common';
import Redis from 'ioredis';

export const REDIS = 'REDIS' as const;

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      useFactory: () => {
        const log = new Logger('redis');
        const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
        const client = new Redis(url, {
          maxRetriesPerRequest: 3,
          lazyConnect: false,
          enableAutoPipelining: true,
          retryStrategy: (times) => Math.min(times * 500, 5_000),
        });
        let warned = false;
        client.on('error', (e) => {
          if (!warned) {
            log.error(`cannot reach Redis at ${url}: ${e.message}. Is docker compose up?`);
            warned = true;
          }
        });
        client.on('ready', () => {
          warned = false;
          log.log('connected');
        });
        return client;
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule {}
