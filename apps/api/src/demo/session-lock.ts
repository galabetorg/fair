import { ConflictException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type Redis from "ioredis";

/** Serialize different actions for one demo session, even across API workers. */
export async function withDemoSession<T>(
  redis: Redis,
  id: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `demo:action-lock:${id}`,
    owner = randomUUID();
  const acquired = await redis.set(key, owner, "PX", 30_000, "NX");
  if (!acquired)
    throw new ConflictException(
      "another action is being processed; retry after it completes",
    );
  try {
    return await operation();
  } finally {
    await redis.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
      1,
      key,
      owner,
    );
  }
}
