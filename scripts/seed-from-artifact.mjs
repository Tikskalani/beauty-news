// One-off: lift the 12-month record out of the old "Daily Beauty News" artifact into seed/history.json,
// so company dossiers keep their history on day one. Usage: node scripts/seed-from-artifact.mjs <artifact.html>
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(process.argv[2], 'utf8');
const grab = name => {
  const m = html.match(new RegExp(`const ${name} = (\\[[\\s\\S]*?\\n\\]);`));
  if (!m) throw new Error(`${name} not found`);
  return vm.runInNewContext(m[1], Object.create(null), { timeout: 1000 });   // plain array literal, empty context
};
const ts = d => Date.parse(`${d}T17:00:00Z`);                                  // noon Central: date-only records
const events = grab('HISTORY').map(e => ({ ...e, id: `seed-${e.date}-${e.url}`, ts: ts(e.date), sources: [{ src: e.src, url: e.url }] }));
const press = grab('MEDIA').filter(p => p.head !== 'Articles').map(p => ({ ...p, id: `seed-${p.url}`, ts: ts(p.date) }));
await mkdir(new URL('../seed/', import.meta.url), { recursive: true });
await writeFile(new URL('../seed/history.json', import.meta.url), JSON.stringify({ events, press }, null, 1));
console.log(`seeded ${events.length} events, ${press.length} press stories`);
