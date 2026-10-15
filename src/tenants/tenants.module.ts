import { Module } from '@nestjs/common';
import { TenantRegistry } from './tenant-registry.service';
@Module({ providers: [TenantRegistry], exports: [TenantRegistry] })
export class TenantsModule {}
