import { MigrationInterface, QueryRunner } from 'typeorm';
export class Attachments1780000000002 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE issues ADD COLUMN attachments jsonb`);
    await q.query(`CREATE INDEX tasks_tenant_created ON tasks ("tenantId", "createdAt" DESC)`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX tasks_tenant_created`);
    await q.query(`ALTER TABLE issues DROP COLUMN attachments`);
  }
}
