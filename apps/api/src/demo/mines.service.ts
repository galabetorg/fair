import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type Redis from "ioredis";
import type { FairRecord } from "@galabet/fair";
import { CONFIG, type Config } from "../config";
import { REDIS } from "../redis/redis.module";
import { ChipsService } from "./chips.service";
import { DemoService } from "./demo.service";
import { chipPayout, minesMultiplier } from "./payouts";

interface MinesGame {
  record: FairRecord; // result = mine positions, hidden until the game ends
  amount: number;
  mines: number;
  picks: number[];
  over: boolean;
  /** How the round ended. Absent while live and on boards saved before outcomes were kept. */
  outcome?: "cashout" | "mine" | "forfeit";
  payout?: number;
}

const SETTLED =
  "round already cashed out; repeat the cash-out to close the board";

/**
 * Stateful mines: start reveals nothing, each pick is checked against the fixed layout, and cash-out,
 * a mine or forfeit ends it. The board key expires with the session (see DemoService), so an
 * abandoned board stays until the player ends it. Each ending publishes the record before the board
 * is saved as over; history() redacts a published record while its board is still live, so a failed
 * board write can be retried without losing or exposing the record.
 */
@Injectable()
export class MinesService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CONFIG) private readonly config: Config,
    private readonly chips: ChipsService,
    private readonly demo: DemoService,
  ) {}

  private key(sid: string) {
    return `demo:mines:${sid}`;
  }

  private round(g: MinesGame) {
    return `mines:${g.record.commitment}:${g.record.clientSeed}:${g.record.nonce}`;
  }

  private async load(sid: string): Promise<MinesGame> {
    const raw = await this.redis.get(this.key(sid));
    if (!raw) throw new NotFoundException("no mines game in progress");
    return JSON.parse(raw) as MinesGame;
  }

  private save(sid: string, g: MinesGame) {
    return this.redis.set(
      this.key(sid),
      JSON.stringify(g),
      "EX",
      this.config.DEMO_SESSION_TTL,
    );
  }

  private view(g: MinesGame) {
    const { record, ...rest } = g;
    const publicRecord = g.over ? record : { ...record, result: undefined };
    return {
      ...rest,
      record: publicRecord,
      multiplier: minesMultiplier(g.mines, g.picks.length),
      next:
        g.over || g.picks.length === 25 - g.mines
          ? null
          : minesMultiplier(g.mines, g.picks.length + 1),
    };
  }

  /** Publish the finished round, then close the board. */
  private async end(
    sid: string,
    g: MinesGame,
    outcome: NonNullable<MinesGame["outcome"]>,
    payout: number,
  ) {
    g.over = true;
    g.outcome = outcome;
    g.payout = payout;
    await this.demo.publishRecord(sid, g.record);
    await this.save(sid, g);
    return { ...this.view(g), boom: outcome === "mine", payout };
  }

  /** Load a board that can still be played: not over, and not already paid by a cash-out whose board write failed. */
  private async live(sid: string) {
    const g = await this.load(sid);
    if (g.over) throw new BadRequestException("game is over");
    if (await this.chips.creditReceipt(sid, this.round(g)))
      throw new BadRequestException(SETTLED);
    return g;
  }

  async start(sid: string, amount: number, mines: number) {
    return this.demo.withSession(sid, async () => {
      const existing = await this.redis.get(this.key(sid));
      if (existing && !(JSON.parse(existing) as MinesGame).over)
        throw new BadRequestException("finish the current game first");
      await this.demo.load(sid);
      await this.chips.debit(sid, amount);
      const { record } = await this.demo.deriveRecord(
        sid,
        "mines",
        { mines },
        false,
      );
      const g: MinesGame = { record, amount, mines, picks: [], over: false };
      await this.save(sid, g);
      return this.view(g);
    });
  }

  async pick(sid: string, tile: number) {
    return this.demo.withSession(sid, async () => {
      const g = await this.live(sid);
      if (g.picks.includes(tile))
        throw new BadRequestException("tile already picked");
      const layout = g.record.result as number[];
      if (layout.includes(tile)) return this.end(sid, g, "mine", 0);
      g.picks.push(tile);
      const allSafe = g.picks.length === 25 - g.mines;
      if (allSafe) return this.finish(sid, g);
      await this.save(sid, g);
      return { ...this.view(g), boom: false };
    });
  }

  async cashout(sid: string) {
    return this.demo.withSession(sid, async () =>
      this.finish(sid, await this.load(sid)),
    );
  }

  /** Give up a live board: the stake is lost and the board closes like a mine hit, freeing seed changes. */
  async forfeit(sid: string) {
    return this.demo.withSession(sid, async () =>
      this.end(sid, await this.live(sid), "forfeit", 0),
    );
  }

  private async finish(sid: string, g: MinesGame) {
    if (g.over) throw new BadRequestException("game is over");
    const round = this.round(g);
    let receipt = await this.chips.creditReceipt(sid, round);
    if (!receipt) {
      if (g.picks.length === 0)
        throw new BadRequestException("pick at least one tile first");
      const payout = chipPayout(
        g.amount,
        minesMultiplier(g.mines, g.picks.length),
      );
      receipt = (
        await this.chips.creditOnce(sid, payout, round, { picks: g.picks })
      ).receipt;
    }
    // A retry after a failed board write reports the credited settlement. The final safe pick of an
    // all-safe board may be missing from the saved board, so the picks come from the marker too.
    if (Array.isArray(receipt.picks)) g.picks = receipt.picks as number[];
    const payout =
      receipt.payout ??
      chipPayout(g.amount, minesMultiplier(g.mines, g.picks.length));
    return this.end(sid, g, "cashout", payout);
  }

  async current(sid: string) {
    return this.view(await this.load(sid));
  }
}
