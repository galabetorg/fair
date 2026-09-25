CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"subject" text NOT NULL,
	"detail" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commitments" (
	"hash" text PRIMARY KEY NOT NULL,
	"operator_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"receipt_signature" text NOT NULL,
	"revealed_at" timestamp with time zone,
	"server_seed" text,
	"reveal_valid" boolean
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conformance_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"operator_id" text NOT NULL,
	"spec_version" text NOT NULL,
	"profiles" jsonb NOT NULL,
	"extensions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verify_url" text,
	"vectors_hash" text NOT NULL,
	"passed" boolean,
	"log" jsonb,
	"ran_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crash_chains" (
	"id" text PRIMARY KEY NOT NULL,
	"terminating_hash" text NOT NULL,
	"length" integer NOT NULL,
	"salt_source" text NOT NULL,
	"salt_ref" text NOT NULL,
	"salt_value" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crash_games" (
	"chain_id" text NOT NULL,
	"index" integer NOT NULL,
	"game_hash" text NOT NULL,
	"result" text NOT NULL,
	"played_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "disputes" (
	"id" text PRIMARY KEY NOT NULL,
	"operator_id" text,
	"operator_domain" text NOT NULL,
	"record" jsonb NOT NULL,
	"verify_reasons" jsonb NOT NULL,
	"contact" text,
	"outcome" text DEFAULT 'open' NOT NULL,
	"filed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "live_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"operator_id" text NOT NULL,
	"commitment_hash" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revealed_at" timestamp with time zone,
	"valid" boolean
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "operators" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"public_key" text,
	"contact" text NOT NULL,
	"verification_token" text NOT NULL,
	"domain_verified_at" timestamp with time zone,
	"webhook_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "registry_entries" (
	"operator_id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"spec_version" text DEFAULT 'GFS/1.0' NOT NULL,
	"profiles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"extensions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"first_pass" timestamp with time zone,
	"last_pass" timestamp with time zone,
	"revoked_reason" text,
	"notary" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commitments" ADD CONSTRAINT "commitments_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conformance_runs" ADD CONSTRAINT "conformance_runs_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crash_games" ADD CONSTRAINT "crash_games_chain_id_crash_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."crash_chains"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "disputes" ADD CONSTRAINT "disputes_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "live_checks" ADD CONSTRAINT "live_checks_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "registry_entries" ADD CONSTRAINT "registry_entries_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_subject_idx" ON "audit_log" USING btree ("subject");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commitments_operator_idx" ON "commitments" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conformance_runs_operator_idx" ON "conformance_runs" USING btree ("operator_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "crash_games_chain_index_idx" ON "crash_games" USING btree ("chain_id","index");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "disputes_operator_idx" ON "disputes" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "live_checks_operator_idx" ON "live_checks" USING btree ("operator_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "live_checks_operator_hash_idx" ON "live_checks" USING btree ("operator_id","commitment_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "operators_domain_idx" ON "operators" USING btree ("domain");