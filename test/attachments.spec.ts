import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachmentsDir, safeName, saveAttachments } from '../src/attachments/attachments';
import { contentType, toLocalPath } from '../src/mcp/paths';
test('file names cannot escape, hide or collide', () => {
  const taken = new Set<string>();
  expect(safeName('../../etc/passwd', taken)).toBe('passwd');
  expect(safeName('C:\\Users\\me\\print tela.png', taken)).toBe('print_tela.png');
  expect(safeName('.env', taken)).toBe('env');
  expect(safeName('PASSWD', taken)).toBe('1-PASSWD');
  expect(safeName('...', taken)).toBe('file');
});
test('attachment paths only accept safe segments', () => {
  expect(() => attachmentsDir('acme', 'api', '../globex')).toThrow('Invalid attachment path');
  expect(() => attachmentsDir('../x', 'api', 'id')).toThrow('Invalid attachment path');
  expect(attachmentsDir('acme', 'jira', '10023')).toBe(
    `${process.env.ATTACHMENTS_ROOT}/acme/jira/10023`,
  );
});
test('saves files without overwriting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'att-'));
  try {
    const saved = await saveAttachments(dir, [
      { originalname: 'a.txt', mimetype: '', buffer: Buffer.from('1') },
      { originalname: 'a.txt', mimetype: 'text/plain', buffer: Buffer.from('22') },
    ]);
    expect(saved).toEqual([
      { name: 'a.txt', contentType: 'application/octet-stream', size: 1 },
      { name: '1-a.txt', contentType: 'text/plain', size: 2 },
    ]);
    expect((await readdir(dir)).sort()).toEqual(['1-a.txt', 'a.txt']);
    await expect(
      saveAttachments(dir, [{ originalname: 'a.txt', mimetype: '', buffer: Buffer.from('x') }]),
    ).rejects.toThrow('EEXIST');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('MCP converts editor paths from Windows into WSL paths', () => {
  expect(toLocalPath('\\\\wsl.localhost\\Ubuntu-24.04\\home\\pat\\a.png')).toBe('/home/pat/a.png');
  expect(toLocalPath('//wsl$/Ubuntu/tmp/x.log')).toBe('/tmp/x.log');
  expect(toLocalPath('C:\\Users\\pat\\Desktop\\spec.pdf')).toBe(
    '/mnt/c/Users/pat/Desktop/spec.pdf',
  );
  expect(toLocalPath('/home/a')).toBe('/home/a');
  expect(() => toLocalPath('relative/file.txt')).toThrow('absolute path');
  expect(contentType('/x/Print.PNG')).toBe('image/png');
  expect(contentType('/x/data.bin')).toBe('application/octet-stream');
});
