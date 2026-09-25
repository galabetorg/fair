import { Inject, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import type Redis from "ioredis";
import type { Server, WebSocket } from "ws";
import { REDIS } from "../redis/redis.module";
import { CRASH_CHANNEL } from "./crash.engine";

const MAX_CLIENTS = 2_000;

/** Rebuild wire messages from public fields; never forward internal Redis objects verbatim. */
export function publicCrashMessage(message: string): string | null {
  try {
    const event = JSON.parse(message);
    const { type, chainId, index } = event;
    if (type === "paused")
      return JSON.stringify({ type, reason: String(event.reason) });
    if (typeof chainId !== "string" || !Number.isSafeInteger(index))
      return null;
    if (type === "waiting")
      return JSON.stringify({ type, chainId, index, startsAt: event.startsAt });
    if (type === "tick")
      return JSON.stringify({
        type,
        chainId,
        index,
        multiplier: event.multiplier,
        elapsed: event.elapsed,
      });
    if (type === "crash") {
      const settled = Array.isArray(event.settled)
        ? {
            bets: event.settled.length,
            paid: event.settled.filter((b: { payout: number }) => b.payout > 0)
              .length,
            totalPayout: event.settled.reduce(
              (total: number, b: { payout: number }) => total + b.payout,
              0,
            ),
          }
        : {
            bets: event.settled.bets,
            paid: event.settled.paid,
            totalPayout: event.settled.totalPayout,
          };
      return JSON.stringify({
        type,
        chainId,
        index,
        gameHash: event.gameHash,
        result: event.result,
        salt: event.salt,
        settled,
      });
    }
    if (type === "void")
      return JSON.stringify({
        type,
        chainId,
        index,
        gameHash: event.gameHash,
        result: event.result,
        salt: event.salt,
        refunded: {
          bets: event.refunded.bets,
          refunded: event.refunded.refunded,
          totalRefund: event.refunded.totalRefund,
        },
      });
  } catch {
    /* Malformed internal events are not sent to visitors. */
  }
  return null;
}

/**
 * Relays engine events from Redis pub/sub to browsers. Read-only: clients send nothing.
 * Runs in every HTTP worker, so a PM2 cluster fans out without shared socket state.
 */
@WebSocketGateway({ path: "/ws/crash" })
export class CrashGateway implements OnModuleInit, OnModuleDestroy {
  @WebSocketServer() server!: Server;
  private readonly log = new Logger(CrashGateway.name);
  private sub?: Redis;
  private last = "";

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  onModuleInit() {
    this.sub = this.redis.duplicate();
    this.sub.subscribe(CRASH_CHANNEL).catch((e) => this.log.error(String(e)));
    this.sub.on("message", (_ch, msg) => {
      const publicMessage = publicCrashMessage(msg);
      if (!publicMessage) return;
      this.last = publicMessage;
      if (!this.server) return;
      for (const client of this.server.clients) {
        if ((client as WebSocket).readyState === 1)
          (client as WebSocket).send(publicMessage);
      }
    });
  }

  handleConnection(client: WebSocket) {
    if (this.server && this.server.clients.size > MAX_CLIENTS) {
      client.close(1013, "try again later");
      return;
    }
    client.on("message", () => client.close(1003, "read only"));
    if (this.last) client.send(this.last);
  }

  onModuleDestroy() {
    this.sub?.disconnect();
  }
}
