/** A company whose code lives in a Coder workspace (Initech-like), for configuration tests. */
export const CODER_PROJECT = `        workspace:
          type: coder
          url: https://coder.example.com
          name: dev-ws
          root: /root/ai-dev-team
          reference: /workspaces/shop-orders
        delivery: rehearsal`;
export const coderTenantYaml = (project = CODER_PROJECT, extra = '') => `
tenants:
  - id: initech
    name: Initech
    git: { authorName: AI, authorEmail: ai@example.com }
    ai:
      providers: [claude]
      credentials: [{ id: corp, provider: claude }]
${extra}
    hosts:
      - id: gl
        type: gitlab
        baseUrl: https://git.example.com
        sshUrl: ssh://git.example.com:2244
        token: glpat-123456
    projects:
      - id: svc
        host: gl
        repository: shop/shop-orders
        defaultBranch: homolog
        branch: '{key}-{slug}'
        test: [make, test]
${project}`;
