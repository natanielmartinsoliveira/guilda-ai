import { MigrationInterface, QueryRunner } from 'typeorm';
export class SessionPassword1780000000009 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    // Sessions opened before this change carry no tag and stop working: log in again.
    await q.query(`ALTER TABLE web_sessions ADD COLUMN "passwordTag" varchar`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE web_sessions DROP COLUMN "passwordTag"`);
  }
}
