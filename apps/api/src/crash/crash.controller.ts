import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  Query,
  UseInterceptors,
} from "@nestjs/common";
import { IdempotencyInterceptor } from "../common/idempotency.interceptor";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { ZodPipe } from "../common/zod.pipe";
import { historyLimit } from "../common/query.dto";
import { CrashService } from "./crash.service";
import { CrashBets } from "./crash.bets";

const betBody = z
  .object({
    amount: z.number().int().min(1).max(100_000),
    autoCashout: z
      .number()
      .min(1.01)
      .max(10_000)
      .multipleOf(0.01)
      .nullable()
      .default(null),
  })
  .strict();
const sessionId = z.string().uuid();
function sid(h?: string) {
  const p = sessionId.safeParse(h);
  if (!p.success)
    throw new BadRequestException("X-Demo-Session header must be a session id");
  return p.data;
}

/** Public read endpoints for the crash verify page. */
@Controller("/api/crash")
@UseInterceptors(IdempotencyInterceptor)
export class CrashController {
  constructor(
    private readonly crash: CrashService,
    private readonly bets: CrashBets,
  ) {}

  @Post("/bet")
  @Throttle({ short: { limit: 3, ttl: 1_000 } })
  bet(
    @Headers("x-demo-session") h: string | undefined,
    @Body(new ZodPipe(betBody)) b: z.infer<typeof betBody>,
  ) {
    return this.bets.place(sid(h), b.amount, b.autoCashout);
  }

  @Post("/cashout")
  @Throttle({ short: { limit: 5, ttl: 1_000 } })
  cashout(@Headers("x-demo-session") h?: string) {
    return this.bets.cashout(sid(h));
  }

  @Get("/me")
  me(@Headers("x-demo-session") h?: string) {
    return this.bets.myBet(sid(h));
  }

  @Get("/history")
  history(@Query("limit", new ZodPipe(historyLimit)) limit: number) {
    return this.crash.history(limit);
  }

  @Get("/chain/:id")
  async chain(@Param("id", new ZodPipe(z.string().uuid())) id: string) {
    const info = await this.crash.chainInfo(id);
    if (!info) throw new NotFoundException("chain not found");
    return info;
  }
}
