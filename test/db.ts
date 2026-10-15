import { newDb, DataType } from 'pg-mem';
import { randomUUID } from 'node:crypto';
import { entities } from '../src/database/entities';
export async function database() {
  const memory = newDb();
  memory.public.registerFunction({
    name: 'current_database',
    returns: DataType.text,
    implementation: () => 'test',
  });
  memory.public.registerFunction({
    name: 'version',
    returns: DataType.text,
    implementation: () => 'PostgreSQL 16',
  });
  memory.public.registerFunction({
    name: 'uuid_generate_v4',
    returns: DataType.uuid,
    implementation: randomUUID,
    impure: true,
  });
  memory.public.registerFunction({
    name: 'hashtext',
    args: [DataType.text],
    returns: DataType.integer,
    implementation: () => 1,
  });
  for (const name of [
    'pg_advisory_xact_lock',
    'pg_advisory_lock',
    'pg_advisory_unlock',
    'pg_try_advisory_xact_lock',
  ])
    memory.public.registerFunction({
      name,
      args: [DataType.integer],
      returns: DataType.bool,
      implementation: () => true,
    });
  memory.public.registerFunction({
    name: 'pg_try_advisory_lock',
    args: [DataType.integer],
    returns: DataType.bool,
    implementation: () => true,
  });
  const db = await memory.adapters.createTypeormDataSource({
    type: 'postgres',
    entities,
    synchronize: true,
  });
  await db.initialize();
  return db;
}
export const item = {
  source: 'github',
  externalId: '123',
  key: '#7',
  title: 'Add greeting',
  body: 'Add a hello function.',
  url: 'https://github.com/example/demo/issues/7',
  project: 'demo',
  closingRef: 'Closes #7',
};
export const event = {
  action: 'opened' as const,
  repository: {
    name: 'demo',
    full_name: 'example/demo',
    default_branch: 'main',
    owner: { login: 'example' },
  },
  issue: {
    id: 123,
    number: 7,
    title: 'Add greeting',
    body: 'Add a hello function.',
    state: 'open' as const,
    html_url: 'https://github.com/example/demo/issues/7',
    author_association: 'OWNER',
  },
};
