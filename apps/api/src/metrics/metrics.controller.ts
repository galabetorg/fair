import { Controller, Get, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { FastifyReply } from 'fastify';
import { MetricsService } from './metrics.service';

@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('/metrics')
  @SkipThrottle()
  async scrape(@Res() reply: FastifyReply) {
    reply.header('content-type', this.metrics.registry.contentType).send(await this.metrics.registry.metrics());
  }
}
