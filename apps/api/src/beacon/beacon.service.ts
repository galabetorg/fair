import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type Redis from 'ioredis';
import { CONFIG, type Config } from '../config';
import { REDIS } from '../redis/redis.module';

/**
 * Public randomness sources for the crash salt (GFS 5.10) and the GFS/1.1 beacon extension.
 * Values are immutable once known, so they cache forever.
 */
@Injectable()
export class BeaconService {
  constructor(@Inject(REDIS) private readonly redis: Redis, @Inject(CONFIG) private readonly config: Config) {}

  private async cached(key: string, fetcher: () => Promise<string | null>): Promise<string | null> {
    const hit = await this.redis.get(key);
    if (hit) return hit;
    const value = await fetcher();
    if (value) await this.redis.set(key, value);
    return value;
  }

  /** Latest BSC block number. */
  async evmLatestBlock(): Promise<number> {
    const res = await this.rpc('eth_blockNumber', []);
    return parseInt(res as string, 16);
  }

  /** Block hash for a block number, or null if not mined yet. */
  async evmBlockHash(block: number): Promise<string | null> {
    return this.cached(`beacon:evm:${block}`, async () => {
      const res = (await this.rpc('eth_getBlockByNumber', ['0x' + block.toString(16), false])) as { hash?: string } | null;
      return res?.hash ?? null;
    });
  }

  /** drand randomness for a round, or null if the round is in the future. */
  async drandRound(round: number): Promise<{ round: number; randomness: string; signature: string } | null> {
    const raw = await this.cached(`beacon:drand:${round}`, async () => {
      const res = await fetch(`${this.config.BEACON_DRAND_URL}/public/${round}`, { signal: AbortSignal.timeout(5_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new ServiceUnavailableException('drand unavailable');
      return JSON.stringify(await res.json());
    });
    return raw ? (JSON.parse(raw) as { round: number; randomness: string; signature: string }) : null;
  }

  private async rpc(method: string, params: unknown[]): Promise<unknown> {
    const res = await fetch(this.config.BEACON_EVM_RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new ServiceUnavailableException('evm rpc unavailable');
    const json = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (json.error) throw new ServiceUnavailableException(`evm rpc: ${json.error.message}`);
    return json.result ?? null;
  }
}
