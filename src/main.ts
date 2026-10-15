import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { config, log } from './config';
import { tenants } from './tenants/tenants';
import { serveFront } from './web/static';
async function main() {
  // Fail fast on an invalid tenants.yaml instead of on the first webhook.
  const loaded = tenants();
  log('api.tenants', { tenants: loaded.map((t) => t.id) });
  const app = await NestFactory.create(AppModule, { rawBody: true, logger: ['error', 'warn'] });
  app.enableShutdownHooks();
  serveFront(app);
  await app.listen(config().PORT);
  log('api.listening', { port: config().PORT });
}
void main().catch((error) => {
  log('api.start_failed', { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
