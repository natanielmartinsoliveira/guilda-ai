import { DataSource, MoreThan } from 'typeorm';
import { databaseOptions } from '../../database/data-source';
import { BoardEvent } from '../../database/entities';
import { tenants } from '../../tenants/tenants';
import { BusinessmapClient } from './businessmap.client';
import { summarize } from './journal';
/** npm run board:journal -- <tenant> <source> [hours, default 24] */
async function main() {
  const [tenantId, sourceId, hoursArg] = process.argv.slice(2);
  const source = tenants()
    .find((t) => t.id === tenantId)
    ?.sources.find((s) => s.id === sourceId);
  if (!source || source.type !== 'businessmap') {
    console.error('usage: npm run board:journal -- <tenant> <businessmap source> [hours]');
    process.exit(2);
  }
  const hours = Number(hoursArg ?? 24);
  const db = await new DataSource(databaseOptions()).initialize();
  try {
    const events = await db.getRepository(BoardEvent).find({
      where: { tenantId, source: sourceId, at: MoreThan(new Date(Date.now() - hours * 3600000)) },
      order: { at: 'ASC' },
    });
    const s = summarize(events, await new BusinessmapClient(source).columnNames());
    console.log(`Últimas ${hours} h: ${s.moves} movimentos de ${s.cards} cards\n`);
    for (const [move, n] of s.transitions) console.log(`  ${String(n).padStart(4)}  ${move}`);
    if (s.hoursIn.length) console.log('\nTempo numa coluna (mediana, horas):');
    for (const h of s.hoursIn)
      console.log(`  ${h.median.toFixed(1).padStart(6)} h  ${h.column} (${h.samples})`);
  } finally {
    await db.destroy();
  }
}
void main();
