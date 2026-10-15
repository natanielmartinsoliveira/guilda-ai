import { MigrationInterface, QueryRunner } from 'typeorm';
export class CredentialStates1780000000003 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE ai_credential_states ("tenantId" varchar NOT NULL, "credentialId" varchar NOT NULL, "unavailableUntil" timestamptz NOT NULL, reason varchar NOT NULL, "lastError" text NOT NULL DEFAULT '', "updatedAt" timestamptz NOT NULL DEFAULT now(), PRIMARY KEY ("tenantId", "credentialId"))`,
    );
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE ai_credential_states`);
  }
}
