import { Module } from '@nestjs/common';
import { CONFIG, loadConfig } from './config';
import { DbModule } from './db/db.module';
import { RedisModule } from './redis/redis.module';
import { QueueModule } from './queue/queue.module';
import { BadgeService } from './badge/badge.service';
import { BeaconService } from './beacon/beacon.service';
import { ConformanceProcessor } from './queue/conformance.processor';
import { LiveCheckProcessor } from './queue/live-check.processor';
import { CrashService } from './crash/crash.service';
import { CrashEngine } from './crash/crash.engine';
import { CrashBets } from './crash/crash.bets';
import { ChipsService } from './demo/chips.service';
import { NotifyService } from './notify/notify.service';
import { MetricsService } from './metrics/metrics.service';

/** Everything that must run exactly once: queue consumers, the live-check schedule, the crash loop. */
@Module({
  imports: [DbModule, RedisModule, QueueModule],
  providers: [{ provide: CONFIG, useFactory: loadConfig }, BadgeService, BeaconService, ConformanceProcessor, LiveCheckProcessor, CrashService, CrashEngine, CrashBets, ChipsService, NotifyService, MetricsService],
})
export class WorkerModule {}
