// The zone check the director runs before a registrar deploy (F1 of scratch/reviews/fable-security-registrar.md): every
// host record in the beanpool.org zone that the registrar did not make must have a `blocked` row in name_policy, or any
// node key could claim that label. The registrar refuses a claim that finds such a record (src/index.js
// outsideRegistrar), but the policy row is what keeps it from ever being asked. It reads only files the director
// supplies; it never calls Cloudflare or D1 itself.
//
//   node scripts/check-zone-reserved.mjs --zone <zone.json> --allocations <alloc.json> --policy <policy.json> [--base beanpool.org]
//
//   zone.json         the zone's DNS records: Cloudflare's list answer ({ result: [...] }) or a plain array, each
//                     { id, type, name, proxied }.
//   alloc.json        `wrangler d1 execute beanpool-registrar --remote --json --command
//                     "SELECT name, dns_record_id FROM name_allocations"` (or a plain array of those rows).
//   policy.json       the same for "SELECT pattern, tier FROM name_policy".
//
// Exit 1 and one line per label when any is missing; 0 otherwise. Records the registrar can't touch are skipped: other
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

// What is wrong: [] when every host record the registrar did not make is at a blocked label.
export function zoneProblems({ records, allocations, policy, base = 'beanpool.org' }) {
    const made = new Set(allocations.map((a) => a.dns_record_id).filter(Boolean));
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
        problems.push(`${fqdn} (${r.type}${r.proxied ? ', proxied' : ''}) is not the registrar's, and ${label} is ${tier.has(label) ? tier.get(label) : 'not in name_policy (auto)'}: add ('${label}','blocked')`);
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
    const read = (f) => rowsOf(JSON.parse(readFileSync(f, 'utf8')));
    const problems = zoneProblems({ records: read(files.zone), allocations: read(files.allocations), policy: read(files.policy), base: arg(argv, '--base') || 'beanpool.org' });
    for (const p of problems) console.error(`✗ ${p}`);
    if (problems.length) { console.error(`${problems.length} label(s) of ours a node key could claim. Reserve them (a migration) before deploying.`); return 1; }
    console.log('✓ every host record the registrar did not make is at a blocked label');
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exit(main());
