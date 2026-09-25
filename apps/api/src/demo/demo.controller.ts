import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Ip,
  Post,
  Query,
  UseInterceptors,
} from "@nestjs/common";
import { IdempotencyInterceptor } from "../common/idempotency.interceptor";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { ZodPipe } from "../common/zod.pipe";
import { historyLimit } from "../common/query.dto";
import { clientSeed, gameParams } from "../verify/verify.dto";
import { DemoService } from "./demo.service";

const sessionId = z.string().uuid();
const clientSeedBody = z.object({ clientSeed }).strict();
const betBody = z
  .object({
    game: z.enum([
      "dice",
      "limbo",
      "roulette",
      "wheel",
      "plinko",
      "mines",
      "keno",
      "blackjack",
      "hilo",
    ]),
    params: gameParams.default({}),
  })
  .strict();

function requireSession(header: string | undefined): string {
  const parsed = sessionId.safeParse(header);
  if (!parsed.success)
    throw new BadRequestException("X-Demo-Session header must be a session id");
  return parsed.data;
}

/** Seed endpoints behind the free games. The browser sends its session id in X-Demo-Session. */
@Controller("/api/demo")
@UseInterceptors(IdempotencyInterceptor)
export class DemoController {
  constructor(private readonly demo: DemoService) {}

  @Post("/session")
  @Throttle({
    short: { limit: 3, ttl: 1_000 },
    long: { limit: 30, ttl: 60_000 },
  })
  create(@Ip() ip: string) {
    return this.demo.create(ip);
  }

  @Get("/session")
  view(@Headers("x-demo-session") sid?: string) {
    return this.demo.view(requireSession(sid));
  }

  @Post("/client-seed")
  setClientSeed(
    @Headers("x-demo-session") sid: string | undefined,
    @Body(new ZodPipe(clientSeedBody)) body: z.infer<typeof clientSeedBody>,
  ) {
    return this.demo.setClientSeed(requireSession(sid), body.clientSeed);
  }

  @Post("/bet")
  @Throttle({ short: { limit: 5, ttl: 1_000 } })
  bet(
    @Headers("x-demo-session") sid: string | undefined,
    @Body(new ZodPipe(betBody)) body: z.infer<typeof betBody>,
  ) {
    return this.demo.bet(requireSession(sid), body.game, body.params);
  }

  @Post("/rotate")
  @Throttle({ short: { limit: 2, ttl: 1_000 } })
  rotate(@Headers("x-demo-session") sid?: string) {
    return this.demo.rotate(requireSession(sid));
  }

  @Get("/history")
  history(
    @Headers("x-demo-session") sid: string | undefined,
    @Query("limit", new ZodPipe(historyLimit)) limit: number,
  ) {
    return this.demo.history(requireSession(sid), limit);
  }
}
