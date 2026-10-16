import { MigrationInterface, QueryRunner } from 'typeorm';
export class TaskCost1780000000010 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE tasks ADD COLUMN "costUsd" double precision NOT NULL DEFAULT 0`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE tasks DROP COLUMN "costUsd"`);
  }
}
