import { MigrationInterface, QueryRunner } from 'typeorm';
export class Revisions1780000000004 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE revisions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "taskId" uuid NOT NULL REFERENCES tasks(id), number integer NOT NULL, instructions text NOT NULL, origin varchar NOT NULL, "requestedBy" varchar, "externalId" varchar, attachments jsonb, status varchar NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','RUNNING','SUCCESS','FAILED','CANCELLED')), stage varchar NOT NULL DEFAULT 'QUEUED', attempts integer NOT NULL DEFAULT 0, error text, result jsonb, provider varchar, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(), CONSTRAINT revisions_task_number UNIQUE ("taskId", number), CONSTRAINT revisions_task_external UNIQUE ("taskId", "externalId"))`,
    );
    await q.query(`ALTER TABLE outbox ADD COLUMN "revisionId" uuid REFERENCES revisions(id)`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE outbox DROP COLUMN "revisionId"`);
    await q.query(`DROP TABLE revisions`);
  }
}
