import { MigrationInterface, QueryRunner } from 'typeorm';
export class BoardEvents1780000000014 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE board_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenantId" varchar NOT NULL, source varchar NOT NULL, "cardId" integer NOT NULL, "workflowId" integer NOT NULL, "laneId" integer, "columnId" integer NOT NULL, "ownerId" integer, "previousColumnId" integer, "previousOwnerId" integer, title varchar(300) NOT NULL, at timestamptz NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now())`,
    );
    await q.query(
      `CREATE INDEX board_events_card ON board_events ("tenantId", source, "cardId", at)`,
    );
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE board_events`);
  }
}
