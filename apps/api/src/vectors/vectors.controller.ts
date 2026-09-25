import { Controller, Get, Inject, NotFoundException, Param, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyReply } from 'fastify';
import { CONFIG, type Config } from '../config';

export const DEFAULT_VECTORS_DIR = resolve(__dirname, '../../../../vectors');
const KNOWN = new Set(['gfs-1.0', 'gfs-1.0-crash', 'gfs-1.0-sign']);
const cache = new Map<string, { body: string; sha: string }>();

/** GET /api/vectors/gfs-1.0.json. Served from the repo, immutable once published. */
@Controller('/api/vectors')
export class VectorsController {
  constructor(@Inject(CONFIG) private readonly config: Config) {}

  @Get('/:version')
  @SkipThrottle()
  async vectors(@Param('version') version: string, @Res() reply: FastifyReply) {
    const name = version.replace(/\.json$/, '');
    if (!KNOWN.has(name)) throw new NotFoundException('unknown spec version');
    let entry = cache.get(name);
    if (!entry) {
      const dir = this.config.VECTORS_DIR || DEFAULT_VECTORS_DIR;
      const body = await readFile(resolve(dir, `${name}.json`), 'utf8');
      entry = { body, sha: createHash('sha256').update(body).digest('hex') };
      cache.set(name, entry);
    }
    const { body, sha } = entry;
    const etag = `"${sha.slice(0, 32)}"`;
    reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('cache-control', 'public, max-age=86400, immutable')
      .header('etag', etag)
      .header('x-vectors-sha256', sha)
      .send(body);
  }
}
