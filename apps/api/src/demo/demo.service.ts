import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type Redis from "ioredis";
import {
  commit,
  createClientSeed,
  createServerSeed,
  play,
  assertClientSeed,
} from "@galabet/fair";
import type { FairRecord, GameName, GameParams } from "@galabet/fair";
import { CONFIG, type Config } from "../config";
import { REDIS } from "../redis/redis.module";
import { RedisSeedStore, type DemoSession, type SeedStore } from "./seed-store";
import { withDemoSession } from "./session-lock";

const KEEP_RECORDS = 100;
const DAY = 86_400;

/**
 * Seed lifecycle for the free demo games on the site. No money, no accounts:
 * a session is a random id the browser keeps in localStorage and sends as X-Demo-Session.
 */
@Injectable()
export class DemoService {
  private readonly store: SeedStore;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CONFIG) private readonly config: Config,
  ) {
    // The Mines board shares the session's expiry, so an unfinished board and its record cannot
    // vanish while the session and its history live. The player ends one with cash-out or forfeit.
    this.store = new RedisSeedStore(redis, ["mines"]);
  }

  private ttl() {
    return this.config.DEMO_SESSION_TTL;
  }

  withSession<T>(id: string, action: () => Promise<T>) {
    return withDemoSession(this.redis, id, action);
  }

  private async assertNoActiveBoard(id: string) {
    const raw = await this.redis.get(`demo:mines:${id}`);
    if (raw && !(JSON.parse(raw) as { over: boolean }).over)
      throw new BadRequestException(
        "finish the active Mines board before changing or revealing seeds",
      );
  }

  /** Public view: everything except the server seed, plus the live nonce. */
  private async publicView(s: DemoSession) {
    const { serverSeed: _hidden, ...rest } = s;
    return { ...rest, nonce: await this.store.peekNonce(s.id) };
  }

  async create(ip: string) {
    const n = await this.store.countSession(ip, DAY);
    if (n > this.config.DEMO_SESSIONS_PER_IP_PER_DAY) {
      throw new HttpException(
        "too many demo sessions from this address today",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const serverSeed = await createServerSeed();
    const { commitment } = await commit(serverSeed);
    const session: DemoSession = {
      id: randomUUID(),
      serverSeed,
      commitment,
      clientSeed: await createClientSeed(),
      betsUnderSeed: 0,
      createdAt: Date.now(),
    };
    await this.store.put(session, this.ttl());
    return this.publicView(session);
  }

  async load(id: string) {
    const s = await this.store.get(id, this.ttl());
    if (!s) throw new NotFoundException("demo session not found or expired");
    return s;
  }

  async view(id: string) {
    return this.publicView(await this.load(id));
  }

  /** Changing the client seed starts a fresh committed server seed and nonce sequence. */
  async setClientSeed(id: string, clientSeed: string) {
    return this.withSession(id, async () => {
      try {
        assertClientSeed(clientSeed);
      } catch (error) {
        throw new BadRequestException(
          error instanceof Error ? error.message : "invalid client seed",
        );
      }
      await this.assertNoActiveBoard(id);
      const s = await this.load(id);
      if (s.clientSeed === clientSeed) return this.publicView(s);
      // Reusing an earlier client seed must not recreate a previously disclosed deck/board.
      if (s.betsUnderSeed > 0)
        await this.store.reveal(id, s.commitment, s.serverSeed, this.ttl());
      const serverSeed = await createServerSeed();
      const { commitment } = await commit(serverSeed);
      const next = {
        ...s,
        clientSeed,
        serverSeed,
        commitment,
        betsUnderSeed: 0,
      };
      await this.store.put(next, this.ttl(), s.commitment);
      return this.publicView(next);
    });
  }

  async bet(id: string, game: GameName, params: GameParams) {
    return this.withSession(id, () => this.deriveRecord(id, game, params));
  }

  /** Internal caller must hold the session lock. Concealed games publish only after completion. */
  async deriveRecord(
    id: string,
    game: GameName,
    params: GameParams,
    publish = true,
  ) {
    const s = await this.load(id);
    const nonce = await this.store.reserveNonce(id, this.ttl(), s.commitment);
    const out = await play({
      game,
      params,
      serverSeed: s.serverSeed,
      clientSeed: s.clientSeed,
      nonce,
    });
    const record: FairRecord = {
      spec: "GFS/1.0",
      profile: "single-player",
      game,
      params,
      commitment: s.commitment,
      clientSeed: s.clientSeed,
      nonce,
      cursor: out.cursor,
      result: out.result,
      at: Date.now(),
    };
    s.betsUnderSeed += 1;
    await this.store.put(s, this.ttl(), s.commitment);
    if (publish) await this.publishRecord(id, record);
    return { record, nonceNext: nonce + 1 };
  }

  async publishRecord(id: string, record: FairRecord) {
    const existing = await this.store.records(id, KEEP_RECORDS);
    if (
      !existing.some(
        (r) =>
          r.commitment === record.commitment &&
          r.clientSeed === record.clientSeed &&
          r.nonce === record.nonce,
      )
    ) {
      await this.store.pushRecord(id, record, KEEP_RECORDS, this.ttl());
    }
  }

  /** Reveal the current server seed, start a fresh one. GFS 7. */
  async rotate(id: string) {
    return this.withSession(id, async () => {
      await this.assertNoActiveBoard(id);
      const s = await this.load(id);
      if (s.betsUnderSeed === 0)
        throw new BadRequestException(
          "nothing to reveal: no bets under this seed yet",
        );
      const revealed = {
        serverSeed: s.serverSeed,
        commitment: s.commitment,
        bets: s.betsUnderSeed,
      };
      await this.store.reveal(id, s.commitment, s.serverSeed, this.ttl());
      const serverSeed = await createServerSeed();
      const { commitment } = await commit(serverSeed);
      const next: DemoSession = {
        ...s,
        serverSeed,
        commitment,
        betsUnderSeed: 0,
      };
      await this.store.put(next, this.ttl(), s.commitment);
      return { revealed, next: await this.publicView(next) };
    });
  }

  /** Last records. Every record whose seed has been revealed comes back with the seed attached, however many rotations ago. */
  async history(id: string, limit = 50) {
    await this.load(id);
    const [records, revealed] = await Promise.all([
      this.store.records(id, Math.min(limit, KEEP_RECORDS)),
      this.store.revealed(id),
    ]);
    const raw = await this.redis.get(`demo:mines:${id}`);
    const active = raw
      ? (JSON.parse(raw) as { over: boolean; record: FairRecord })
      : null;
    return records.map((r) => {
      // Also protect boards created before deferred history publication was introduced.
      if (
        active &&
        !active.over &&
        r.commitment === active.record.commitment &&
        r.clientSeed === active.record.clientSeed &&
        r.nonce === active.record.nonce
      ) {
        return { ...r, result: undefined, serverSeed: undefined };
      }
      return revealed[r.commitment]
        ? { ...r, serverSeed: revealed[r.commitment] }
        : r;
    });
  }
}
