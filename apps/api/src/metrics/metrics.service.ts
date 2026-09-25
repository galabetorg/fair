import { Injectable } from '@nestjs/common';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/** Prometheus metrics. Scrape /metrics from localhost only (Nginx does not expose it). */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  readonly httpRequests = new Counter({ name: 'galabet_http_requests_total', help: 'HTTP requests', labelNames: ['method', 'route', 'status'], registers: [this.registry] });
  readonly httpDuration = new Histogram({ name: 'galabet_http_duration_seconds', help: 'HTTP duration', labelNames: ['method', 'route'], buckets: [0.005, 0.02, 0.05, 0.1, 0.3, 1, 3], registers: [this.registry] });
  readonly verifications = new Counter({ name: 'galabet_verifications_total', help: 'Verify calls', labelNames: ['kind', 'ok'], registers: [this.registry] });
  readonly demoBets = new Counter({ name: 'galabet_demo_bets_total', help: 'Demo bets', labelNames: ['game'], registers: [this.registry] });
  readonly conformanceRuns = new Counter({ name: 'galabet_conformance_runs_total', help: 'Conformance runs', labelNames: ['result'], registers: [this.registry] });

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: 'galabet_' });
  }
}
