import { MigrationInterface, QueryRunner } from 'typeorm';
// Rows created before multi-tenancy belong to tenant "default" and the GitHub source/host.
export class MultiTenant1780000000001 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE projects ADD COLUMN "tenantId" varchar NOT NULL DEFAULT 'default', ADD COLUMN key varchar, ADD COLUMN host varchar NOT NULL DEFAULT 'github'`,
    );
    await q.query(
      `UPDATE projects SET key = lower(regexp_replace(repository, '[^A-Za-z0-9-]', '-', 'g'))`,
    );
    await q.query(
      `ALTER TABLE projects ALTER COLUMN key SET NOT NULL, ALTER COLUMN "tenantId" DROP DEFAULT, ALTER COLUMN host DROP DEFAULT, DROP CONSTRAINT projects_owner_repository_key, ADD CONSTRAINT projects_tenant_key UNIQUE ("tenantId", key)`,
    );
    await q.query(
      `ALTER TABLE issues ADD COLUMN "tenantId" varchar NOT NULL DEFAULT 'default', ADD COLUMN source varchar NOT NULL DEFAULT 'github', ADD COLUMN "externalKey" varchar, ADD COLUMN "closingRef" varchar`,
    );
    await q.query(
      `UPDATE issues SET "externalKey" = '#' || number, "closingRef" = 'Closes #' || number`,
    );
    await q.query(
      `ALTER TABLE issues DROP CONSTRAINT "issues_githubIssueId_key", ALTER COLUMN "githubIssueId" TYPE varchar, ALTER COLUMN "externalKey" SET NOT NULL, ALTER COLUMN "tenantId" DROP DEFAULT, ALTER COLUMN source DROP DEFAULT, DROP COLUMN number`,
    );
    await q.query(`ALTER TABLE issues RENAME COLUMN "githubIssueId" TO "externalId"`);
    await q.query(
      `ALTER TABLE issues ADD CONSTRAINT issues_tenant_source_external UNIQUE ("tenantId", source, "externalId")`,
    );
    await q.query(`ALTER TABLE tasks ADD COLUMN "tenantId" varchar NOT NULL DEFAULT 'default'`);
    await q.query(`ALTER TABLE tasks ALTER COLUMN "tenantId" DROP DEFAULT`);
    await q.query(`CREATE INDEX tasks_tenant ON tasks ("tenantId")`);
    await q.query(
      `ALTER TABLE pull_requests DROP CONSTRAINT "pull_requests_githubPrId_key", ALTER COLUMN "githubPrId" TYPE varchar, ADD COLUMN host varchar NOT NULL DEFAULT 'github'`,
    );
    await q.query(`ALTER TABLE pull_requests ALTER COLUMN host DROP DEFAULT`);
    await q.query(`ALTER TABLE pull_requests RENAME COLUMN "githubPrId" TO "externalId"`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE pull_requests RENAME COLUMN "externalId" TO "githubPrId"`);
    await q.query(
      `ALTER TABLE pull_requests DROP COLUMN host, ALTER COLUMN "githubPrId" TYPE bigint USING "githubPrId"::bigint, ADD CONSTRAINT "pull_requests_githubPrId_key" UNIQUE ("githubPrId")`,
    );
    await q.query(`DROP INDEX tasks_tenant`);
    await q.query(`ALTER TABLE tasks DROP COLUMN "tenantId"`);
    await q.query(`ALTER TABLE issues DROP CONSTRAINT issues_tenant_source_external`);
    await q.query(`ALTER TABLE issues RENAME COLUMN "externalId" TO "githubIssueId"`);
    await q.query(`ALTER TABLE issues ADD COLUMN number integer`);
    await q.query(`UPDATE issues SET number = ltrim("externalKey", '#')::integer`);
    await q.query(
      `ALTER TABLE issues ALTER COLUMN number SET NOT NULL, ALTER COLUMN "githubIssueId" TYPE bigint USING "githubIssueId"::bigint, ADD CONSTRAINT "issues_githubIssueId_key" UNIQUE ("githubIssueId"), DROP COLUMN "tenantId", DROP COLUMN source, DROP COLUMN "externalKey", DROP COLUMN "closingRef"`,
    );
    await q.query(
      `ALTER TABLE projects DROP CONSTRAINT projects_tenant_key, DROP COLUMN "tenantId", DROP COLUMN key, DROP COLUMN host, ADD CONSTRAINT projects_owner_repository_key UNIQUE (owner, repository)`,
    );
  }
}
