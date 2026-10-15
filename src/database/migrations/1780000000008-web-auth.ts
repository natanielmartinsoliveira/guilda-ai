import { MigrationInterface, QueryRunner } from 'typeorm';
async function dropKindCheck(q: QueryRunner) {
  const rows: { conname: string }[] = await q.query(
    `SELECT conname FROM pg_constraint WHERE contype = 'c' AND conrelid = 'notifications'::regclass
     AND pg_get_constraintdef(oid) LIKE '%kind%'`,
  );
  for (const { conname } of rows)
    await q.query(`ALTER TABLE notifications DROP CONSTRAINT "${conname.replace(/"/g, '""')}"`);
}
export class WebAuth1780000000008 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await dropKindCheck(q);
    await q.query(
      `ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('decision','pr','text'))`,
    );
    await q.query(
      `CREATE TABLE web_logins (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "codeHash" varchar NOT NULL, "expiresAt" timestamptz NOT NULL, attempts integer NOT NULL DEFAULT 0, "usedAt" timestamptz, ip varchar, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now())`,
    );
    await q.query(
      `CREATE TABLE web_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tokenHash" varchar NOT NULL UNIQUE, "expiresAt" timestamptz NOT NULL, "revokedAt" timestamptz, ip varchar, "userAgent" varchar, "lastSeenAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now())`,
    );
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE web_sessions`);
    await q.query(`DROP TABLE web_logins`);
    await q.query(`DELETE FROM notifications WHERE kind = 'text'`);
    await dropKindCheck(q);
    await q.query(
      `ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('decision','pr'))`,
    );
  }
}
