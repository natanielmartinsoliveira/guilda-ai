import { MigrationInterface, QueryRunner } from 'typeorm';
export class CardRestart1780000000012 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE tasks DROP CONSTRAINT "tasks_issueId_key"`);
    await q.query(`CREATE INDEX tasks_issue_created ON tasks ("issueId", "createdAt" DESC)`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX tasks_issue_created`);
    await q.query(`ALTER TABLE tasks ADD CONSTRAINT "tasks_issueId_key" UNIQUE ("issueId")`);
  }
}
