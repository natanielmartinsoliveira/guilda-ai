import { MigrationInterface, QueryRunner } from 'typeorm';
export class SubtaskSteps1780000000005 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE issues ADD COLUMN meta jsonb`);
    await q.query(
      `ALTER TABLE revisions ADD COLUMN "externalKey" varchar, ADD COLUMN title varchar`,
    );
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE revisions DROP COLUMN "externalKey", DROP COLUMN title`);
    await q.query(`ALTER TABLE issues DROP COLUMN meta`);
  }
}
