import { loadTenants, tenants, useTenants } from '../src/tenants/tenants';
import { TenantRegistry } from '../src/tenants/tenant-registry.service';
import { coderTenantYaml as yaml } from './fixtures/coder-tenant';
test('worker.concurrency defaults to 1', () => {
  const [t] = loadTenants(yaml(''));
  expect(t.worker).toEqual({ concurrency: 1 });
});
test('worker.concurrency is read from the company', () => {
  const [t] = loadTenants(yaml('', '    worker: { concurrency: 3 }'));
  expect(t.worker.concurrency).toBe(3);
});
test.each([0, 9, 1.5])('worker.concurrency %p is refused', (n) => {
  expect(() => loadTenants(yaml('', `    worker: { concurrency: ${n} }`))).toThrow(/concurrency/);
});
test('the registry lists every company', () => {
  const previous = tenants();
  try {
    const list = loadTenants(yaml(''));
    useTenants(list);
    expect(new TenantRegistry().all().map((t) => t.id)).toEqual(list.map((t) => t.id));
  } finally {
    useTenants(previous);
  }
});
