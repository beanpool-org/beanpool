/* global Buffer, URL -- a Node script */
// The directory's two migrations (front doors S13; supabase/migrations/2026102800_directory_listed.sql and
// 2026102801_directory_purge.sql). No Postgres runs here and no agent may reach the live project, so this reads the SQL
// and holds it to the rules the readers depend on: the 7-day bound, the address-or-contact rule, the default name →
// host rule, last_seen_at, security_invoker and the grants; and the daily purge at 30 days. The view's address pattern
// is also taken out of the SQL and run (a POSIX ARE this simple means the same in a JS RegExp) on the addresses the
// readers see, with the host cut the view makes, so a change to either is a change this test sees. And it is held to the
// readers' own rule (global's communityUrl, the website's nodeHref, the phone's communityOrigin, copied here and pinned
// to their files): every address the view takes, they take, so a row listed by its address leads somewhere real.
//
// The director's read-only checks after applying it are in the PR body (a row at 6 d 23 h shown, at 7 d 1 h not, the
// default name → host, no address and no contact → not shown).
//
// Run: node --test scripts/directory-listed-migration.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEW_FILE = path.join(ROOT, 'supabase/migrations/2026102800_directory_listed.sql');
const PURGE_FILE = path.join(ROOT, 'supabase/migrations/2026102801_directory_purge.sql');

/** The SQL without its comments, whitespace folded, lower case: what Postgres runs. */
function statements(file) {
    const sql = fs.readFileSync(file, 'utf-8');
    return sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n').replace(/\s+/g, ' ').trim();
}

const view = () => statements(VIEW_FILE);
const lower = () => view().toLowerCase();

test('the view is directory_listed over directory_nodes, as the caller (security_invoker)', () => {
    assert.match(lower(), /create or replace view public\.directory_listed with \( ?security_invoker = true ?\) as select /);
    assert.match(lower(), / from public\.directory_nodes d /);
});

test('only rows pushed within the last 7 days', () => {
    assert.match(lower(), /where d\.updated_at >= now\(\) - interval '7 days'/);
    assert.ok(!/interval '(?!7 days)[^']*'/.test(lower()), 'no other interval in the view');
});

test('and with an https address or a contact', () => {
    assert.match(lower(), /and \( address\.host is not null or nullif\(btrim\(d\.contact_email\), ''\) is not null or nullif\(btrim\(d\.contact_phone\), ''\) is not null \)/);
});

test('shown_name: the trimmed name, unless blank or the default (any case), then the host of node_url', () => {
    assert.match(lower(), /case when nullif\(btrim\(d\.community_name\), ''\) is null or lower\(btrim\(d\.community_name\)\) = 'beanpool community' then coalesce\(address\.host, nullif\(btrim\(d\.community_name\), ''\)\) else btrim\(d\.community_name\) end as shown_name/);
});

test('last_seen_at is updated_at, and every column the readers read is there', () => {
    assert.match(lower(), /d\.updated_at as last_seen_at/);
    for (const col of ['node_id', 'callsign', 'community_name', 'service_radius', 'member_count', 'contact_email', 'contact_phone',
        'node_version', 'node_url', 'promise', 'accepting_knocks', 'closing_on', 'updated_at']) {
        assert.ok(lower().includes(`d.${col},`), `the view carries ${col}`);
    }
});

test('anon and authenticated may read it, and nobody may write through it', () => {
    assert.match(lower(), /grant select on public\.directory_listed to anon, authenticated;/);
    assert.match(lower(), /revoke insert, update, delete, truncate, references, trigger on public\.directory_listed from anon, authenticated;/);
    assert.ok(!/grant (insert|update|delete|all)/.test(lower()), 'no write is granted');
    // The table itself: its RLS and its public read stay as they are.
    assert.ok(!/(alter|drop|revoke|grant|policy)[^;]* public\.directory_nodes/.test(lower()), 'the table is not touched');
    assert.ok(!/\b(insert into|update public|delete from)\b/.test(lower()), 'no row is written');
});

/** The address pattern, its length bound and host cut, as the view has them. */
function addressRule() {
    const m = view().match(/btrim\(d\.node_url\) ~\* '([^']+)'/);
    assert.ok(m, 'the view tests node_url with a case-insensitive pattern');
    const bound = view().match(/when octet_length\(btrim\(d\.node_url\)\) <= (\d+) and btrim\(d\.node_url\) ~\* /);
    assert.ok(bound, 'the view bounds node_url in bytes before its pattern');
    const pattern = new RegExp(m[1], 'i');
    return (nodeUrl) => {
        // btrim: spaces only.
        const v = (nodeUrl ?? '').replace(/^ +| +$/g, '');
        if (Buffer.byteLength(v, 'utf8') > Number(bound[1]) || !pattern.test(v)) return null;
        // split_part(split_part(regexp_replace(lower(btrim(node_url)), '^https://', ''), '/', 1), ':', 1)
        return v.toLowerCase().replace(/^https:\/\//, '').split('/')[0].split(':')[0];
    };
}

test('the address rule: an https address or a bare host name, nothing else', () => {
    assert.ok(lower().includes("then split_part(split_part(regexp_replace(lower(btrim(d.node_url)), '^https://', ''), '/', 1), ':', 1) end as host"),
        'the host cut is the one this test runs');
    const host = addressRule();
    const shown = {
        'https://gippsland.beanpool.org': 'gippsland.beanpool.org',
        'HTTPS://EastGippy.BeanPool.org/': 'eastgippy.beanpool.org',
        'https://mullum.beanpool.org:8443/path': 'mullum.beanpool.org',
        'castlemaine.example.org': 'castlemaine.example.org',
        ' https://review.beanpool.org ': 'review.beanpool.org',
    };
    for (const [url, h] of Object.entries(shown)) assert.equal(host(url), h, url);
    for (const url of ['http://plain.example.org', 'https://10.0.0.1', 'https://localhost', 'https://user:pw@good.example.org',
        'javascript:alert(1)', 'ftp://x.example.org', '', null, 'https://', 'https://x.example.org?q=1']) {
        assert.equal(host(url), null, String(url));
    }
});

// ── The readers' rule (deciding pass on #2541, finding 4) ───────────────────────────────────────────────────────────

const READER_FILES = {
    global: 'apps/server/src/engine/directory-cache.ts',
    website: 'apps/website/main.js',
    phone: 'apps/native/utils/community-origin.ts',
};
const BARE_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?\/?$/i;

/** apps/server/src/engine/directory-cache.ts communityUrl (the website's nodeHref is the same rule): an https origin or null. */
function readerUrl(v) {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (!s || s.length > 300) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : BARE_HOST.test(s) ? `https://${s}` : null;
    if (!withScheme) return null;
    let u;
    try { u = new URL(withScheme); } catch { return null; }
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    if (!/\.[a-z][a-z0-9-]*$/i.test(u.hostname)) return null;
    return u.origin;
}

/** apps/native/utils/community-origin.ts communityOrigin on global's origin, less its IPv4 and global-node cases (the view takes neither). */
function phoneOrigin(raw) {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!/^https:\/\//i.test(trimmed) || trimmed.length > 300) return null;
    const m = /^https:\/\/([^/?#@\s]+)(?=[/?#]|$)/i.exec(trimmed);
    const h = m ? m[1].toLowerCase().replace(/:443$/, '') : null;
    if (!h) return null;
    const name = h.replace(/:\d{1,5}$/, '');
    const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
    if (/^[\d.]+$/.test(name) || !new RegExp(`^${label}(?:\\.${label})+$`).test(name)) return null;
    return `https://${h}`;
}

test('the readers\' rule this test copies is still theirs (change a reader: change the view and this copy with it)', () => {
    const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf-8');
    const global = src(READER_FILES.global);
    assert.ok(global.includes(`const BARE_HOST = ${BARE_HOST};`), 'global: BARE_HOST');
    for (const line of [
        'if (!s || s.length > 300) return null;',
        'const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : BARE_HOST.test(s) ? `https://${s}` : null;',
        "if (u.protocol !== 'https:' || u.username || u.password) return null;",
        'if (!/\\.[a-z][a-z0-9-]*$/i.test(u.hostname)) return null;',
    ]) assert.ok(global.includes(line), `global: ${line}`);
    const website = src(READER_FILES.website);
    assert.ok(website.includes(`: ${BARE_HOST}.test(value) ? \`https://\${value}\` : null;`), 'website: the same bare host');
    assert.ok(website.includes('if (!value || value.length > 300) return null;'), 'website: the same 300');
    assert.ok(website.includes('if (!/\\.[a-z][a-z0-9-]*$/i.test(u.hostname)) return null;'), 'website: the same top-level part');
    const phone = src(READER_FILES.phone);
    assert.ok(phone.includes('const m = /^https:\\/\\/([^/?#@\\s]+)(?=[/?#]|$)/i.exec(url);'), 'phone: the host');
    assert.ok(phone.includes("const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';"), 'phone: each label 1 to 63 characters');
});

test('an address the readers turn into no link is no address to the view either (the shapes the pass measured, and more)', () => {
    const host = addressRule();
    for (const url of [
        'bare.example.org/path', // a bare host with a path
        'https://port.example.org:99999', // a port above 65535
        'https://port.example.org:65536',
        'https://Mullum.Example.ORG.:8443/x', // a trailing dot, before a port
        'https://mullum.example.org./x', // ... or a path
        'mullum.example.org.',
        'mullum.example.org:8443', // a bare host with a port: a reader takes "mullum.example.org:" for a scheme
        `https://a.example.org/${'x'.repeat(300)}`, // longer than 300
        `https://a.example.org/${'😀'.repeat(140)}`, // 162 characters in Postgres, 302 to a reader (an emoji is two)
        `https://${'a'.repeat(64)}.example.org`, // a label longer than 63: global takes it, the phone does not
        'https://a.example.or-', // a last label ending in a hyphen: likewise
    ]) {
        assert.equal(host(url), null, `view: ${url}`);
        const g = readerUrl(url);
        assert.ok(g === null || phoneOrigin(g) === null, `and no reader links it: ${url}`);
    }
    // Port 0: a reader makes a link of it, but nothing answers there. The view may be stricter than a reader, never looser.
    assert.equal(host('https://port.example.org:0'), null, 'view: port 0');
    // The other way round: each reader takes these, and so does the view, at the same host.
    for (const [url, h] of Object.entries({
        'https://port.example.org:65535': 'port.example.org',
        'https://mullum.example.org:8443/x': 'mullum.example.org',
        'bare.example.org/': 'bare.example.org',
        [`https://${'a'.repeat(63)}.example.org`]: `${'a'.repeat(63)}.example.org`,
        'https://xn--mnchen-3ya.de': 'xn--mnchen-3ya.de',
        'https://xn--d1acufc.xn--p1ai': 'xn--d1acufc.xn--p1ai',
    })) {
        assert.equal(host(url), h, `view: ${url}`);
        assert.equal(new URL(phoneOrigin(readerUrl(url))).hostname, h, `readers: ${url}`);
    }
});

test('every address the view takes, the readers take, at the same host (20,000 made-up addresses)', () => {
    const host = addressRule();
    // mulberry32: the same addresses on every run.
    let seed = 0x5133;
    const rand = () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = (xs) => xs[Math.floor(rand() * xs.length)];
    // Punycode is the one thing the view's pattern cannot check (its header says why): no `xn--` here.
    // Mostly good parts, so that many of the addresses are ones the view takes, and one bad part spoils the rest.
    const label = () => pick(['a', 'mullum', 'B9', 'a-b', 'ab--cd', '9', 'x'.repeat(63), 'mullum', 'a', 'B9',
        '-a', 'a-', '', 'a_b', 'x'.repeat(64), 'é']);
    const tld = () => pick(['org', 'ORG', 'io', 'a1', 'o-g', 'x'.repeat(63), 'org', 'io', 'a-', '1a', '9', 'x'.repeat(64), '']);
    let taken = 0;
    for (let i = 0; i < 20_000; i++) {
        const labels = Array.from({ length: Math.floor(rand() * 3) + (rand() < 0.9 ? 1 : 0) }, label);
        const url = pick(['https://', 'HTTPS://', '', 'https://', '', 'http://', 'https:', 'https:///', ' https://', 'u:p@'])
            + [...labels, tld()].join('.') + pick(['', '', '', '.', '..'])
            + pick(['', '', '', ':', ':0', ':1', ':443', ':8443', ':65535', ':65536', ':99999', ':00443', ':123456'])
            + pick(['', '', '/', '/path', '/a/b?c#d', '', '?q', '#f', '//', '@x.org', ' ', '\t', `/${'p'.repeat(280)}`]);
        const h = host(url);
        if (h === null) continue;
        taken++;
        const g = readerUrl(url);
        assert.ok(g !== null, `global and the website take what the view takes: ${JSON.stringify(url)}`);
        assert.ok(phoneOrigin(g) !== null, `and so does the phone: ${JSON.stringify(url)}`);
        assert.equal(new URL(g).hostname, h, `at the host the view names: ${JSON.stringify(url)}`);
    }
    assert.ok(taken > 300, `the view took ${taken} of them (465 when written): enough to say something`);
});

test('what a reader sees, row by row (the view in JS, from its own pattern)', () => {
    const host = addressRule();
    const DAY = 86_400_000, HOUR = 3_600_000, now = Date.UTC(2026, 9, 28);
    const listed = (r) => {
        const h = host(r.node_url);
        const fresh = now - r.updated_at <= 7 * DAY;
        const contact = (r.contact_email ?? '').trim() || (r.contact_phone ?? '').trim();
        if (!fresh || !(h || contact)) return null;
        const name = (r.community_name ?? '').trim();
        return !name || name.toLowerCase() === 'beanpool community' ? (h ?? (name || null)) : name;
    };
    const at = (ago) => now - ago;
    assert.equal(listed({ community_name: 'Riverbend', node_url: 'https://riverbend.example.org', updated_at: at(6 * DAY + 23 * HOUR) }), 'Riverbend', '6 d 23 h: shown');
    assert.equal(listed({ community_name: 'Riverbend', node_url: 'https://riverbend.example.org', updated_at: at(7 * DAY + HOUR) }), null, '7 d 1 h: not shown');
    assert.equal(listed({ community_name: 'BeanPool Community', node_url: 'https://gippsland.beanpool.org', updated_at: at(HOUR) }), 'gippsland.beanpool.org', 'default name: the host');
    assert.equal(listed({ community_name: '  beanpool COMMUNITY ', node_url: 'eastgippy.beanpool.org', updated_at: at(HOUR) }), 'eastgippy.beanpool.org', 'default name in any case: the host');
    assert.equal(listed({ community_name: null, node_url: 'https://x.example.org', updated_at: at(HOUR) }), 'x.example.org', 'no name: the host');
    assert.equal(listed({ community_name: 'Yarra Valley', node_url: null, updated_at: at(HOUR) }), null, 'no address and no contact: not shown');
    assert.equal(listed({ community_name: 'Cairns', node_url: 'http://cairns.example.org', contact_email: ' ', updated_at: at(HOUR) }), null, 'an http address and a blank contact: not shown');
    assert.equal(listed({ community_name: 'Yarra Valley', node_url: null, contact_phone: '+61 3 5555 0000', updated_at: at(HOUR) }), 'Yarra Valley', 'a contact alone: shown');
});

test('the purge: pg_cron installed if missing, one daily job deleting rows older than 30 days', () => {
    const purge = statements(PURGE_FILE).toLowerCase();
    assert.match(purge, /^create extension if not exists pg_cron;/);
    const jobs = [...purge.matchAll(/cron\.schedule\(/g)];
    assert.equal(jobs.length, 1, 'one job');
    assert.match(purge, /select cron\.schedule\( 'directory-purge-30d', '17 3 \* \* \*', \$\$delete from public\.directory_nodes where updated_at < now\(\) - interval '30 days'\$\$ \);/);
    assert.ok(!/drop|truncate|alter table/.test(purge), 'nothing else');
});
