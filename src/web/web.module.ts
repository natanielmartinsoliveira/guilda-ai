import { Module } from '@nestjs/common';
import { WebAuthController } from './web-auth.controller';
import { WebAuthService } from './web-auth.service';
@Module({
  controllers: [WebAuthController],
  providers: [WebAuthService],
  exports: [WebAuthService],
})
export class WebModule {}
