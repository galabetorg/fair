import { pgTable, text, integer, boolean, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';

export const operators = pgTable(
  'operators',
  {
    id: text('id').primaryKey(), // slug, e.g. "example-casino"
    name: text('name').notNull(),
    domain: text('domain').notNull(),
    publicKey: text('public_key'), // Ed25519 hex, optional until they sign records
    contact: text('contact').notNull(),
    /** Random token the operator must publish at https://<domain>/.well-known/galabet-fair.json before any run counts. */
    verificationToken: text('verification_token').notNull(),
    domainVerifiedAt: timestamp('domain_verified_at', { withTimezone: true }),
    /** Optional, copied from the well-known file: signed POST on run results and status changes. */
    webhookUrl: text('webhook_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ domainIdx: uniqueIndex('operators_domain_idx').on(t.domain) }),
);

export const registryEntries = pgTable('registry_entries', {
  operatorId: text('operator_id').primaryKey().references(() => operators.id),
  status: text('status', { enum: ['pending', 'active', 'revoked', 'lapsed'] }).notNull().default('pending'),
  specVersion: text('spec_version').notNull().default('GFS/1.0'),
  profiles: jsonb('profiles').$type<string[]>().notNull().default([]),
  extensions: jsonb('extensions').$type<string[]>().notNull().default([]),
  firstPass: timestamp('first_pass', { withTimezone: true }),
  lastPass: timestamp('last_pass', { withTimezone: true }),
  revokedReason: text('revoked_reason'),
  notary: boolean('notary').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const conformanceRuns = pgTable(
  'conformance_runs',
  {
    id: text('id').primaryKey(),
    operatorId: text('operator_id').notNull().references(() => operators.id),
    specVersion: text('spec_version').notNull(),
    profiles: jsonb('profiles').$type<string[]>().notNull(),
    extensions: jsonb('extensions').$type<string[]>().notNull().default([]),
    verifyUrl: text('verify_url'), // operator endpoint the runner re-executes against
    vectorsHash: text('vectors_hash').notNull(),
    passed: boolean('passed'),
    log: jsonb('log').$type<unknown>(),
    ranAt: timestamp('ran_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ opIdx: index('conformance_runs_operator_idx').on(t.operatorId) }),
);

export const liveChecks = pgTable(
  'live_checks',
  {
    id: text('id').primaryKey(),
    operatorId: text('operator_id').notNull().references(() => operators.id),
    commitmentHash: text('commitment_hash').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    revealedAt: timestamp('revealed_at', { withTimezone: true }),
    valid: boolean('valid'),
  },
  (t) => ({
    opIdx: index('live_checks_operator_idx').on(t.operatorId),
    uniq: uniqueIndex('live_checks_operator_hash_idx').on(t.operatorId, t.commitmentHash),
  }),
);

/** Every admin action and every automatic status change, append only. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    actor: text('actor').notNull(), // 'admin' | 'runner' | 'live-check'
    action: text('action').notNull(),
    subject: text('subject').notNull(), // operator id, run id, dispute id
    detail: jsonb('detail').$type<unknown>(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ subjectIdx: index('audit_log_subject_idx').on(t.subject) }),
);

export const commitments = pgTable(
  'commitments',
  {
    hash: text('hash').primaryKey(),
    operatorId: text('operator_id').notNull().references(() => operators.id),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    receiptSignature: text('receipt_signature').notNull(),
    revealedAt: timestamp('revealed_at', { withTimezone: true }),
    serverSeed: text('server_seed'),
    revealValid: boolean('reveal_valid'),
  },
  (t) => ({ opIdx: index('commitments_operator_idx').on(t.operatorId) }),
);

export const disputes = pgTable(
  'disputes',
  {
    id: text('id').primaryKey(),
    operatorId: text('operator_id').references(() => operators.id),
    operatorDomain: text('operator_domain').notNull(),
    record: jsonb('record').$type<unknown>().notNull(),
    verifyReasons: jsonb('verify_reasons').$type<string[]>().notNull(),
    contact: text('contact'),
    outcome: text('outcome', { enum: ['open', 'upheld', 'rejected'] }).notNull().default('open'),
    filedAt: timestamp('filed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ opIdx: index('disputes_operator_idx').on(t.operatorId) }),
);

export const crashChains = pgTable('crash_chains', {
  id: text('id').primaryKey(),
  terminatingHash: text('terminating_hash').notNull(),
  length: integer('length').notNull(),
  saltSource: text('salt_source', { enum: ['evm', 'drand'] }).notNull(),
  saltRef: text('salt_ref').notNull(),
  saltValue: text('salt_value'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const crashGames = pgTable(
  'crash_games',
  {
    chainId: text('chain_id').notNull().references(() => crashChains.id),
    index: integer('index').notNull(),
    gameHash: text('game_hash').notNull(),
    result: text('result').notNull(),
    playedAt: timestamp('played_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ chainIdx: uniqueIndex('crash_games_chain_index_idx').on(t.chainId, t.index) }),
);

export type Operator = typeof operators.$inferSelect;
export type RegistryEntry = typeof registryEntries.$inferSelect;
