import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveFront } from '../src/web/static';
@Module({})
class Empty {}
let app: INestApplication, base: string, dir: string;
async function start(withBuild: boolean) {
  dir = await mkdtemp(join(tmpdir(), 'front-'));
  if (withBuild) {
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'index.html'), '<html>front</html>');
    await writeFile(join(dir, 'assets', 'app.js'), 'console.log(1)');
  }
  app = await NestFactory.create(Empty, { logger: false });
  serveFront(app, join(dir, withBuild ? '' : 'missing'));
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
}
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});
test('serves the build, falls back to index.html for app routes, with security headers', async () => {
  await start(true);
  const asset = await fetch(`${base}/app/assets/app.js`);
  expect(asset.status).toBe(200);
  expect(await asset.text()).toBe('console.log(1)');
  const route = await fetch(`${base}/app/decisoes/123`);
  expect(route.status).toBe(200);
  expect(await route.text()).toBe('<html>front</html>');
  expect(route.headers.get('content-security-policy')).toContain("default-src 'self'");
  expect(route.headers.get('x-frame-options')).toBe('DENY');
  expect(route.headers.get('referrer-policy')).toBe('same-origin');
  const root = await fetch(`${base}/`, { redirect: 'manual' });
  expect(root.status).toBe(302);
  expect(root.headers.get('location')).toBe('/app/');
});
test('without a build, says how to build it', async () => {
  await start(false);
  const r = await fetch(`${base}/app/`);
  expect(r.status).toBe(503);
  expect(await r.text()).toContain('npm run build:web');
});
