import { loadTenants } from '../src/tenants/tenants';
import { coderTenantYaml as yaml } from './fixtures/coder-tenant';
test('office.theme defaults to guild for old company files', () => {
  expect(loadTenants(yaml(''))[0].office).toEqual({ theme: 'guild' });
});
test.each(['guild', 'studio', 'pipeline'])('office.theme accepts %s', (theme) => {
  expect(loadTenants(yaml('', `    office: { theme: ${theme} }`))[0].office.theme).toBe(theme);
});
test('invalid office.theme identifies the configuration path', () => {
  expect(() => loadTenants(yaml('', '    office: { theme: nope }'))).toThrow(/office.theme/);
});
