/**
 * DNS robustness S6, the AI-readable check (design scratch/fable-design/DESIGN-dns-robustness-fable.md §5.3, §8 slice 6):
 * server_health's `addresses` (agent/server-addresses.ts). End to end with the official TypeScript MCP SDK client over REAL
 * HTTPS through the real Koa middleware, which validates every answer against the tool's outputSchema. What the check round
 * found is seeded into its own row (services/address-check.ts ADDRESS_CHECK_KEY), as the round leaves it: the round itself
 * is test-address-check.ts's. Nothing here contacts anything but the server it starts.
 *
 *   1. The field's shape, one published address per state the S1 check can leave: own, other, other-origin, silence (a new
 *      name with its age, and an old one), tls, not asked (a home-network name; a name that points at one from here), and
 *      not checked yet. The main address first, each with its host, kind, main, answers, checkedAt, step, the one next step
 *      in English words an assistant passes on, and its standing (none here).
 *   2. Only published addresses: no former name, no loopback name, whatever the row holds for them.
 *   3. Nothing beyond host, time and the step's words (the /check page's rule): never a number or name a host points at, a
 *      tunnel's name, a key, the time this server's key last answered, or a member's name. Reading it asks nothing and
 *      writes nothing.
 *   4. An admin's grant reads it too: Settings shows the same report to owners and admins (routes/app-addresses.ts).
 *   5. A standby's server_health is today's, key for key: a standby checks nothing (address-check.ts runRound).
 *   6. A BeanPool name the address service says is nobody's, another community's, or has no record of (at risk, or a
 *      contradiction: registrar-name-watch.ts nameStandings) while the check found this server there: the assistant reads
 *      the standing in the Addresses screen's words and the screen's next step, never "Nothing to do", side by side with
 *      Settings' report (routes/app-addresses.ts appAddressesReport), as the Opus review of #2835 measured it.
 *   7. A grant whose maker is now a member gets what it got before: 401, and no answer at all.
 *   8. The operator manual's AI page (packages/beanpool-guide/operators/server/ai-assistant.md) lists the addresses under
 *      Health, and its "What it never sees" says which addresses: any but the community's own.
 *
 * Run: SERVER_SUITES_ONLY=test-mcp-addresses TEST_ALL_JOBS=2 node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_ROLE;
// The addresses the operator lists (engine/own-addresses.ts envAddresses): one per state below, and a loopback name for an
// SSH tunnel, which names no community and is never published.
process.env.BEANPOOL_ADDRESSES = [
    'shire.example.org', 'other.example.org', 'page.example.org', 'quiet.example.org', '203.0.113.5', 'nas.lan',
    'split.example.org', 'unchecked.example.org', 'localhost',
].join(',');

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
    ADDRESS_CHECK_WORDS, ADDRESS_SCREEN_WORDS, addressNextStep, addressReachSentence, addressStandingText, wordsFor,
} from '@beanpool/core';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, updateNodeConfig } from './state-engine.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { grantNodeRole, revokeNodeRole } from './engine/node-roles.js';
import { forgetOwnAddresses, publishedAddresses, primaryAddress } from './engine/own-addresses.js';
import { setNodeRole } from './config/node-role.js';
import { db } from './db/db.js';
import { ADDRESS_CHECK_KEY } from './services/address-check.js';
import { NAME_WATCH_KEY } from './services/registrar-name-watch.js';
import { appAddressesReport } from './routes/app-addresses.js';
import { nodePubkeyHex } from './services/registrar-client.js';
import { loadOrCreateIdentity, setPrivateKeyForTests } from './p2p.js';
import { AGENT_TOOLS } from './agent/tools.js';
import { adminSigninFields } from './signed-request-test-helper.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

interface Reply { status: number; body: any; text: string }
async function call(method: string, p: string, opts: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
    const res = await fetch(`${BASE}${p}`, {
        method,
        headers: { ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        redirect: 'manual',
    });
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body, text };
}
const show = (r: Reply) => `${r.status} ${r.text.slice(0, 160)}`;
const asSession = (id: string | null): Record<string, string> => ({ 'X-Admin-Session': id ?? '' });
const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });

interface Key { pub: string; priv: crypto.KeyObject }
function keypair(): Key {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey };
}
async function keySignIn(k: Key): Promise<string | null> {
    const chal = await call('POST', '/api/local/admin/auth/challenge', { body: {} });
    const solved = await call('POST', '/api/local/admin/auth/verify-challenge', {
        body: { challengeId: chal.body?.challengeId, memberPubkey: k.pub, ...adminSigninFields(k.priv, chal.body?.challengeId ?? '') },
    });
    const res = await fetch(`${BASE}/api/local/admin/auth/exchange`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: solved.body?.handshakeToken }),
    });
    const cookie = res.headers.getSetCookie().find(c => c.startsWith('admin_session=')) ?? '';
    return cookie.match(/^admin_session=([0-9a-f]{64})/)?.[1] ?? null;
}
async function connect(token: string): Promise<Client> {
    const client = new Client({ name: 'beanpool-test-assistant', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: bearer(token) } }));
    return client;
}
async function health(client: Client): Promise<any> {
    const r = await client.callTool({ name: 'server_health', arguments: {} });
    return r.isError ? null : (r.structuredContent ?? null);
}

/** server_health's keys before this slice: what a standby, and every grant before, gets. */
const TODAY_KEYS = ['communityAlerts', 'crashLoop', 'diskUsedPercent', 'memory', 'serverAlerts', 'standbyIncident', 'tlsFallback', 'uncleanStop', 'watchdog'];
/** Each row's keys, and nothing else. */
const ROW_KEYS = ['answers', 'checkedAt', 'host', 'kind', 'main', 'nextStep', 'standing', 'step'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

async function main(): Promise<void> {
    console.log('\n=== DNS robustness S6: server_health.addresses, the check an assistant reads ===\n');
    const webRoot = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), 'bp-mcp-addr-'));
    fs.mkdirSync(path.join(webRoot, 'public', 'settings'), { recursive: true });
    fs.writeFileSync(path.join(webRoot, 'public', 'index.html'), '<!doctype html><title>BeanPool</title>');
    fs.writeFileSync(path.join(webRoot, 'public', 'settings', 'index.html'), '<!doctype html><title>Settings</title>');
    process.chdir(webRoot);

    await initTls();
    initStateEngine();
    // This server's own key, which a check that answers `own` compares with: it must never come back here, whole or as `/check`'s fingerprint.
    setPrivateKeyForTests(await loadOrCreateIdentity());
    const owner = keypair(), owner2 = keypair(), owner3 = keypair();
    const SECRET_MEMBER = 'SecretCallsignAnna';
    seedGenesisMember(owner.pub, SECRET_MEMBER);
    for (const [k, name] of [[owner2, 'Ottilie'], [owner3, 'Moss']] as const) {
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                    VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'inv-test')`).run(k.pub, name, owner.pub);
        db.prepare('INSERT INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(k.pub);
        grantNodeRole(k.pub, 'owner', 'SYSTEM');
    }

    // ── The addresses, and what the round found at each ──
    const now = Date.now();
    const ago = (min: number) => now - min * 60_000;
    const isoAgo = (min: number) => new Date(ago(min)).toISOString();
    // The current registrar name, live, made 12 minutes ago: the main address. And a name this key held before (former).
    const entry = (address: string, role: 'current' | 'former', since: string) => ({
        address, role, status: role === 'current' ? 'live' : 'released', reason: null, since, formerSince: role === 'former' ? isoAgo(600) : null,
        heldUntil: null, releasedByUsAt: null, renamedByUsAt: role === 'former' ? isoAgo(600) : null, lost: null,
    });
    updateNodeConfig({ registrarNames: [entry('byron.beanpool.org', 'current', isoAgo(12)), entry('oldname.beanpool.org', 'former', isoAgo(9000))] } as any);
    forgetOwnAddresses();
    // What a name points at: the round keeps it (address-check.ts DnsSeen); an assistant never reads it.
    const TUNNEL = '6f1c2a90-secret-tunnel-id.cfargotunnel.com';
    const POINTED = ['198.51.100.23', '2001:db8::77', '198.51.100.24', '192.168.1.20', 'edge-host.hosting.example', TUNNEL];
    const dnsSaw = (a: string[], extra: Partial<{ aaaa: string[]; cname: string[] }> = {}) => ({ outcome: 'answers', a, aaaa: extra.aaaa ?? [], cname: extra.cname ?? [] });
    const noName = { outcome: 'no-such-name', a: [], aaaa: [], cname: [] };
    const checks: Record<string, unknown> = {
        'byron.beanpool.org': { checkedAt: ago(1), answers: 'silence', ownAt: null, dns: noName },
        'shire.example.org': { checkedAt: ago(2), answers: 'own', ownAt: ago(2), dns: dnsSaw(['198.51.100.23'], { aaaa: ['2001:db8::77'], cname: ['edge-host.hosting.example'] }) },
        'other.example.org': { checkedAt: ago(3), answers: 'other', ownAt: ago(400), dns: dnsSaw(['198.51.100.23']) },
        'page.example.org': { checkedAt: ago(3), answers: 'other-origin', ownAt: null, dns: dnsSaw(['198.51.100.23']) },
        'quiet.example.org': { checkedAt: ago(4), answers: 'silence', ownAt: ago(500), dns: dnsSaw(['198.51.100.24']) },
        '203.0.113.5': { checkedAt: ago(4), answers: 'tls', ownAt: null, dns: null },
        'nas.lan': { checkedAt: ago(5), answers: null, ownAt: null, dns: null },
        'split.example.org': { checkedAt: ago(5), answers: null, ownAt: null, dns: dnsSaw(['192.168.1.20']) },
        // Not published: the former name and the loopback one. Whatever the row says of them, an assistant isn't told.
        'oldname.beanpool.org': { checkedAt: ago(6), answers: 'own', ownAt: ago(6), dns: dnsSaw([], { cname: [TUNNEL] }) },
        localhost: { checkedAt: ago(6), answers: 'own', ownAt: ago(6), dns: null },
    };
    const ROW = JSON.stringify(checks);
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(ADDRESS_CHECK_KEY, ROW);
    const published = publishedAddresses();
    assert(primaryAddress() === 'byron.beanpool.org' && !published.includes('oldname.beanpool.org') && !published.includes('localhost')
        && ['shire.example.org', 'unchecked.example.org', '203.0.113.5', 'nas.lan'].every((h) => published.includes(h)),
    `the community publishes its live name (main), the operator's addresses, never the former or the loopback name (${published.join(', ')})`);

    const { startHttpsServer } = await import('./https-server.js');
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    try {
        resetAdminAuthTarpit();
        const ownerS = await keySignIn(owner);
        const o2S = await keySignIn(owner2);
        const o3S = await keySignIn(owner3);
        assert(!!ownerS && !!o2S && !!o3S, 'three owners sign in with their keys');
        const make = (s: string | null, name: string) => call('POST', '/api/local/admin/agent/grants', { headers: asSession(s), body: { name } });
        const tOwner = await make(ownerS, 'Claude Desktop');
        const tAdmin = await make(o2S, 'Cursor');
        const tMember = await make(o3S, 'Old assistant');
        assert([tOwner, tAdmin, tMember].every((t) => t.status === 201 && typeof t.body?.token === 'string'), `each owner makes an agent token (${[tOwner, tAdmin, tMember].map((t) => t.status).join(', ')})`);

        // ── 1. The field's shape, per state ──
        console.log('── 1. server_health.addresses: every published address, what the check found, the one next step ──');
        const client = await connect(tOwner.body.token);
        const tool = (await client.listTools()).tools.find((t) => t.name === 'server_health');
        const schema = tool?.outputSchema as any;
        assert(schema?.properties?.addresses?.type === 'array' && !(schema.required ?? []).includes('addresses')
            && JSON.stringify([...(schema.required ?? [])].sort()) === JSON.stringify(TODAY_KEYS),
        `the outputSchema lists addresses, an array, and requires only what it required before (${JSON.stringify(schema?.required)})`);
        assert(/published address/.test(tool?.description ?? '') && /next step/.test(tool?.description ?? '')
            && /^Reads .+\.\nNever returns .+\.$/.test(tool?.description ?? '') && /points at/.test(/\nNever returns (.+)$/.exec(tool?.description ?? '')?.[1] ?? ''),
        `its description says it reads each published address and its next step, and never what a name points at (${JSON.stringify(tool?.description)})`);

        const h = await health(client);
        const rows: any[] = Array.isArray(h?.addresses) ? h.addresses : [];
        const byHost = new Map(rows.map((r) => [r.host, r]));
        const en = wordsFor('en');
        const words = (step: any, minutes: number | null = null) => addressNextStep(step, minutes, en);
        assert(Array.isArray(h?.addresses) && rows.length === published.length && rows.every((r) => published.includes(r.host)),
            `one row per published address, and no other (${rows.map((r) => r.host).join(', ') || JSON.stringify(h).slice(0, 200)})`);
        assert(rows[0]?.host === 'byron.beanpool.org' && rows[0]?.main === true && rows.filter((r) => r.main).length === 1,
            `the main address comes first, the only one marked main (${JSON.stringify(rows[0])})`);
        assert(rows.length > 0 && rows.every((r) => JSON.stringify(Object.keys(r).sort()) === JSON.stringify(ROW_KEYS)),
            `each row has host, kind, main, answers, checkedAt, step, nextStep and standing, nothing else (${JSON.stringify(rows.map((r) => Object.keys(r).sort().join()).filter((k, i, a) => a.indexOf(k) === i))})`);
        const expect: Array<[string, Record<string, unknown>]> = [
            ['byron.beanpool.org', { kind: 'beanpool-name', main: true, answers: 'silence', checkedAt: isoAgo(1), step: 'new-name', nextStep: words('new-name', 12) }],
            ['shire.example.org', { kind: 'own-domain', main: false, answers: 'own', checkedAt: isoAgo(2), step: 'fine', nextStep: 'Answers as this server. Nothing to do.' }],
            ['other.example.org', { kind: 'own-domain', answers: 'other', checkedAt: isoAgo(3), step: 'another-server', nextStep: en.t(ADDRESS_CHECK_WORDS.anotherServer) }],
            ['page.example.org', { kind: 'own-domain', answers: 'other-origin', step: 'something-else', nextStep: en.t(ADDRESS_CHECK_WORDS.somethingElse) }],
            ['quiet.example.org', { kind: 'own-domain', answers: 'silence', checkedAt: isoAgo(4), step: 'no-answer', nextStep: en.t(ADDRESS_CHECK_WORDS.noAnswer) }],
            ['203.0.113.5', { kind: 'number', answers: 'tls', step: 'certificate', nextStep: en.t(ADDRESS_CHECK_WORDS.certificate) }],
            ['nas.lan', { kind: 'own-domain', answers: null, checkedAt: isoAgo(5), step: 'home-network', nextStep: en.t(ADDRESS_CHECK_WORDS.homeNetwork) }],
            ['split.example.org', { kind: 'own-domain', answers: null, step: 'home-network-from-here', nextStep: en.t(ADDRESS_CHECK_WORDS.homeNetworkFromHere) }],
            ['unchecked.example.org', { kind: 'own-domain', main: false, answers: null, checkedAt: null, step: 'not-checked' }],
        ];
        for (const [host, want] of expect) {
            const got = byHost.get(host);
            const wrong = Object.entries(want).filter(([k, v]) => JSON.stringify(got?.[k]) !== JSON.stringify(v)).map(([k]) => k);
            assert(!!got && wrong.length === 0, `${host}: ${want.step}, ${JSON.stringify(want.answers)} (${wrong.length ? `wrong ${wrong.join(', ')}: ` : ''}${JSON.stringify(got)})`);
        }
        assert(/^Made 12 minutes ago\. Some networks remember 'no such name' for up to 30 minutes\. Try mobile data, or wait\.$/.test(byHost.get('byron.beanpool.org')?.nextStep ?? ''),
            `a name made 12 minutes ago that doesn't resolve yet says so, with its age, in the screen's words (${byHost.get('byron.beanpool.org')?.nextStep})`);
        const unchecked = byHost.get('unchecked.example.org')?.nextStep ?? '';
        assert(/^Not checked from this server yet: /.test(unchecked) && /every 15 minutes/.test(unchecked) && /Check now/.test(unchecked) && /Addresses/.test(unchecked),
            `an address the round hasn't reached says so, when the next check comes, and where to check now (${unchecked})`);

        // ── 2, 3. Only published addresses, and nothing beyond host, time and words ──
        console.log('── 2, 3. Only what is published; nothing beyond host, time and the words ──');
        assert(rows.length > 0 && !byHost.has('oldname.beanpool.org') && !byHost.has('localhost'), 'the former name and the loopback name are not listed, whatever the row says of them');
        const STEP_WORDS = new Set([...['fine', 'no-dns-beanpool', 'no-dns-own', 'no-answer', 'from-inside', 'another-server', 'something-else', 'certificate',
            'home-network', 'home-network-from-here', 'no-longer-ours', 'awaiting-approval', 'stopped', 'paused'].map((s) => words(s)), unchecked]);
        const strays = rows.filter((r) => !(published.includes(r.host)
            && ['beanpool-name', 'number', 'own-domain'].includes(r.kind) && typeof r.main === 'boolean'
            && [null, 'own', 'other', 'other-origin', 'silence', 'tls'].includes(r.answers)
            && (r.checkedAt === null || ISO.test(r.checkedAt))
            && r.standing === null
            && (STEP_WORDS.has(r.nextStep) || (r.step === 'new-name' && /^Made \d+ minutes? ago\./.test(r.nextStep)))));
        assert(rows.length > 0 && strays.length === 0,
            `every value is a published host, a kind, yes or no, an answer word, a time, a next step's words or no standing (${JSON.stringify(strays)})`);
        const all = JSON.stringify(h);
        const ours = nodePubkeyHex().toLowerCase();
        // The /check page's fingerprint is `····` and the key's last four: four hex digits alone could be any number here.
        const leaks = [...POINTED, ours, `····${ours.slice(-4)}`, owner.pub, SECRET_MEMBER, 'cfargotunnel', 'ownAt', '"dns"', isoAgo(400), isoAgo(500)].filter((s) => all.includes(s));
        if (/[0-9a-f]{64}/i.test(all)) leaks.push('a 64-hex key');
        if (/http/i.test(all)) leaks.push('"http"');
        assert(leaks.length === 0, `no number or name a host points at, no tunnel, key or fingerprint, no last-answered time, no member, no URL (${leaks.join(', ') || 'none'})`);
        const rowAfter = (db.prepare('SELECT value FROM node_config WHERE key = ?').get(ADDRESS_CHECK_KEY) as { value: string }).value;
        assert(rowAfter === ROW, 'reading it changed nothing in the round\'s row: it asks nothing and writes nothing');

        // ── 4. An admin's grant ──
        console.log("── 4. An admin's assistant reads it, as the admin reads the report in Settings ──");
        grantNodeRole(owner2.pub, 'admin', 'SYSTEM');
        const cAdmin = await connect(tAdmin.body.token);
        const hAdmin = await health(cAdmin);
        assert(/acting for Ottilie, who is an admin there/.test(cAdmin.getInstructions() ?? '') && hAdmin?.serverAlerts === null
            && JSON.stringify(hAdmin?.addresses) === JSON.stringify(h.addresses),
        `an admin's grant gets the same addresses an owner's does, and still no server alerts (${JSON.stringify(hAdmin?.addresses?.map((r: any) => r.host))})`);
        await cAdmin.close();

        // ── 5. A standby ──
        console.log("── 5. A standby's server_health is today's ──");
        setNodeRole('backup');
        let hStandby: any = null;
        try {
            hStandby = await health(client);
        } finally {
            setNodeRole('primary');
        }
        assert(!!hStandby && JSON.stringify(Object.keys(hStandby).sort()) === JSON.stringify(TODAY_KEYS) && !/example\.org|beanpool\.org|203\.0\.113/.test(JSON.stringify(hStandby)),
            `on a standby, server_health has today's keys and no address (${JSON.stringify(Object.keys(hStandby ?? {}).sort())})`);
        const hBack = await health(client);
        assert(Array.isArray(hBack?.addresses) && hBack.addresses.length === published.length, 'the main server again: the addresses are back');

        // ── 6. A name with a standing: never "Nothing to do" where Settings warns ──
        // Opus review of #2835 (server-addresses.ts:61): the check found this server at the name (`own`, step fine), but the
        // address service says it is nobody's, another community's, or has no record of it. Settings' report
        // (appAddressesReport, the Addresses screen's data) is read side by side with the assistant's answer, and the screen's
        // own rule (core addressStandingText, addressReachSentence) is applied to the report: the two must say the same.
        console.log('── 6. A BeanPool name the address service says is not simply ours: its standing, never "Nothing to do" ──');
        const NAME = 'byron.beanpool.org';
        const HOLDER = 'ab'.repeat(32);
        const writeRow = (key: string, value: unknown) => db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
            .run(key, JSON.stringify(value));
        writeRow(ADDRESS_CHECK_KEY, { ...checks, [NAME]: { checkedAt: ago(1), answers: 'own', ownAt: ago(1), dns: dnsSaw([], { cname: [TUNNEL] }) } });
        const setStatus = (status: string) => {
            updateNodeConfig({ registrarNames: [{ ...entry(NAME, 'current', isoAgo(12)), status }, entry('oldname.beanpool.org', 'former', isoAgo(9000))] } as any);
            forgetOwnAddresses();
        };
        const isoDay = (iso: string) => iso.slice(0, 10);
        const states: Array<{ label: string; status: string; watch: Record<string, unknown> | null; state: string | null; says: string | null; words: string | null }> = [
            {
                label: 'the address service says no community holds it', status: 'live', watch: { checkedAt: ago(1), registrar: 'free', registrarAt: ago(1) },
                state: 'at-risk', says: 'free', words: `The address service says no community holds ${NAME}. Members' apps that use it are still accepted.`,
            },
            {
                label: 'it says another community holds it, and nothing answers there', status: 'live',
                watch: { checkedAt: ago(1), registrar: 'other', registrarAt: ago(1), holderKey: HOLDER, edge: 'silence', edgeAt: ago(1) },
                state: 'at-risk', says: 'other',
                words: `The address service says another community holds ${NAME}. Members' apps that use it are still accepted. This server checks what answers there before it stops accepting it.`,
            },
            {
                label: 'it says another community holds it, but it still leads here', status: 'live',
                watch: { checkedAt: ago(1), registrar: 'other', registrarAt: ago(1), holderKey: HOLDER, edge: 'own', edgeAt: ago(1), ownAt: ago(1) },
                state: 'contradiction', says: 'other',
                words: `The address service says another community holds ${NAME}, but ${NAME} still leads to this server. It stays accepted.`,
            },
            {
                label: 'it has no record of it (an address service that lost its data)', status: 'none', watch: null,
                state: 'at-risk', says: 'none', words: `The address service has no record of ${NAME}. Members' apps that use it are still accepted.`,
            },
            {
                label: 'it says the name is this community\'s (nothing to say)', status: 'live',
                watch: { checkedAt: ago(1), registrar: 'you', registrarAt: ago(1), state: 'live', entryAtYou: 'current/live' },
                state: null, says: null, words: null,
            },
        ];
        try {
            for (const c of states) {
                setStatus(c.status);
                if (c.watch) writeRow(NAME_WATCH_KEY, { [NAME]: c.watch });
                else db.prepare('DELETE FROM node_config WHERE key = ?').run(NAME_WATCH_KEY);
                const settings = appAddressesReport().addresses.find((a: any) => a.address === NAME) as any;
                const got = ((await health(client))?.addresses ?? []).find((r: any) => r.host === NAME);
                assert((settings?.standing?.state ?? null) === c.state && settings?.reach?.step === 'fine',
                    `${c.label}: Settings' report has standing ${c.state} and the check found this server (${JSON.stringify({ standing: settings?.standing, step: settings?.reach?.step })})`);
                if (c.state === null) {
                    assert(got?.standing === null && got?.nextStep === en.t(ADDRESS_CHECK_WORDS.fine) && got?.step === 'fine',
                        `${c.label}: no standing, and the next step is the check's own "Nothing to do" (${JSON.stringify(got)})`);
                    continue;
                }
                const screenWords = addressStandingText(settings, isoDay)?.text;
                const screenStep = addressReachSentence(settings.reach.step, settings.reach.minutes, true, en);
                assert(got?.standing?.state === settings.standing.state && got?.standing?.registrarSays === settings.standing.registrarSays
                    && got?.standing?.registrarSays === c.says,
                `${c.label}: the assistant reads standing ${c.state}, the address service saying ${c.says}, as Settings does (${JSON.stringify(got?.standing)})`);
                assert(got?.standing?.words === c.words && got?.standing?.words === screenWords,
                    `${c.label}: in the Addresses screen's words, which say what to do (${JSON.stringify(got?.standing?.words)})`);
                assert(!!got && !/Nothing to do/i.test(got.nextStep) && got.nextStep === screenStep && got.nextStep === en.t(ADDRESS_SCREEN_WORDS.reachFine),
                    `${c.label}: the next step is the screen's "${screenStep}", never "Nothing to do" (${JSON.stringify(got?.nextStep)})`);
                assert(!JSON.stringify(got).includes(HOLDER), `${c.label}: never the key the address service named`);
            }
        } finally {
            setStatus('live');
            db.prepare('DELETE FROM node_config WHERE key = ?').run(NAME_WATCH_KEY);
            writeRow(ADDRESS_CHECK_KEY, checks);
        }
        // A minute may have passed since section 1: the new name's age in its next step is the one thing that can move.
        const settled = (rows: any[] | undefined) => JSON.stringify((rows ?? []).map((r: any) => ({ ...r, nextStep: undefined })));
        const hRestored = await health(client);
        assert(Array.isArray(hRestored?.addresses) && settled(hRestored.addresses) === settled(h.addresses) && hRestored.addresses.every((r: any) => r.standing === null),
            'the name as it was: the addresses read as at the start, none with a standing');

        // ── 7. A member's grant ──
        console.log("── 7. A grant whose maker is a member now gets what it got before: nothing ──");
        revokeNodeRole(owner3.pub, 'owner', owner.pub);
        const memberCall = await call('POST', '/mcp', {
            headers: { Accept: 'application/json, text/event-stream', ...bearer(tMember.body.token) },
            body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'server_health', arguments: {} } },
        });
        assert(memberCall.status === 401 && !memberCall.body?.result && !/example\.org|beanpool\.org|addresses/.test(memberCall.text),
            `its maker no longer an owner or admin: 401, and not a word of the addresses (${show(memberCall)})`);
        await client.close();

        // The table the server runs: the tool is the same row everyone reads (no second tool for this).
        assert(AGENT_TOOLS.filter((t) => /published address/.test(t.reads)).map((t) => t.name).join() === 'server_health',
            'server_health is the one tool that reads the addresses');

        // ── 8. The operator manual's AI page says so (design §5.3; Opus review of #2835, tools.ts:316) ──
        // The page owners read of what an assistant reads, which is also what goes to the company that runs it.
        console.log("── 8. The operator manual's AI page lists the addresses under Health ──");
        const aiPage = fs.readFileSync(new URL('../../../packages/beanpool-guide/operators/server/ai-assistant.md', import.meta.url), 'utf8');
        const healthLine = /^- \*\*Health\*\*: .*$/m.exec(aiPage)?.[0] ?? '';
        assert(/each address the community publishes/.test(healthLine) && /main one/.test(healthLine) && /last checked/.test(healthLine)
            && /next step/.test(healthLine) && /what the address service says and what to do/.test(healthLine)
            && /Never what an address points at, or a server's key\./.test(healthLine),
        `its Health line names each published address, the main one, what the last check found, the next step, a name's standing, and never what it points at (${healthLine.slice(0, 120)}…)`);
        const neverSees = /## What it never sees\n\n(.*)$/m.exec(aiPage)?.[1] ?? '';
        assert(neverSees.startsWith('Messages and chats, balances, keys, any address but the community\'s own (under Health, above), photos,')
            && !/keys, addresses,/.test(neverSees),
        `its "What it never sees" no longer says an assistant never sees any address, but which (${neverSees.slice(0, 120)}…)`);
    } catch (e) {
        console.error(e);
        process.exitCode = 1;
    } finally {
        console.log(`\n${passed}/${run} passed`);
        process.exit(process.exitCode ?? 0);
    }
}

main().catch((e) => { console.error(e); console.log(`\n${passed}/${run} passed`); process.exit(1); });
