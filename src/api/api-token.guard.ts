import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Request } from 'express';
import { config } from '../config';
import { readCookie, SESSION_COOKIE, WebAuthService, webEnabled } from '../web/web-auth.service';
const digest = (value: string) => createHash('sha256').update(value).digest();
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Where front actions may come from: its public URL, or the machine itself. */
export function allowedOrigins() {
  const c = config();
  const local = [`http://localhost:${c.PORT}`, `http://127.0.0.1:${c.PORT}`];
  return c.WEB_PUBLIC_URL ? [new URL(c.WEB_PUBLIC_URL).origin, ...local] : local;
}
export type OperatorRequest = Request & { operatorVia?: 'api' | 'web' };
/**
 * Single operator, two ways in: the API token (VS Code / MCP) or a front session cookie.
 * Session actions must come from the front's own origin (CSRF), on top of SameSite=Strict.
 * Without API_TOKEN and without the front, the API does not exist.
 */
@Injectable()
export class OperatorGuard implements CanActivate {
  constructor(private readonly auth: WebAuthService) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<OperatorRequest>();
    const expected = config().API_TOKEN;
    if (!expected && !webEnabled()) throw new NotFoundException();
    const header = req.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    // Hashing first gives equal-length buffers, so the comparison is constant time.
    if (token && expected && timingSafeEqual(digest(token), digest(expected))) {
      req.operatorVia = 'api';
      return true;
    }
    const session = await this.auth.session(readCookie(req.get('cookie'), SESSION_COOKIE));
    if (!session) throw new UnauthorizedException('Invalid API token');
    if (!SAFE.has(req.method) && !allowedOrigins().includes(req.get('origin') ?? ''))
      throw new ForbiddenException('Origin not allowed');
    req.operatorVia = 'web';
    return true;
  }
}
