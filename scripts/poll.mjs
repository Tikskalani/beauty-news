#!/usr/bin/env node
// Beauty News poller. One run: fetch every feed -> classify -> merge into the record ->
// push new deal events to the phone via ntfy. No dependencies; Node 20+.
//
// Env:
//   DATA_DIR       where feed.json / state.json live (default ./data)
//   NTFY_TOPIC     ntfy topic to publish to; unset = dry run (prints what it would send)
//   NTFY_SERVER    default https://ntfy.sh
//   SITE_URL       dashboard URL, attached to each push as a "Dashboard" button
//   NOTIFY_PRESS   "1" also pushes non-deal trade-press stories (low priority, digested)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const NTFY_SERVER = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
const NTFY_TOPIC = (process.env.NTFY_TOPIC || '').trim();
const SITE_URL = process.env.SITE_URL || '';
const NOTIFY_PRESS = process.env.NOTIFY_PRESS === '1';
const TZ = 'America/Chicago';

const EVENT_DAYS = 365;        // dossier history
const PRESS_DAYS = 45;         // trade-press history
const SEEN_DAYS = 10;          // dedupe memory for raw items
const NOTIFY_MAX_AGE_H = 12;   // never push a story older than this, however late we first see it
const DIGEST_AT = 5;           // more new events than this in one run -> one digest push
const FETCH_TIMEOUT_MS = 20000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36';

const CATS = { mna: 'M&A', fund: 'Funding', part: 'Partnership', earn: 'Earnings' };
const DAY = 864e5;

// ─── text helpers ────────────────────────────────────────────────────────────
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  hellip: '…', ndash: '–', mdash: '—', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', ocirc: 'ô', uuml: 'ü', ouml: 'ö', auml: 'ä', reg: '®', trade: '™', copy: '©' };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e.toLowerCase()] ?? m));
const stripTags = s => s.replace(/<[^>]*>/g, ' ');
const clean = s => decode(stripTags(decode(s || ''))).replace(/\s+/g, ' ').trim();
// Accent-free, straight-quoted, lower-case: the form every regex below is written against.
const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’‘`´]/g, "'").replace(/[“”]/g, '"').toLowerCase();
const sha = s => createHash('sha1').update(s).digest('hex').slice(0, 16);
const ymd = t => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
const shortDay = t => new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric' }).format(t);
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ─── feed parsing (RSS 2.0, RSS 1.0/RDF, Atom) ───────────────────────────────
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  if (!m) return '';
  return m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
}
function parseFeed(xml) {
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  return blocks.map(b => {
    let link = clean(tag(b, 'link'));
    if (!link) { const h = b.match(/<link\b[^>]*href="([^"]+)"/i); if (h) link = decode(h[1]); }
    if (!link) link = clean(tag(b, 'guid'));
    const when = clean(tag(b, 'pubDate') || tag(b, 'dc:date') || tag(b, 'published') || tag(b, 'updated'));
    const srcTag = b.match(/<source\b[^>]*>([\s\S]*?)<\/source>/i);
    return {
      title: clean(tag(b, 'title')),
      link: link.trim(),
      desc: clean(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content')),
      ts: Date.parse(when.replace(/ UTC$/, ' GMT')),
      source: srcTag ? clean(srcTag[1]) : '',
    };
  }).filter(i => i.title && i.link);
}
async function fetchText(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const head = buf.subarray(0, 200).toString('latin1');
    const cs = (res.headers.get('content-type') || '').match(/charset=([\w-]+)/i)?.[1] || head.match(/encoding="([\w-]+)"/i)?.[1] || 'utf-8';
    try { return new TextDecoder(cs.toLowerCase()).decode(buf); } catch { return buf.toString('utf8'); }
  } finally { clearTimeout(timer); }
}

// ─── config ──────────────────────────────────────────────────────────────────
const readJson = async (p, fallback) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; } };
const SOURCES = await readJson(path.join(ROOT, 'config/sources.json'));
const WATCH = (await readJson(path.join(ROOT, 'config/watchlist.json'))).houses.map(h => ({
  ...h, re: new RegExp(`(?<![\\w&])(?:${h.match.join('|')})(?![\\w&])`, 'i'),
}));

function buildSources() {
  const gn = q => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  const list = SOURCES.feeds.map(f => ({ ...f }));
  for (const g of SOURCES.googleNews) list.push({ ...g, url: gn(g.q), google: true });
  const { terms, groupSize } = SOURCES.watchlistQuery;
  for (let i = 0; i < WATCH.length; i += groupSize) {
    const names = WATCH.slice(i, i + groupSize).map(h => h.q.includes('"') || h.q.includes(' OR ') ? `(${h.q})` : h.q);
    list.push({ id: `gn-watch-${i / groupSize + 1}`, name: null, url: gn(`(${names.join(' OR ')}) ${terms}`), google: true, beauty: false, press: false, watch: true });
  }
  return list;
}

// ─── classification ──────────────────────────────────────────────────────────
const RE = {
  beauty: /\b(beauty|cosmetic|cosmetics|skin ?care|skincare|make-?up|fragrance|perfume|parfum|haircare|hair care|personal care|salon|nail|lipstick|mascara|serum|sunscreen|derma|dermatolog|toiletr|deodorant|grooming|shampoo|spa)\b/,
  noise: /(\d+% off|\bbest\b.*\b(buy|of 20\d\d|for)\b|\bprime day\b|black friday|cyber monday|\bcoupon|promo code|\bon sale\b|deal alert|\bshop the\b|\bgift guide\b|\breview:|\bhoroscope|\btested\b|\bwe tried\b|\bdupe\b)/,
  // Headlines that carry deal words but are not deals: stock chatter, insider sales, results-date
  // notices, litigation, executive moves.
  notDeal: /(\bstock (?:holds|steadies|gains|slips|rises|falls|climbs|drops|jumps|rallies|sinks|surges|tumbles)|\bshares? (?:rise|fall|jump|slip|climb|drop|gain)|\bsells? [\d,.]+ (?:k |m )?shares|\binsider\b|price target|stock forecast|should you buy|\b(?:buy|sell|hold) rating|\bdividend|\bto (?:issue|report|announce|release|host|review|discuss|present)\b.*\b(?:results|earnings|call)\b|conference call|\bwebcast|\blawsuit|\bsues?\b|\bsued\b|\bcourt\b|\bdismissal|\bverdict|\bclass action)/,
  exec: /\b(appoints?|names?|named|hires?|promot\w+|steps? down|resigns?|retires?|successor|new ceo|as ceo|chief \w+ officer)\b/,
  mna: /\b(acquir\w*|acquisition|takeover|merger|merges?|merging|buys|bought|to buy|divest\w*|sells?|sold|sale of|spin-?off|carve-?out|majority stake|minority stake|controlling stake|stake in|takes? stake|buyout|exits?\b.*\bjoint venture|bid for|offer for|tender offer)\b/,
  fund: /\b(raises?|raised|raising|funding|series [a-f]\b|seed round|pre-seed|investment from|invests?|invested|investor|backs|backed by|ipo|initial public offering|files? (?:for|to) (?:an )?(?:ipo|list)|listing|goes public|private placement|capital raise|financing|valuation|venture)\b/,
  earn: /\b(earnings|results|quarter|q[1-4]\b|first[- ]half|second[- ]half|h[12]\b|fy ?20\d\d|fiscal|full[- ]year|guidance|outlook|forecast|net sales|revenue|revenues|net income|profit|operating income|like-for-like|organic (?:sales|growth))\b/,
  part: /\b(partnership|partners? with|partnering|licen[cs]e|licensing|joint venture|distribution (?:deal|agreement)|collaborat\w+|teams? up|strategic alliance|exclusive rights|franchise agreement)\b/,
};
const SECTORS = [
  ['Skincare', /\b(skin ?care|skincare|serum|derma\w*|sunscreen|spf|moistur\w*|anti-?aging|acne|retinol|facial)\b/g],
  ['Color Cosmetics', /\b(make-?up|color cosmetics|colour cosmetics|lip\w*|mascara|foundation|eyeshadow|eyeliner|blush|concealer|nail\w*|brow)\b/g],
  ['Haircare', /\b(hair\w*|scalp|shampoo|conditioner|salon|barber|styling)\b/g],
  ['Fragrance', /\b(fragrance\w*|perfum\w*|parfum\w*|scent\w*|eau de|cologne|niche perfumery)\b/g],
  ['Body Care', /\b(body care|body wash|bodycare|deodorant|bath|shower|razor|shav\w*|oral care|toothpaste|period care|feminine|intimate care|soap|lotion)\b/g],
];
const GEOS = [
  ['North America', /\b(u\.?s\.?|usa|united states|america|american|canada|canadian|mexico|new york|california|texas|nyse|nasdaq)\b/g],
  ['Europe', /\b(europe\w*|eu|uk|u\.k\.|britain|british|england|london|france|french|paris|germany|german|italy|italian|milan|spain|spanish|switzerland|swiss|netherlands|dutch|sweden|swedish|nordic|poland|euronext|ireland)\b/g],
  ['Asia-Pacific', /\b(asia\w*|china|chinese|shanghai|hong kong|japan\w*|tokyo|korea\w*|k-beauty|seoul|india\w*|mumbai|singapore|australia\w*|sydney|indonesia\w*|thailand|vietnam\w*|philippines|malaysia\w*|taiwan\w*|new zealand|j-beauty|c-beauty|apac)\b/g],
  ['Latin America', /\b(latin america\w*|latam|brazil\w*|sao paulo|argentin\w*|chile\w*|colombia\w*|peru\w*|uruguay\w*)\b/g],
  ['Middle East & Africa', /\b(middle east|gulf|gcc|saudi|uae|dubai|abu dhabi|qatar|kuwait|israel\w*|egypt\w*|africa\w*|nigeria\w*|kenya\w*|morocc\w*|turkey|turkish)\b/g],
];
const FX = { '$': 1, 'us$': 1, 'usd': 1, '€': 1.1, 'eur': 1.1, '£': 1.3, 'gbp': 1.3, '¥': 0.0068, 'jpy': 0.0068, 'yen': 0.0068,
  '₹': 0.012, 'rs': 0.012, 'inr': 0.012, 'rmb': 0.14, 'cny': 0.14, 'yuan': 0.14, 'a$': 0.66, 'aud': 0.66, 'c$': 0.73, 'cad': 0.73,
  'hk$': 0.128, 'hkd': 0.128, '₩': 0.00073, 'krw': 0.00073, 'won': 0.00073, 'chf': 1.2, 'r$': 0.18, 'brl': 0.18,
  'egp': 0.02, 'sar': 0.27, 'aed': 0.27, 's$': 0.78, 'sgd': 0.78, 'thb': 0.03, 'php': 0.018, 'zar': 0.056, 'mxn': 0.055,
  'try': 0.03, 'sek': 0.1, 'dkk': 0.15, 'nok': 0.1, 'twd': 0.033, 'nt$': 0.033, 'idr': 0.00006, 'vnd': 0.00004 };

function valueIn(text) {
  const re = /(us\$|a\$|c\$|hk\$|nt\$|s\$|r\$|\$|€|£|¥|₹|₩|rmb|usd|eur|gbp|inr|cny|jpy|chf|egp|sar|aed|sgd|thb|php|zar|mxn|try|sek|dkk|nok|twd|idr|vnd|krw|rs\.?)\s?(\d{1,3}(?:[.,]\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(billion|bn|million|mln|mn|crore|lakh|b|m)?\b/gi;
  let best = null;
  for (const m of text.matchAll(re)) {
    const cur = m[1].toLowerCase().replace(/\.$/, '');
    const unit = (m[3] || '').toLowerCase();
    const num = parseFloat(unit ? m[2].replace(/,(?=\d{3}\b)/g, '') : m[2].replace(/[.,](?=\d{3}\b)/g, ''));
    if (!Number.isFinite(num)) continue;
    // Bare "$25" is a price; bare "$160,000" is a seed round.
    const abs = unit === 'crore' ? num * 1e7 : unit === 'lakh' ? num * 1e5 : unit.startsWith('b') ? num * 1e9 : unit.startsWith('m') ? num * 1e6 : num >= 1e4 ? num : null;
    if (abs == null) continue;
    const usdB = abs * (FX[cur] ?? 1) / 1e9;
    if (!best || usdB > best.usdB) best = { text: m[0].replace(/\s+/g, ' ').trim(), usdB };
  }
  return best;
}
// The headline's figure is the deal; the summary's figures are often context (prior rounds, market size).
const extractValue = (title, desc = '') => valueIn(title) || valueIn(desc);
function tally(pairs, title, body) {
  let top = null, topN = 0, tie = false;
  for (const [label, re] of pairs) {
    const n = 3 * (title.match(re) || []).length + (body.match(re) || []).length;
    if (n > topN) { top = label; topN = n; tie = false; } else if (n && n === topN) tie = true;
  }
  return { top, tie };
}
// "Haircare Brand Arey" -> "Arey"; "Beauty-tech startup Makemake" -> "Makemake".
function trimDescriptor(s) {
  const m = s.match(/^.*\b(?:brand|startup|start-up|label|maker|company|firm|retailer|platform|house|group|chain|giant|player|specialist)\s+/i);
  return (m && /^[A-Z0-9]/.test(s.slice(m[0].length)) ? s.slice(m[0].length) : s).trim();
}
// A regulator or court "clears" a deal; it is never the company the deal belongs to.
const REGULATOR = /\b(cci|watchdog|regulators?|commission|authority|antitrust|competition|accc|cma|ftc|sec|court|government|ministry|tribunal|judge|shareholders|investors|analysts)\b/i;
function subjectOf(title) {
  const t = title.replace(/^(exclusive|breaking|update|report|watch|analysis|opinion)\s*[:|-]\s*/i, '');
  const passive = t.match(/^(.{2,60}?)\s+(?:is\s+|to be\s+|gets?\s+)?(?:acquired|bought|backed|snapped up)\s+by\s+(.{2,50}?)(?=\s+(?:to|in|for|as|from|after|amid|at)\b|[,:;(]|$)/i);
  if (passive) return { co: trimDescriptor(passive[2]), other: trimDescriptor(passive[1]) };
  // Investor-first: "Unilever Ventures Backs Arey's ..." -> the company is Arey.
  const backer = t.match(/^(.{2,60}?)\s+(?:backs|invests in|leads [\w$€£.\s-]*?(?:round|raise|investment) (?:in|for)|co-leads)\s+(.{2,50}?)(?=[’']s\b|\s+(?:with|in|to|for|as|at|on|amid)\b|[,:;(]|$)/i);
  if (backer && !REGULATOR.test(backer[1])) return { co: trimDescriptor(backer[2]), other: trimDescriptor(backer[1]) };
  const m = t.match(/^(.{2,60}?)\s+(?:has\s+|is\s+|will\s+)?(?:acquires?|to acquire|agrees?|buys?|to buy|raises?|raised|secures?|lands?|closes?|completes?|files?|announces?|reports?|posts?|invests?|backs?|sells?|to sell|exits?|signs?|inks?|partners?|teams?|launches?|enters?|expands?|takes?|snaps? up|beats?|misses?|lifts?|cuts?|swings?|returns?|plans?|eyes|nears?|in talks|clears?|wins?|debuts?|unveils?|merges?|divests?|offloads?)\b/i);
  const s = m ? trimDescriptor(m[1].replace(/[’']s$/, '')) : '';
  return s && s.split(' ').length <= 5 && /^[A-Z0-9"'‘“]/.test(s) && !REGULATOR.test(s) ? { co: s } : null;
}

function classify(item, src) {
  const title = src.google && item.source ? item.title.replace(new RegExp(`\\s+[-–—|]\\s+${escRe(item.source)}$`), '') : item.title;
  const desc = item.desc.replace(/\s*The post .* appeared first on .*$/i, '').replace(/\s*(Continue reading|Read more)\W*$/i, '');
  const sum = src.google ? '' : (desc.length > 320 ? desc.slice(0, 317).replace(/\s+\S*$/, '') + '…' : desc);
  const ft = fold(title), fb = fold(`${title} ${desc}`);
  const houses = WATCH.filter(h => h.re.test(ft)).map(h => h.name);
  const bodyHouses = WATCH.filter(h => !houses.includes(h.name) && h.re.test(fb)).map(h => h.name);
  // Wires and general outlets: a tracked house or a beauty word must be in the headline itself.
  const relevant = src.beauty || houses.length > 0 || RE.beauty.test(ft);
  const noise = RE.noise.test(ft);

  // Category comes from the headline only: summaries mention past deals and context too often.
  let cat = RE.mna.test(ft) ? 'mna' : RE.fund.test(ft) ? 'fund' : RE.earn.test(ft) ? 'earn' : RE.part.test(ft) ? 'part' : null;
  if (cat && (RE.notDeal.test(ft) || (RE.exec.test(ft) && !/\b(acquir|merger|stake|raises|funding|ipo)/.test(ft)))) cat = null;
  // "Invests in" a product line, "revenue" in a trend piece: require a money word, a figure, or a named house.
  if (cat && !houses.length && !valueIn(title) && !/\b(acquir|merger|ipo|series [a-f]|seed|stake|raises|funding|results|earnings|licen|buys|sells|divest)/.test(ft)) cat = null;

  const outlet = src.name || (item.source || 'News').split(/\s+[-–|:]\s+/)[0];
  const subj = subjectOf(title);
  const subjHouse = subj && WATCH.find(h => h.re.test(fold(subj.co)));
  const co = subjHouse?.name || subj?.co || houses[0] || bodyHouses[0] || title.match(/^([A-Z][\w&'’.-]*(?:\s+[A-Z][\w&'’.-]*){0,2})/)?.[1] || outlet;
  const also = [...new Set([subj?.other, ...houses, ...bodyHouses].filter(h => h && h !== co))].slice(0, 4);
  const value = cat === 'mna' || cat === 'fund' ? extractValue(title, desc) : (cat === 'earn' ? valueIn(title) : null);
  const sec = tally(SECTORS, ft, fb); const geo = tally(GEOS, ft, fb);
  const hi = !!cat && ((['mna', 'fund'].includes(cat) && houses.length > 0) || (value && value.usdB >= 1 && cat !== 'earn'));
  return {
    relevant: relevant && !noise, cat, title, sum, outlet, co, also, hi,
    value: value ? value.text : '—', val: value && cat !== 'earn' ? +value.usdB.toFixed(4) : 0,
    sec: sec.top && !sec.tie ? sec.top : 'Multi-category',
    geo: geo.top && !geo.tie ? geo.top : 'Global',
    rumor: /\b(report(?:ed|edly)?|rumou?r|in talks|considers?|weighs?|explor\w+|sources say|could|may)\b/.test(ft),
  };
}

// ─── clustering: one deal reported by many outlets = one event ───────────────
const STOP = new Set('a an the of to in on for and or with by at from as its it is are be has have after amid over into new its us inc co ltd group holdings beauty'.split(' '));
const stem = w => w.length > 4 ? w.replace(/(?:ing|ed|es|s)$/, '') : w;
const tokens = s => new Set(fold(s).replace(/[^a-z0-9$€£ ]+/g, ' ').split(' ').filter(w => w.length > 2 && !STOP.has(w)).map(stem));
function similar(a, b) {
  let inter = 0; for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter || 1);
}
const HOUSE_NAMES = new Set(WATCH.map(h => h.name));
// Two entity names refer to the same company if equal or one contains the other as whole words
// ("Anti-Gray Arey" ~ "Arey").
const sameEntity = (a, b) => {
  const x = fold(a), y = fold(b);
  if (x.length < 3 || y.length < 3) return false;
  const inside = (s, t) => new RegExp(`(?:^|[^a-z0-9])${escRe(t)}(?:$|[^a-z0-9])`).test(s);
  return x === y || inside(x, y) || inside(y, x);
};
function findTwin(events, ev) {
  const tk = tokens(ev.head);
  const evHouses = [ev.co, ...(ev.also || [])].filter(n => HOUSE_NAMES.has(n)).sort().join('|');
  const evOthers = [ev.co, ...(ev.also || [])].filter(n => !HOUSE_NAMES.has(n));
  return events.find(e => {
    const dt = Math.abs(e.ts - ev.ts);
    if (dt >= 4 * DAY) return false;
    const sim = similar(tk, tokens(e.head));
    if (sim >= 0.5) return true;
    if (e.cat !== ev.cat || dt >= 3 * DAY) return false;
    if (e.co === ev.co && sim >= 0.2) return true;                                       // same house, same kind of story
    const names = [e.co, ...(e.also || [])];
    if (evOthers.some(a => names.some(b => !HOUSE_NAMES.has(b) && sameEntity(a, b)))) return true;  // same named target
    const eHouses = names.filter(n => HOUSE_NAMES.has(n)).sort().join('|');
    return evHouses.includes('|') && evHouses === eHouses;                                // same pair of houses
  });
}

// ─── ntfy ────────────────────────────────────────────────────────────────────
const TAGS = { mna: 'handshake', fund: 'moneybag', earn: 'chart_with_upwards_trend', part: 'link' };
async function push(msg) {
  const body = { topic: NTFY_TOPIC, ...msg };
  if (SITE_URL) body.actions = [{ action: 'view', label: 'Dashboard', url: SITE_URL }];
  if (!NTFY_TOPIC) { console.log('[dry-run push]', JSON.stringify({ ...body, topic: undefined })); return true; }
  try {
    const res = await fetch(NTFY_SERVER, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch (err) { console.error('push failed:', err.message); return false; }
}
async function notifyEvents(list) {
  if (!list.length) return 0;
  if (list.length > DIGEST_AT) {
    const hi = list.filter(e => e.hi).length;
    await push({ title: `${list.length} new beauty deal alerts${hi ? ` · ${hi} major` : ''}`, priority: hi ? 4 : 3, tags: ['bell'],
      message: list.slice(0, 10).map(e => `• ${CATS[e.cat]} · ${e.co}: ${e.head}`).join('\n'), click: SITE_URL || undefined });
    return 1;
  }
  let n = 0;
  for (const e of list) {
    const lines = [e.head];
    if (e.value !== '—') lines.push(e.value);
    lines.push(`${e.src}${e.rumor ? ' · reported' : ''}`);
    if (await push({ title: `${e.hi ? 'MAJOR · ' : ''}${CATS[e.cat]} · ${e.co}`, message: lines.join('\n'),
      priority: e.hi ? 5 : 4, tags: [TAGS[e.cat]], click: e.url })) n++;
  }
  return n;
}

// ─── main ────────────────────────────────────────────────────────────────────
const now = Date.now();
await mkdir(DATA_DIR, { recursive: true });
const feedPath = path.join(DATA_DIR, 'feed.json'), statePath = path.join(DATA_DIR, 'state.json');
let feed = await readJson(feedPath, null);
const state = await readJson(statePath, { seen: {}, sources: {}, alerts: {} });
const firstRun = !feed;
if (!feed) {
  const seed = await readJson(path.join(ROOT, 'seed/history.json'), { events: [], press: [] });
  feed = { events: seed.events, press: seed.press };
  console.log(`first run: seeded ${feed.events.length} events, ${feed.press.length} press stories; no pushes this run`);
}

const sources = buildSources();
const results = await Promise.allSettled(sources.map(async s => ({ s, items: parseFeed(await fetchText(s.url)) })));

const fresh = [], pressFresh = [];
const failed = [];
results.forEach((r, i) => {
  const s = sources[i];
  const st = state.sources[s.id] || (state.sources[s.id] = { fails: 0 });
  if (r.status === 'rejected') { st.fails++; st.lastError = String(r.reason?.message || r.reason); failed.push(s.id); return; }
  const items = r.value.items;
  st.fails = 0; st.lastOk = now; st.lastCount = items.length; delete st.lastError;
  for (const it of items) {
    if (!Number.isFinite(it.ts)) continue;                         // undated = unverifiable; skip
    if (it.ts > now + 3600e3) it.ts = now;                          // clock-skewed feeds
    if (now - it.ts > 14 * DAY) continue;
    const key = sha(it.link) , tkey = sha(fold(it.title));
    if (state.seen[key] || state.seen[tkey]) continue;
    state.seen[key] = state.seen[tkey] = now;
    const c = classify(it, s);
    if (!c.relevant) continue;
    const base = { id: key, ts: it.ts, date: ymd(it.ts), srcDate: shortDay(it.ts), head: c.title, sum: c.sum, url: it.link, firstSeen: now };
    if (s.press) pressFresh.push({ ...base, outlet: c.outlet });
    if (c.cat) fresh.push({ ...base, co: c.co, also: c.also, cat: c.cat, sec: c.sec, geo: c.geo, hi: c.hi, rumor: c.rumor,
      value: c.value, val: c.val, src: c.outlet, sources: [{ src: c.outlet, url: it.link }], google: !!s.google });
  }
});

// Merge events: a twin extends the existing event's provenance and is never pushed again.
const toNotify = [];
fresh.sort((a, b) => a.ts - b.ts);
for (const ev of fresh) {
  const twin = findTwin(feed.events, ev);
  if (twin) {
    twin.sources = twin.sources || [{ src: twin.src, url: twin.url }];
    if (!twin.sources.some(x => x.url === ev.url)) twin.sources.push({ src: ev.src, url: ev.url });
    if (twin.google && !ev.google) { Object.assign(twin, { url: ev.url, src: ev.src, google: false }); if (!twin.sum) twin.sum = ev.sum; }
    if (twin.value === '—' && ev.value !== '—') Object.assign(twin, { value: ev.value, val: ev.val });
    twin.hi = twin.hi || ev.hi;
    continue;
  }
  feed.events.push(ev);
  if (!firstRun && now - ev.ts <= NOTIFY_MAX_AGE_H * 3600e3) toNotify.push(ev);
}
for (const p of pressFresh) if (!feed.press.some(x => x.url === p.url || similar(tokens(x.head), tokens(p.head)) >= 0.8)) feed.press.push(p);

// Retention.
feed.events = feed.events.filter(e => now - (e.ts || Date.parse(e.date)) <= EVENT_DAYS * DAY).sort((a, b) => (b.ts || 0) - (a.ts || 0));
feed.press = feed.press.filter(e => now - (e.ts || Date.parse(e.date)) <= PRESS_DAYS * DAY).sort((a, b) => (b.ts || 0) - (a.ts || 0));
for (const [k, t] of Object.entries(state.seen)) if (now - t > SEEN_DAYS * DAY) delete state.seen[k];

// Push.
let pushed = await notifyEvents(toNotify);
if (NOTIFY_PRESS && !firstRun) {
  const pr = pressFresh.filter(p => now - p.ts <= NOTIFY_MAX_AGE_H * 3600e3 && !toNotify.some(e => e.url === p.url));
  if (pr.length) pushed += +(await push({ title: `${pr.length} trade-press ${pr.length === 1 ? 'story' : 'stories'}`, priority: 2, tags: ['newspaper'],
    message: pr.slice(0, 8).map(p => `• ${p.outlet}: ${p.head}`).join('\n'), click: SITE_URL || undefined }));
}

// Pipeline health: a dead source must never read as a quiet market. Alert once when a source
// has failed for ~2h straight, and once more when it recovers.
const sick = Object.entries(state.sources).filter(([, st]) => st.fails >= 24).map(([id]) => id);
const known = new Set(Object.keys(state.alerts));
const newlySick = sick.filter(id => !known.has(id)), recovered = [...known].filter(id => !sick.includes(id));
if (!firstRun && (newlySick.length || recovered.length)) {
  await push({ title: 'Beauty News: source health', priority: 3, tags: ['warning'],
    message: [newlySick.length && `Failing ~2h: ${newlySick.join(', ')}`, recovered.length && `Recovered: ${recovered.join(', ')}`].filter(Boolean).join('\n') });
}
state.alerts = Object.fromEntries(sick.map(id => [id, state.alerts[id] || now]));

feed.generatedAt = new Date(now).toISOString();
feed.run = { sources: sources.length, ok: sources.length - failed.length, failed, newEvents: fresh.length, pushed };
feed.watch = WATCH.map(h => h.name);
await writeFile(feedPath, JSON.stringify(feed));
await writeFile(statePath, JSON.stringify(state));
// Dead-man's switch outside GitHub: healthchecks.io alerts (email/ntfy) if these pings stop.
if (process.env.HEALTHCHECK_URL) {
  await fetch(process.env.HEALTHCHECK_URL + (failed.length > sources.length / 2 ? '/fail' : ''), { method: 'POST', body: JSON.stringify(feed.run) })
    .catch(err => console.error('healthcheck ping failed:', err.message));
}
console.log(`sources ${sources.length - failed.length}/${sources.length} ok${failed.length ? ` (failed: ${failed.join(', ')})` : ''}; ` +
  `candidates ${fresh.length}, new events ${toNotify.length} pushed ${pushed}; press +${pressFresh.length}; ` +
  `record ${feed.events.length} events / ${feed.press.length} press`);
