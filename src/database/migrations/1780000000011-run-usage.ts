import { MigrationInterface, QueryRunner } from 'typeorm';
export class RunUsage1780000000011 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE agent_runs ADD COLUMN "usage" jsonb`);
    await q.query(`ALTER TABLE agent_runs ADD COLUMN "phase" character varying`);
    await q.query(`ALTER TABLE tasks ADD COLUMN "usage" jsonb`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE tasks DROP COLUMN "usage"`);
    await q.query(`ALTER TABLE agent_runs DROP COLUMN "phase"`);
    await q.query(`ALTER TABLE agent_runs DROP COLUMN "usage"`);
  }
}
