import { Injectable } from '@nestjs/common';
import { TaskError } from '../config';
import { CodeHost } from '../hosts/code-host';
import { GithubHost } from '../hosts/github.host';
import { BitbucketHost } from '../hosts/bitbucket.host';
import { GitlabHost } from '../hosts/gitlab.host';
import { findTenant, Tenant, TenantHost, TenantProject } from './tenants';
export interface ProjectContext {
  tenant: Tenant;
  project: TenantProject;
  host: CodeHost;
}
export function createHost(config: TenantHost): CodeHost {
  switch (config.type) {
    case 'github':
      return new GithubHost(config.id, config.token);
    case 'bitbucket':
      return new BitbucketHost(config.id, config);
    case 'gitlab':
      return new GitlabHost(config.id, config);
  }
}
@Injectable()
export class TenantRegistry {
  tenant(id: string): Tenant {
    const tenant = findTenant(id);
    if (!tenant) throw new TaskError(`Unknown tenant: ${id}`);
    return tenant;
  }
  project(tenantId: string, projectId: string): ProjectContext {
    const tenant = this.tenant(tenantId),
      project = tenant.projects.find((p) => p.id === projectId);
    if (!project) throw new TaskError(`Unknown project ${projectId} for tenant ${tenantId}`);
    // Schema validation guarantees the host exists.
    const host = tenant.hosts.find((h) => h.id === project.host)!;
    return { tenant, project, host: createHost(host) };
  }
}
