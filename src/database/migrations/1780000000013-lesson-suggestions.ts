import { MigrationInterface, QueryRunner } from 'typeorm';
export class LessonSuggestions1780000000013 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE lesson_suggestions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenantId" varchar NOT NULL, "projectKey" varchar NOT NULL, signature varchar NOT NULL, problem text NOT NULL, answer text, count integer NOT NULL DEFAULT 1, "taskIds" jsonb NOT NULL DEFAULT '[]', status varchar NOT NULL DEFAULT 'open', "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now())`,
    );
    await q.query(
      `CREATE UNIQUE INDEX lesson_suggestions_signature ON lesson_suggestions ("tenantId", "projectKey", signature)`,
    );
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE lesson_suggestions`);
  }
}
