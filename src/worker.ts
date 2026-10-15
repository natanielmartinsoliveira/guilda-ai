import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { config, log } from './config';
import { tenants } from './tenants/tenants';
async function main() {
  if (process.platform !== 'linux' || process.getuid?.() === 0)
    throw new Error('Worker requires Linux and non-root user');
  config();
  const loaded = tenants();
  log('worker.tenants', { tenants: loaded.map((t) => t.id) });
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['error', 'warn'],
  });
  app.enableShutdownHooks();
  log('worker.ready');
}
void main().catch((error) => {
  log('worker.start_failed', { error: error.message });
  process.exitCode = 1;
});
