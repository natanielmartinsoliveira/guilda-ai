import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import { config } from '../config';
import { entities } from './entities';
import { Initial1780000000000 } from './migrations/1780000000000-initial';
import { MultiTenant1780000000001 } from './migrations/1780000000001-multi-tenant';
import { Attachments1780000000002 } from './migrations/1780000000002-attachments';
import { CredentialStates1780000000003 } from './migrations/1780000000003-credential-states';
import { Revisions1780000000004 } from './migrations/1780000000004-revisions';
import { SubtaskSteps1780000000005 } from './migrations/1780000000005-subtask-steps';
import { Decisions1780000000006 } from './migrations/1780000000006-decisions';
import { Notifications1780000000007 } from './migrations/1780000000007-notifications';
import { WebAuth1780000000008 } from './migrations/1780000000008-web-auth';
import { SessionPassword1780000000009 } from './migrations/1780000000009-session-password';
export function databaseOptions(): DataSourceOptions {
  const c = config();
  return {
    type: 'postgres',
    host: c.DATABASE_HOST,
    port: c.DATABASE_PORT,
    database: c.DATABASE_NAME,
    username: c.DATABASE_USER,
    password: c.DATABASE_PASSWORD,
    entities,
    migrations: [
      Initial1780000000000,
      MultiTenant1780000000001,
      Attachments1780000000002,
      CredentialStates1780000000003,
      Revisions1780000000004,
      SubtaskSteps1780000000005,
      Decisions1780000000006,
      Notifications1780000000007,
      WebAuth1780000000008,
      SessionPassword1780000000009,
    ],
    synchronize: false,
  };
}
export default new DataSource(databaseOptions());
