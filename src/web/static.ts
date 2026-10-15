import { INestApplication } from '@nestjs/common';
import express, { Response } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
const HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
};
/** The front's build (web/dist) at /app; app routes fall back to index.html (SPA). */
export function serveFront(app: INestApplication, dir = resolve('web/dist')) {
  const server = app.getHttpAdapter().getInstance() as express.Express;
  const index = resolve(dir, 'index.html');
  const secure = (res: Response) => res.set(HEADERS);
  server.get('/', (_req, res) => res.redirect(302, '/app/'));
  server.use('/app', (_req, res, next) => {
    secure(res);
    next();
  });
  server.use('/app', express.static(dir, { index: false, fallthrough: true, maxAge: '1h' }));
  server.get(/^\/app(\/.*)?$/, (_req, res) => {
    if (!existsSync(index))
      return res
        .status(503)
        .type('text/plain')
        .send('Front não compilado: rode "npm run build:web" no ai-dev-team.');
    res.set('Cache-Control', 'no-cache').sendFile(index);
  });
}
