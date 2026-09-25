import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import type Redis from "ioredis";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { Observable, from, firstValueFrom } from "rxjs";
import { REDIS } from "../redis/redis.module";
const TTL = 24 * 60 * 60,
  KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;
/** Retry response cache, scoped to session+route. Uncertain outcomes remain blocked for reconciliation. */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>(),
      reply = ctx.switchToHttp().getResponse<FastifyReply>();
    if (req.method !== "POST" || req.headers["idempotency-key"] === undefined)
      return next.handle();
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !KEY_RE.test(key))
      throw new HttpException("invalid Idempotency-Key", 400);
    const scope =
      req.headers["x-demo-session"] ?? req.headers["x-operator-id"] ?? req.ip;
    const route = req.routeOptions?.url ?? req.url;
    const digest = (s: string) => createHash("sha256").update(s).digest("hex");
    const bodyHash = digest(JSON.stringify(req.body ?? null));
    const redisKey = `idem:${digest(JSON.stringify([scope, route, key]))}`;
    return from(
      (async () => {
        const replay = (stored: string) => {
          const saved = JSON.parse(stored);
          if (saved.bodyHash !== bodyHash)
            throw new HttpException(
              "idempotency key reused with a different request body",
              422,
            );
          if (saved.inFlight)
            throw new HttpException(
              "request outcome pending; inspect the session before retrying",
              409,
            );
          reply.header("idempotency-replayed", "true");
          reply.status(saved.status);
          if (saved.error) throw new HttpException(saved.body, saved.status);
          return saved.body;
        };
        const stored = await this.redis.get(redisKey);
        if (stored) return replay(stored);
        const pending = JSON.stringify({ bodyHash, inFlight: true });
        const locked = await this.redis.set(redisKey, pending, "EX", TTL, "NX");
        if (!locked) {
          const concurrent = await this.redis.get(redisKey);
          if (concurrent) return replay(concurrent);
          throw new HttpException("request state unavailable", 503);
        }
        let body: unknown,
          status = reply.statusCode || 200,
          error = false;
        try {
          body = await firstValueFrom(next.handle());
          status = reply.statusCode || 200;
        } catch (e) {
          // A 5xx/network/storage failure may have happened after a debit. Never release its marker blindly.
          if (!(e instanceof HttpException) || e.getStatus() >= 500) throw e;
          status = e.getStatus();
          body = e.getResponse();
          error = true;
        }
        const saved = JSON.stringify({ bodyHash, status, body, error });
        const result = await this.redis.eval(
          `if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[3]); return 1`,
          1,
          redisKey,
          pending,
          saved,
          TTL,
        );
        if (result !== 1)
          throw new HttpException(
            "request outcome could not be stored; inspect the session",
            503,
          );
        if (error) throw new HttpException(body as string, status);
        return body;
      })(),
    );
  }
}
