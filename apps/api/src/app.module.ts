import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import Redis from 'ioredis';
import { CONFIG, loadConfig } from './config';
import { DbModule } from './db/db.module';
import { RedisModule } from './redis/redis.module';
import { HealthController } from './health/health.controller';
import { VerifyController } from './verify/verify.controller';
import { DemoController } from './demo/demo.controller';
import { DemoService } from './demo/demo.service';
import { BadgeController } from './badge/badge.controller';
import { BadgeService } from './badge/badge.service';
import { VectorsController } from './vectors/vectors.controller';
import { RegistryController } from './registry/registry.controller';
import { RegistryService } from './registry/registry.service';
import { TurnstileGuard } from './common/turnstile.guard';
import { QueueModule } from './queue/queue.module';
import { BeaconService } from './beacon/beacon.service';
import { BeaconController } from './beacon/beacon.controller';
import { NotaryService } from './notary/notary.service';
import { NotaryController } from './notary/notary.controller';
import { CrashService } from './crash/crash.service';
import { CrashController } from './crash/crash.controller';
import { CrashGateway } from './crash/crash.gateway';
import { CrashBets } from './crash/crash.bets';
import { ChipsService } from './demo/chips.service';
import { MinesService } from './demo/mines.service';
import { GamesController } from './demo/games.controller';
import { MetricsService } from './metrics/metrics.service';
import { MetricsController } from './metrics/metrics.controller';
import { NotifyService } from './notify/notify.service';
import { AdminService } from './admin/admin.service';
import { AdminController } from './admin/admin.controller';
import { AdminGuard } from './common/admin.guard';
import { OpenApiController } from './openapi/openapi.controller';
import { IdempotencyInterceptor } from './common/idempotency.interceptor';

@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [
        { name: 'short', ttl: 1_000, limit: 10 },
        { name: 'long', ttl: 60_000, limit: 300 },
      ],
      // Shared store: with PM2 cluster mode an in-memory limiter would be per worker.
      storage: new ThrottlerStorageRedisService(new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { keyPrefix: 'throttle:' })),
    }),
    DbModule,
    RedisModule,
    QueueModule,
  ],
  controllers: [
    HealthController,
    VerifyController,
    DemoController,
    BadgeController,
    VectorsController,
    RegistryController,
    BeaconController,
    NotaryController,
    CrashController,
    GamesController,
    MetricsController,
    AdminController,
    OpenApiController,
  ],
  providers: [
    { provide: CONFIG, useFactory: loadConfig },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    TurnstileGuard,
    DemoService,
    BadgeService,
    RegistryService,
    BeaconService,
    NotaryService,
    CrashService,
    CrashGateway,
    CrashBets,
    ChipsService,
    MinesService,
    MetricsService,
    NotifyService,
    AdminService,
    AdminGuard,
    IdempotencyInterceptor,
  ],
})
export class AppModule {}
