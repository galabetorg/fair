import { Global, Module } from '@nestjs/common';
import { Queue } from 'bullmq';

export const CONFORMANCE_QUEUE = 'CONFORMANCE_QUEUE' as const;
export const LIVE_CHECK_QUEUE = 'LIVE_CHECK_QUEUE' as const;

function connection() {
  const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  return { host: url.hostname, port: Number(url.port || 6379), password: url.password || undefined, maxRetriesPerRequest: null as null };
}

export const queueConnection = connection;

/** Queue producers. Consumers live in the worker process (src/worker.ts), never in the HTTP app. */
@Global()
@Module({
  providers: [
    { provide: CONFORMANCE_QUEUE, useFactory: () => new Queue('conformance', { connection: connection() }) },
    { provide: LIVE_CHECK_QUEUE, useFactory: () => new Queue('live-check', { connection: connection() }) },
  ],
  exports: [CONFORMANCE_QUEUE, LIVE_CHECK_QUEUE],
})
export class QueueModule {}
