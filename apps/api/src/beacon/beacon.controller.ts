import { Controller, Get, NotFoundException, Param, ParseIntPipe } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { BeaconService } from './beacon.service';

/** Read-through cache so the verify page never hits drand or an RPC directly. */
@Controller('/api/beacon')
export class BeaconController {
  constructor(private readonly beacon: BeaconService) {}

  @Get('/drand/:round')
  @Throttle({ short: { limit: 5, ttl: 1_000 } })
  async drand(@Param('round', ParseIntPipe) round: number) {
    const r = await this.beacon.drandRound(round);
    if (!r) throw new NotFoundException('round not yet available');
    return r;
  }

  @Get('/evm/:block')
  @Throttle({ short: { limit: 5, ttl: 1_000 } })
  async evm(@Param('block', ParseIntPipe) block: number) {
    const hash = await this.beacon.evmBlockHash(block);
    if (!hash) throw new NotFoundException('block not yet mined');
    return { block, hash };
  }
}
