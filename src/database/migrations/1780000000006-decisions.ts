import { MigrationInterface, QueryRunner } from 'typeorm';
const STATUSES = `('PENDING','RUNNING','WAITING','SUCCESS','FAILED','CANCELLED')`;
const OLD_STATUSES = `('PENDING','RUNNING','SUCCESS','FAILED','CANCELLED')`;
/** Drops the status CHECK of a table whatever its generated name is. */
async function dropStatusCheck(q: QueryRunner, table: 'tasks' | 'revisions') {
  const rows: { conname: string }[] = await q.query(
    `SELECT conname FROM pg_constraint WHERE contype = 'c' AND conrelid = '${table}'::regclass
     AND pg_get_constraintdef(oid) LIKE '%status%'`,
  );
  for (const { conname } of rows)
    await q.query(`ALTER TABLE ${table} DROP CONSTRAINT "${conname.replace(/"/g, '""')}"`);
}
export class Decisions1780000000006 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    for (const table of ['tasks', 'revisions'] as const) {
      await dropStatusCheck(q, table);
      await q.query(
        `ALTER TABLE ${table} ADD CONSTRAINT ${table}_status_check CHECK (status IN ${STATUSES})`,
      );
    }
    await q.query(
      `CREATE TABLE decisions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenantId" varchar NOT NULL, "taskId" uuid NOT NULL REFERENCES tasks(id), "revisionId" uuid REFERENCES revisions(id), type varchar NOT NULL CHECK (type IN ('question','failure')), status varchar NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered')), questions jsonb, reason text, details text, answer jsonb, "answeredVia" varchar, "answeredAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now())`,
    );
    await q.query(`CREATE INDEX decisions_tenant_status ON decisions ("tenantId", status)`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE decisions`);
    for (const table of ['tasks', 'revisions'] as const) {
      await q.query(`UPDATE ${table} SET status = 'FAILED' WHERE status = 'WAITING'`);
      await dropStatusCheck(q, table);
      await q.query(
        `ALTER TABLE ${table} ADD CONSTRAINT ${table}_status_check CHECK (status IN ${OLD_STATUSES})`,
      );
    }
  }
}
