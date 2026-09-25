import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { WorkerModule } from './worker.module';
import { queueConnection } from './queue/queue.module';
import { ConformanceProcessor, type ConformanceJob } from './queue/conformance.processor';
import { LiveCheckProcessor } from './queue/live-check.processor';
import { CrashEngine } from './crash/crash.engine';

/**
 * Single-instance worker process. `pm2 start ecosystem.config.cjs` runs one of these next to the
 * clustered HTTP app. Never run two: the crash engine and the live-check schedule assume one owner.
 */
async function main() {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ['log', 'warn', 'error'] });
  const log = new Logger('worker');
  const connection = queueConnection();

  const conformance = app.get(ConformanceProcessor);
  const liveChecks = app.get(LiveCheckProcessor);

  const w1 = new Worker<ConformanceJob>('conformance', (job) => conformance.process(job.data), { connection, concurrency: 2 });
  w1.on('failed', (job, err) => log.error(`conformance ${job?.id}: ${err.message}`));

  const w2 = new Worker('live-check', () => liveChecks.processAll(), { connection, concurrency: 1 });
  w2.on('failed', (_job, err) => log.error(`live-check: ${err.message}`));

  // Schedule live checks every 6 hours. Repeatable jobs are idempotent across restarts.
  const liveQueue = new Queue('live-check', { connection });
  await liveQueue.add('all', {}, { repeat: { every: 6 * 60 * 60 * 1000 }, jobId: 'live-check-all', removeOnComplete: 10, removeOnFail: 10 });

  const engine = app.get(CrashEngine);
  if (process.env.CRASH_ENGINE !== 'off') void engine.start();

  const shutdown = async () => {
    log.log('shutting down');
    await Promise.allSettled([w1.close(), w2.close(), liveQueue.close(), app.close()]);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  log.log('worker up: conformance, live-check, crash engine');
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
