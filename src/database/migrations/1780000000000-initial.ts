import { MigrationInterface, QueryRunner } from 'typeorm';
export class Initial1780000000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await q.query(
      `CREATE TABLE projects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar NOT NULL, owner varchar NOT NULL, repository varchar NOT NULL, "defaultBranch" varchar NOT NULL, "localPath" varchar NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(), UNIQUE(owner,repository))`,
    );
    await q.query(
      `CREATE TABLE issues (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "githubIssueId" bigint NOT NULL UNIQUE, number integer NOT NULL, title varchar NOT NULL, body text NOT NULL, state varchar NOT NULL, repository varchar NOT NULL, url varchar NOT NULL, "projectId" uuid NOT NULL REFERENCES projects(id), "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now())`,
    );
    await q.query(
      `CREATE TABLE tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "issueId" uuid NOT NULL UNIQUE REFERENCES issues(id), type varchar NOT NULL DEFAULT 'CODE', status varchar NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','RUNNING','SUCCESS','FAILED','CANCELLED')), provider varchar NOT NULL DEFAULT 'codex', branch varchar NOT NULL, workspace varchar NOT NULL, instructions text NOT NULL, result jsonb, error text, attempts integer NOT NULL DEFAULT 0, stage varchar NOT NULL DEFAULT 'QUEUED', "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now())`,
    );
    await q.query(
      `CREATE TABLE agent_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "taskId" uuid NOT NULL REFERENCES tasks(id), agent varchar NOT NULL, provider varchar NOT NULL, status varchar NOT NULL, command text NOT NULL, stdout text NOT NULL DEFAULT '', stderr text NOT NULL DEFAULT '', "exitCode" integer, "startedAt" timestamptz NOT NULL, "finishedAt" timestamptz)`,
    );
    await q.query(
      `CREATE TABLE pull_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "taskId" uuid NOT NULL UNIQUE REFERENCES tasks(id), "githubPrId" bigint NOT NULL UNIQUE, number integer NOT NULL, title varchar NOT NULL, url varchar NOT NULL, branch varchar NOT NULL, "baseBranch" varchar NOT NULL, state varchar NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now())`,
    );
    await q.query(
      `CREATE TABLE outbox (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "taskId" uuid NOT NULL REFERENCES tasks(id), "availableAt" timestamptz NOT NULL DEFAULT now(), "publishedAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now())`,
    );
    await q.query(
      `CREATE INDEX outbox_pending ON outbox ("availableAt") WHERE "publishedAt" IS NULL`,
    );
    await q.query(`CREATE INDEX agent_runs_task ON agent_runs ("taskId")`);
  }
  async down(q: QueryRunner): Promise<void> {
    for (const table of ['outbox', 'pull_requests', 'agent_runs', 'tasks', 'issues', 'projects'])
      await q.query(`DROP TABLE ${table}`);
  }
}
