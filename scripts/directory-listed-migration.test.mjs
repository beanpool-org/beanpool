// The directory's two migrations (front doors S13; supabase/migrations/2026102800_directory_listed.sql and
// 2026102801_directory_purge.sql). No Postgres runs here and no agent may reach the live project, so this reads the SQL
// and holds it to the rules the readers depend on: the 7-day bound, the address-or-contact rule, the default name →
// host rule, last_seen_at, security_invoker and the grants; and the daily purge at 30 days. The view's address pattern
// is also taken out of the SQL and run (a POSIX ARE this simple means the same in a JS RegExp) on the addresses the
// readers see, with the host cut the view makes, so a change to either is a change this test sees.
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

/** The address pattern and host cut, as the view has them. */
function addressRule() {
    const m = view().match(/btrim\(d\.node_url\) ~\* '([^']+)'/);
    assert.ok(m, 'the view tests node_url with a case-insensitive pattern');
    const pattern = new RegExp(m[1], 'i');
    return (nodeUrl) => {
        const v = (nodeUrl ?? '').trim();
        if (!pattern.test(v)) return null;
        // rtrim(split_part(split_part(regexp_replace(lower(btrim(node_url)), '^https://', ''), '/', 1), ':', 1), '.')
        return v.toLowerCase().replace(/^https:\/\//, '').split('/')[0].split(':')[0].replace(/\.+$/, '');
    };
}

test('the address rule: an https address or a bare host name, nothing else', () => {
    assert.ok(lower().includes("rtrim(split_part(split_part(regexp_replace(lower(btrim(d.node_url)), '^https://', ''), '/', 1), ':', 1), '.')"),
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
