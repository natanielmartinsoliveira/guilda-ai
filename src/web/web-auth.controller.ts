import { authText } from './auth-text';
import { language } from '../i18n';
import { Body, Controller, Get, HttpCode, HttpException, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { z } from 'zod';
import {
  clientIp,
  readCookie,
  SESSION_COOKIE,
  WebAuthError,
  WebAuthService,
} from './web-auth.service';
const loginBody = z.object({ password: z.string().min(1).max(200) });
const verifyBody = z.object({ loginId: z.string().max(64), code: z.string().regex(/^\d{6}$/) });
const cookie = (value: string, maxAgeSeconds: number) =>
  `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
/** Front login: password, then the code sent over Telegram; the session lives in a cookie. */
@Controller('web-api')
export class WebAuthController {
  constructor(private readonly auth: WebAuthService) {}
  private async run<T>(work: () => Promise<T>) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof WebAuthError) throw new HttpException(error.message, error.status);
      throw error;
    }
  }
  @Post('login')
  @HttpCode(200)
  login(@Body() body: unknown, @Req() req: Request) {
    const parsed = loginBody.safeParse(body);
    if (!parsed.success) throw new HttpException(authText('needPassword'), 400);
    return this.run(() => this.auth.startLogin(parsed.data.password, clientIp(req)));
  }
  @Post('verify')
  @HttpCode(200)
  async verify(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const parsed = verifyBody.safeParse(body);
    if (!parsed.success) throw new HttpException(authText('needCode'), 400);
    const { token, expiresAt } = await this.run(() =>
      this.auth.verify(
        parsed.data.loginId,
        parsed.data.code,
        clientIp(req),
        req.get('user-agent') ?? '',
      ),
    );
    res.setHeader(
      'Set-Cookie',
      cookie(token, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
    );
    return { ok: true };
  }
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(readCookie(req.get('cookie'), SESSION_COOKIE));
    res.setHeader('Set-Cookie', cookie('', 0));
    return { ok: true };
  }
  @Get('me')
  async me(@Req() req: Request) {
    const session = await this.auth.session(readCookie(req.get('cookie'), SESSION_COOKIE));
    // The language comes before login too: the login screen itself is translated.
    return { authenticated: !!session, language: language() };
  }
}
