import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { sql } from "drizzle-orm";
import type Redis from "ioredis";
import { DB, type Db } from "../db/db.module";
import { REDIS } from "../redis/redis.module";
import { SPEC_VERSION } from "@galabet/fair";

@Controller()
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get("/api/health")
  @Throttle({ short: { limit: 2, ttl: 1_000 } })
  async health() {
    const [pg, rd] = await Promise.allSettled([
      bounded(() => this.db.execute(sql`select 1`)),
      bounded(() => this.redis.ping()),
    ]);
    const status = {
      ok: pg.status === "fulfilled" && rd.status === "fulfilled",
      spec: SPEC_VERSION,
      postgres: pg.status,
      redis: rd.status,
      time: new Date().toISOString(),
    };
    if (!status.ok) throw new ServiceUnavailableException(status);
    return status;
  }
}

async function bounded<T>(
  check: () => PromiseLike<T>,
  milliseconds = 2000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(check),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("dependency check timed out")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
