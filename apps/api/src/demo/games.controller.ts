import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  UseInterceptors,
} from "@nestjs/common";
import { IdempotencyInterceptor } from "../common/idempotency.interceptor";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { ZodPipe } from "../common/zod.pipe";
import { ChipsService } from "./chips.service";
import { DemoService } from "./demo.service";
import { MinesService } from "./mines.service";
import { MetricsService } from "../metrics/metrics.service";
import {
  publicRuleCatalog,
  DEMO_RULE_VERSION,
  diceChance,
  chipReceipt,
} from "./rules";
import { CARD_RULE_VERSION, dealerTrace } from "./card-rules";
import {
  diceMultiplier,
  diceWin,
  kenoMultiplier,
  limboWin,
  plinkoTable,
  rouletteMultiplier,
  rouletteWin,
  wheelMultiplier,
  type RouletteBet,
} from "./payouts";

const sessionId = z.string().uuid();
const amount = z.number().int().min(1).max(100_000);
export const blackjackAnalysisBody = z
  .object({
    hand: z
      .array(z.string().regex(/^[2-9TJQKA][CDHS]$/))
      .min(2)
      .max(20),
    following: z
      .array(z.string().regex(/^[2-9TJQKA][CDHS]$/))
      .max(52)
      .default([]),
    hitSoft17: z.boolean().default(false),
  })
  .strict()
  .superRefine((body, ctx) => {
    const cards = [...body.hand, ...body.following];
    if (new Set(cards).size !== cards.length)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "public analysis uses distinct cards from one deck",
      });
  });

const diceBody = z
  .object({
    amount,
    target: z.number().min(2).max(98).multipleOf(0.01),
    over: z.boolean(),
  })
  .strict();
const limboBody = z
  .object({
    amount,
    target: z.number().min(1.01).max(1_000_000).multipleOf(0.01),
  })
  .strict();
const rouletteBody = z
  .object({
    amount,
    bet: z.discriminatedUnion("type", [
      z.object({
        type: z.literal("straight"),
        number: z.number().int().min(0).max(36),
      }),
      z.object({ type: z.literal("color"), color: z.enum(["red", "black"]) }),
      z.object({ type: z.literal("parity"), parity: z.enum(["odd", "even"]) }),
      z.object({ type: z.literal("range"), range: z.enum(["low", "high"]) }),
      z.object({
        type: z.literal("dozen"),
        dozen: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      }),
      z.object({
        type: z.literal("column"),
        column: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      }),
    ]),
  })
  .strict();
const wheelBody = z.object({ amount }).strict();
const plinkoBody = z
  .object({
    amount,
    rows: z.union([z.literal(8), z.literal(12), z.literal(16)]),
  })
  .strict();
const kenoBody = z
  .object({
    amount,
    picks: z.array(z.number().int().min(1).max(40)).min(1).max(10),
  })
  .strict();
const minesStart = z
  .object({ amount, mines: z.number().int().min(1).max(24) })
  .strict();
const minesPick = z.object({ tile: z.number().int().min(0).max(24) }).strict();

function sid(header?: string): string {
  const p = sessionId.safeParse(header);
  if (!p.success)
    throw new BadRequestException("X-Demo-Session header must be a session id");
  return p.data;
}

/**
 * The playable demo. Every endpoint: debit chips, derive the outcome through the fair library,
 * settle chips, return the record so the player can verify it. Blackjack and hilo reveal a shuffled
 * deck through /api/demo/bet and are played client-side; their chip logic lands with their UI.
 */
@Controller("/api/demo/games")
@UseInterceptors(IdempotencyInterceptor)
@Throttle({ short: { limit: 5, ttl: 1_000 } })
export class GamesController {
  constructor(
    private readonly demo: DemoService,
    private readonly chips: ChipsService,
    private readonly mines: MinesService,
    private readonly metrics: MetricsService,
  ) {}

  @Get("/rules")
  rules() {
    return publicRuleCatalog();
  }

  @Post("/analyze/blackjack")
  @HttpCode(200)
  analyzeBlackjack(
    @Body(new ZodPipe(blackjackAnalysisBody))
    body: z.infer<typeof blackjackAnalysisBody>,
  ) {
    return {
      ruleVersion: CARD_RULE_VERSION,
      mode: "public-input analysis",
      ...dealerTrace(body.hand, body.following, body.hitSoft17),
    };
  }

  @Get("/chips")
  async chipsBalance(@Headers("x-demo-session") h?: string) {
    return { chips: await this.chips.balance(sid(h)) };
  }

  @Post("/chips/refill")
  @Throttle({ long: { limit: 3, ttl: 60_000 } })
  async refill(@Headers("x-demo-session") h?: string) {
    return { chips: await this.chips.refill(sid(h)) };
  }

  @Post("/dice")
  async dice(
    @Headers("x-demo-session") h: string | undefined,
    @Body(new ZodPipe(diceBody)) b: z.infer<typeof diceBody>,
  ) {
    const s = sid(h);
    return this.demo.withSession(s, async () => {
      await this.demo.load(s);
      await this.chips.debit(s, b.amount);
      const { record } = await this.demo.deriveRecord(s, "dice", {});
      const roll = record.result as number;
      const win = diceWin(roll, b);
      const multiplier = diceMultiplier(b);
      const receipt = chipReceipt(b.amount, multiplier, win);
      const payout = receipt.returned;
      const chips = await this.chips.credit(s, payout);
      this.metrics.demoBets.inc({ game: "dice" });
      return {
        record,
        roll,
        win,
        multiplier,
        payout,
        chips,
        chance: diceChance(b),
        settlement: {
          ...receipt,
          selection: { target: b.target, over: b.over },
        },
      };
    });
  }

  @Post("/limbo")
  async limbo(
    @Headers("x-demo-session") h: string | undefined,
    @Body(new ZodPipe(limboBody)) b: z.infer<typeof limboBody>,
  ) {
    const s = sid(h);
    return this.demo.withSession(s, async () => {
      await this.demo.load(s);
      await this.chips.debit(s, b.amount);
      const { record } = await this.demo.deriveRecord(s, "limbo", {
        houseEdge: 0.01,
      });
      const result = record.result as number;
      const win = limboWin(result, b.target);
      const receipt = chipReceipt(b.amount, b.target, win);
      const payout = receipt.returned;
      const chips = await this.chips.credit(s, payout);
      this.metrics.demoBets.inc({ game: "limbo" });
      return {
        record,
        result,
        win,
        payout,
        chips,
        settlement: {
          ...receipt,
          selection: { target: b.target },
        },
      };
    });
  }

  @Post("/roulette")
  async roulette(
    @Headers("x-demo-session") h: string | undefined,
    @Body(new ZodPipe(rouletteBody)) b: z.infer<typeof rouletteBody>,
  ) {
    const s = sid(h);
    return this.demo.withSession(s, async () => {
      await this.demo.load(s);
      await this.chips.debit(s, b.amount);
      const { record } = await this.demo.deriveRecord(s, "roulette", {});
      const pocket = record.result as number;
      const bet = b.bet as RouletteBet;
      const win = rouletteWin(pocket, bet);
      const receipt = chipReceipt(b.amount, rouletteMultiplier(bet), win);
      const payout = receipt.returned;
      const chips = await this.chips.credit(s, payout);
      this.metrics.demoBets.inc({ game: "roulette" });
      return {
        record,
        pocket,
        win,
        payout,
        chips,
        settlement: {
          ...receipt,
          selection: bet,
        },
      };
    });
  }

  @Post("/wheel")
  async wheel(
    @Headers("x-demo-session") h: string | undefined,
    @Body(new ZodPipe(wheelBody)) b: z.infer<typeof wheelBody>,
  ) {
    const s = sid(h);
    return this.demo.withSession(s, async () => {
      await this.demo.load(s);
      await this.chips.debit(s, b.amount);
      const { record } = await this.demo.deriveRecord(s, "wheel", {
        segments: 10,
      });
      const segment = record.result as number;
      const multiplier = wheelMultiplier(segment);
      const receipt = chipReceipt(b.amount, multiplier, true);
      const payout = receipt.returned;
      const chips = await this.chips.credit(s, payout);
      this.metrics.demoBets.inc({ game: "wheel" });
      return {
        record,
        segment,
        multiplier,
        payout,
        chips,
        settlement: {
          ...receipt,
          configuration: DEMO_RULE_VERSION,
        },
      };
    });
  }

  @Post("/plinko")
  async plinko(
    @Headers("x-demo-session") h: string | undefined,
    @Body(new ZodPipe(plinkoBody)) b: z.infer<typeof plinkoBody>,
  ) {
    const s = sid(h);
    return this.demo.withSession(s, async () => {
      await this.demo.load(s);
      await this.chips.debit(s, b.amount);
      const { record } = await this.demo.deriveRecord(s, "plinko", {
        rows: b.rows,
      });
      const { path, bucket } = record.result as {
        path: number[];
        bucket: number;
      };
      const table = plinkoTable(b.rows);
      const multiplier = table[bucket] ?? 0;
      const receipt = chipReceipt(b.amount, multiplier, true);
      const payout = receipt.returned;
      const chips = await this.chips.credit(s, payout);
      this.metrics.demoBets.inc({ game: "plinko" });
      return {
        record,
        path,
        bucket,
        multiplier,
        table,
        payout,
        chips,
        settlement: {
          ...receipt,
          selection: { rows: b.rows },
        },
      };
    });
  }

  @Post("/keno")
  async keno(
    @Headers("x-demo-session") h: string | undefined,
    @Body(new ZodPipe(kenoBody)) b: z.infer<typeof kenoBody>,
  ) {
    if (new Set(b.picks).size !== b.picks.length)
      throw new BadRequestException("duplicate picks");
    const s = sid(h);
    return this.demo.withSession(s, async () => {
      await this.demo.load(s);
      await this.chips.debit(s, b.amount);
      const { record } = await this.demo.deriveRecord(s, "keno", { draws: 10 });
      const drawn = record.result as number[];
      const hits = b.picks.filter((p) => drawn.includes(p)).length;
      const multiplier = kenoMultiplier(b.picks.length, hits);
      const receipt = chipReceipt(b.amount, multiplier, true);
      const payout = receipt.returned;
      const chips = await this.chips.credit(s, payout);
      this.metrics.demoBets.inc({ game: "keno" });
      return {
        record,
        drawn,
        hits,
        multiplier,
        payout,
        chips,
        settlement: {
          ...receipt,
          selection: { picks: b.picks },
          hits,
        },
      };
    });
  }

  @Post("/mines/start")
  minesStart(
    @Headers("x-demo-session") h: string | undefined,
    @Body(new ZodPipe(minesStart)) b: z.infer<typeof minesStart>,
  ) {
    this.metrics.demoBets.inc({ game: "mines" });
    return this.mines.start(sid(h), b.amount, b.mines);
  }

  @Post("/mines/pick")
  minesPick(
    @Headers("x-demo-session") h: string | undefined,
    @Body(new ZodPipe(minesPick)) b: z.infer<typeof minesPick>,
  ) {
    return this.mines.pick(sid(h), b.tile);
  }

  @Post("/mines/cashout")
  minesCashout(@Headers("x-demo-session") h?: string) {
    return this.mines.cashout(sid(h));
  }

  /** Give up the open board: stake lost, layout and record published, seed changes allowed again. */
  @Post("/mines/forfeit")
  minesForfeit(@Headers("x-demo-session") h?: string) {
    return this.mines.forfeit(sid(h));
  }

  @Get("/mines")
  minesCurrent(@Headers("x-demo-session") h?: string) {
    return this.mines.current(sid(h));
  }
}
