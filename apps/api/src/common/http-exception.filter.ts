import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * One error shape for every route: { statusCode, error, message, requestId }.
 * Stack traces never leave the process; unexpected errors are logged with the request id.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger('http');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const req = ctx.getRequest<FastifyRequest>();
    const requestId = req.id;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const payload = typeof body === 'string' ? { message: body } : (body as Record<string, unknown>);
      reply.status(status).send({ statusCode: status, error: HttpStatus[status], ...payload, requestId });
      return;
    }

    // Fastify rejects some requests before Nest sees them (body over the limit, broken JSON,
    // unknown content type). Those errors carry their own 4xx status and a plain message.
    const fst = exception as { code?: unknown; statusCode?: unknown; message?: unknown } | null;
    if (typeof fst?.code === 'string' && fst.code.startsWith('FST_') && typeof fst.statusCode === 'number' && fst.statusCode >= 400 && fst.statusCode < 500) {
      reply.status(fst.statusCode).send({ statusCode: fst.statusCode, error: HttpStatus[fst.statusCode], message: String(fst.message), requestId });
      return;
    }

    this.log.error(`${req.method} ${req.url} [${requestId}] ${exception instanceof Error ? exception.stack : String(exception)}`);
    reply.status(500).send({ statusCode: 500, error: 'Internal Server Error', message: 'unexpected error', requestId });
  }
}
