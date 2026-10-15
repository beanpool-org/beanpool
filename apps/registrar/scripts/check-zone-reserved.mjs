// The zone check the director runs before a registrar deploy (F1 of scratch/reviews/fable-security-registrar.md): every
// host record in the beanpool.org zone that the registrar did not make must have a `blocked` row in name_policy, or any
// node key could claim that label. The registrar refuses a claim that finds such a record (src/index.js
// outsideRegistrar), but the policy row is what keeps it from ever being asked. It reads only files the director
// supplies; it never calls Cloudflare or D1 itself.
//
//   node scripts/check-zone-reserved.mjs --zone <zone.json> --allocations <alloc.json> --policy <policy.json> [--base beanpool.org]
//
//   zone.json         the zone's DNS records: Cloudflare's list answer ({ result: [...] }) or a plain array, each
//                     { id, type, name, proxied }. Ask for every record on one page (?per_page=5000): an answer whose
//                     result_info says there is more (total_pages > 1, or count < total_count) is refused (exit 2).
//   alloc.json        `wrangler d1 execute beanpool-registrar --remote --json --command
//                     "SELECT name, status, pause_reason, dns_record_id FROM name_allocations"` (or a plain array of
//                     those rows).
//   policy.json       the same for "SELECT pattern, tier FROM name_policy".
//
// Exit 1 and one line per label when any is missing; 0 otherwise. A record at a label whose row a key can still heal or
// take back (keyCanHeal) is not advised to be blocked: that is a community's name whose row lags (its owner's heal adopts
// the record), so the line says to repair it. At a row no key can heal (abandoned, freed at once, held from every key)
// the label is free, and the line gives the row's status and the block. Records the registrar can't touch are skipped: other
// types than A/AAAA/CNAME (ensure() only finds those), the apex, deeper names (a.b.beanpool.org), and labels no claim
// can name (NAME_RE: _dmarc and the like). Proxied or not makes no difference: ensure() PATCHes either.

import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/; // as src/index.js
const HOST_TYPES = ['A', 'AAAA', 'CNAME'];

// Rows out of whatever shape the director pasted: a plain array, Cloudflare's { result }, or wrangler's [{ results }].
export function rowsOf(data) {
    if (Array.isArray(data) && data.length && data.every((d) => d && Array.isArray(d.results))) return data.flatMap((d) => d.results);
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.result)) return data.result;
    if (data && Array.isArray(data.results)) return data.results;
    throw new Error('expected an array of rows, Cloudflare\'s { result: [...] }, or wrangler\'s [{ results: [...] }]');
}

// Why Cloudflare's answer is not the whole zone, or null: it pages its list (100 a page unless per_page says more).
export function partialZone(data) {
    const info = data && !Array.isArray(data) ? data.result_info : null;
    if (!info) return null;
    if (info.total_pages > 1) return `page ${info.page ?? '?'} of ${info.total_pages} (${info.count} of ${info.total_count} records)`;
    if (info.total_count != null && (info.count ?? rowsOf(data).length) < info.total_count) return `${info.count ?? rowsOf(data).length} of ${info.total_count} records`;
    return null;
}

// Can a key still heal this row's name, or take it back? src/index.js isOwnRow, whoever the key (a test holds the two
// together): not once the row is abandoned, freed at once (the admin's "free now", a gated claim withdrawn or rejected)
// or held from every key by the admin's release. Null when the export doesn't say (no status, or a released row
// without pause_reason).
export function keyCanHeal(row) {
    if (!row?.status) return null;
    if (row.status === 'abandoned') return false;
    if (row.status !== 'released') return true;
    if (row.pause_reason === undefined) return null;
    return !['admin', 'withdrawn', 'admin-held-all'].includes(row.pause_reason);
}

// What is wrong: [] when every host record the registrar did not make is at a blocked label.
export function zoneProblems({ records, allocations, policy, base = 'beanpool.org' }) {
    const made = new Set(allocations.map((a) => a.dns_record_id).filter(Boolean));
    const held = new Map(allocations.map((a) => [String(a.name).toLowerCase(), a]));
    const tier = new Map(policy.map((p) => [String(p.pattern).toLowerCase(), p.tier]));
    const suffix = `.${base.toLowerCase()}`;
    const problems = [];
    for (const r of records) {
        if (!r || !HOST_TYPES.includes(r.type)) continue;
        const fqdn = String(r.name || '').toLowerCase();
        if (!fqdn.endsWith(suffix)) continue;
        const label = fqdn.slice(0, -suffix.length);
        if (!NAME_RE.test(label)) continue;          // the apex, a deeper name, or a label no claim can name
        if (made.has(r.id)) continue;                // the registrar's own record for a claimed name
        if (tier.get(label) === 'blocked') continue;
        const what = `${fqdn} (${r.type}${r.proxied ? ', proxied' : ''})`;
        const row = held.get(label);
        const heals = row ? keyCanHeal(row) : false;
        if (heals) {
            problems.push(`${what} is not the record its row records, but ${label} has a row (${row.status}): a community's name — repair, don't block (its owner's heal adopts the record; look in /admin)`);
            continue;
        }
        const block = `add ('${label}','blocked')`;
        if (heals === null) {
            problems.push(`${what} is not the record its row records, and ${label}'s row is ${row.status || 'of a status not given'}${row.status ? ' without pause_reason' : ''}: look in /admin — repair it if a key can still heal it, else ${block} (export pause_reason too)`);
            continue;
        }
        if (row) {
            problems.push(`${what} is not the registrar's, and ${label}'s row is ${row.status}${row.pause_reason ? ` (${row.pause_reason})` : ''}: no key can heal it and a new claim there is refused, so if the record is ours, ${block}`);
            continue;
        }
        problems.push(`${what} is not the registrar's, and ${label} is ${tier.has(label) ? tier.get(label) : 'not in name_policy (auto)'}: ${block}`);
    }
    return problems;
}

function arg(argv, flag) {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv = process.argv.slice(2)) {
    const files = { zone: arg(argv, '--zone'), allocations: arg(argv, '--allocations'), policy: arg(argv, '--policy') };
    const missing = Object.entries(files).filter(([, f]) => !f).map(([k]) => `--${k}`);
    if (missing.length) { console.error(`usage: check-zone-reserved.mjs --zone <f> --allocations <f> --policy <f> (missing ${missing.join(', ')})`); return 2; }
    const load = (f) => JSON.parse(readFileSync(f, 'utf8'));
    const read = (f) => rowsOf(load(f));
    const zone = load(files.zone);
    const partial = partialZone(zone);
    if (partial) { console.error(`✗ ${files.zone} is not the whole zone: ${partial}. Fetch it again with ?per_page=5000.`); return 2; }
    const problems = zoneProblems({ records: rowsOf(zone), allocations: read(files.allocations), policy: read(files.policy), base: arg(argv, '--base') || 'beanpool.org' });
    for (const p of problems) console.error(`✗ ${p}`);
    if (problems.length) { console.error(`${problems.length} label(s) to look at. Reserve each of ours (a migration) before deploying; repair a community's row, don't block it.`); return 1; }
    console.log('✓ every host record the registrar did not make is at a blocked label');
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exit(main());
