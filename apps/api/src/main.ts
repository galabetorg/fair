import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import helmet from '@fastify/helmet';
import { WsAdapter } from '@nestjs/platform-ws';
import { loadConfig } from './config';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { MetricsService } from './metrics/metrics.service';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

async function bootstrap() {
  const config = loadConfig();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: config.NODE_ENV === 'production' ? { level: 'info' } : { level: 'debug', transport: { target: 'pino-pretty' } },
      genReqId: (req: IncomingMessage) => (req.headers['cf-ray'] as string | undefined) ?? randomUUID(),
      requestIdHeader: false,
      // exactly one hop: Nginx. It overwrites X-Forwarded-For, see deploy/nginx.galabets.conf
      trustProxy: 1,
      bodyLimit: 256 * 1024,
    }),
  );

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } });

  app.enableCors({
    origin: [config.SITE_ORIGIN, 'https://galabets.org', 'https://www.galabets.org'],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Demo-Session', 'CF-Turnstile-Response', 'Idempotency-Key', 'X-Operator-Id', 'X-Operator-Signature'],
    exposedHeaders: ['Idempotency-Replayed', 'X-Request-Id'],
    maxAge: 600,
  });

  app.useGlobalFilters(new HttpExceptionFilter());
  app.useWebSocketAdapter(new WsAdapter(app));

  // Request metrics and the request id echoed back for support tickets.
  const metrics = app.get(MetricsService);
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onResponse', (req, reply, done) => {
    const route = (req.routeOptions?.url as string | undefined) ?? 'unknown';
    metrics.httpRequests.inc({ method: req.method, route, status: String(reply.statusCode) });
    metrics.httpDuration.observe({ method: req.method, route }, reply.elapsedTime / 1000);
    done();
  });
  fastify.addHook('onRequest', (req, reply, done) => {
    reply.header('x-request-id', req.id);
    done();
  });

  if (config.SENTRY_DSN) {
    const Sentry = await import('@sentry/node');
    Sentry.init({ dsn: config.SENTRY_DSN, environment: config.NODE_ENV, tracesSampleRate: 0.05 });
  }
  app.enableShutdownHooks();
  await app.listen(config.PORT, config.HOST);
  // eslint-disable-next-line no-console
  console.log(`galabet api listening on http://${config.HOST}:${config.PORT}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});