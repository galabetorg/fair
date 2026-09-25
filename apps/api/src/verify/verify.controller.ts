import { BadRequestException, Body, Controller, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import {
  play,
  verifyRecord,
  commit,
  canonicalJson,
  inspectRecord,
} from "@galabet/fair";
import type { FairRecord } from "@galabet/fair";
import { ZodPipe } from "../common/zod.pipe";
import {
  recordBody,
  verifyBody,
  type RecordBody,
  type VerifyBody,
} from "./verify.dto";

/**
 * The public verifier. Stateless. The site does the same work client-side with the same library;
 * this endpoint exists for curl, integrations and people who do not trust their browser.
 */
@Controller("/api/verify")
export class VerifyController {
  @Post("/inspect")
  @Throttle({ short: { limit: 20, ttl: 1_000 } })
  async inspect(@Body() body: unknown) {
    try {
      return await inspectRecord(body);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid verification record.",
      );
    }
  }
  @Post()
  @Throttle({ short: { limit: 20, ttl: 1_000 } })
  async verify(@Body(new ZodPipe(verifyBody)) body: VerifyBody) {
    try {
      const out = await play({
        game: body.game,
        params: body.params ?? {},
        serverSeed: body.serverSeed,
        clientSeed: body.clientSeed,
        nonce: body.nonce,
      });
      const { commitment } = await commit(body.serverSeed);
      const record: FairRecord = {
        spec: "GFS/1.0",
        profile: "single-player",
        game: body.game,
        params: body.params ?? {},
        serverSeed: body.serverSeed,
        commitment,
        clientSeed: body.clientSeed,
        nonce: body.nonce,
        cursor: out.cursor,
        result: out.result,
        at: Date.now(),
      };
      return {
        result: out.result,
        cursor: out.cursor,
        floats: out.floats,
        commitment,
        record,
        canonical: canonicalJson(record),
      };
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid verification inputs.",
      );
    }
  }

  @Post("/record")
  @Throttle({ short: { limit: 20, ttl: 1_000 } })
  async record(@Body(new ZodPipe(recordBody)) body: RecordBody) {
    try {
      return await verifyRecord(body as FairRecord);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid verification record.",
      );
    }
  }
}
