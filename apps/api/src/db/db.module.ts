import { Global, Module } from '@nestjs/common';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export const DB = 'DB' as const;
export type Db = NodePgDatabase<typeof schema>;

@Global()
@Module({
  providers: [
    {
      provide: DB,
      useFactory: (): Db => {
        const pool = new Pool({
          connectionString: process.env.DATABASE_URL,
          max: 10,
          ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
        });
        return drizzle(pool, { schema });
      },
    },
  ],
  exports: [DB],
})
export class DbModule {}
