// npm run design:check -- <tenant> "<figma link>" ["<front text>"]: downloads a design the way a
// front phase would, into a temporary folder, without any AI or task. The token never shows.
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTenant } from '../tenants/tenants';
import { NeedsInput } from '../tasks/decisions';
import { DesignService } from './design.service';
async function main() {
  const [tenantId, link, about = ''] = process.argv.slice(2);
  const tenant = tenantId ? findTenant(tenantId) : undefined;
  if (!tenant || !link) {
    console.error(
      'Uso: npm run design:check -- <empresa> "<link do Figma>" ["<texto da parte de front>"]',
    );
    process.exit(2);
  }
  const dir = await mkdtemp(join(tmpdir(), 'design-check-'));
  try {
    const out = await new DesignService().prepare({
      tenant,
      texts: [link],
      about,
      clarifications: [],
      images: 0,
      dir,
    });
    console.log(`Origem: ${out.source}`);
    console.log(`Pasta: ${dir}/figma`);
    console.log(`Anexados para o Codex: ${out.files.map((f) => f.name).join(', ')}`);
    console.log('\n--- index.md (início) ---');
    const index = await readFile(join(dir, 'figma', 'index.md'), 'utf8');
    console.log(index.split('\n').slice(0, 40).join('\n'));
  } catch (error) {
    if (error instanceof NeedsInput) {
      console.log('A fase de front pararia e perguntaria ao operador:');
      for (const q of error.questions)
        console.log(`- ${q.text}${q.options ? ` [${q.options.join(' | ')}]` : ''}`);
      return;
    }
    throw error;
  }
}
void main();
