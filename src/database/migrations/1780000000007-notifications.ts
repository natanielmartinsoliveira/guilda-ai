import { MigrationInterface, QueryRunner } from 'typeorm';
export class Notifications1780000000007 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind varchar NOT NULL CHECK (kind IN ('decision','pr')), "decisionId" uuid REFERENCES decisions(id), payload jsonb, status varchar NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')), attempts integer NOT NULL DEFAULT 0, "availableAt" timestamptz NOT NULL DEFAULT now(), "sentAt" timestamptz, "messageId" varchar, "lastError" text, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now())`,
    );
    await q.query(`CREATE INDEX notifications_pending ON notifications (status, "availableAt")`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE notifications`);
  }
}
