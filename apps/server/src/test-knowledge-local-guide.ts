/**
 * Local knowledge, slice K8 "recognition", the node: the Local guide badge, through the real HTTPS stack and its signature
 * middleware (scratch/fable-design/DESIGN-local-knowledge-fable.md §2.10, §4.1 "On the wire", §8 K8; the amendment leaves K8 as
 * it is). Thank itself is the apps' (it opens the ordinary Send form): the node changes nothing about sending.
 *
 *  1. The rule: LOCAL_GUIDE_PAGES pages showing now, written by the member, each helped by LOCAL_GUIDE_HELPED counted members.
 *     Two used pages are not enough; a page helped twice doesn't count; the third used page earns it.
 *  2. Close the class: every way a page stops counting (a tap taken back, gathered with the assistant, hidden by reports, taken
 *     down, Learn switched off) x the badge on both places it shows -> it goes, with no other write; back where it can come back.
 *  3. The wire: the trust profile's `badges` (`['local-guide']` or `[]`, to any member who reads it); `writerLocalGuide` on a
 *     member's signed read by id alone, never on a list, a sync or a page gathered with the assistant.
 *  4. Nothing paid: no ledger row, ever; nothing stored (no table, no column).
 *
 * Run: mkdir -p .th && TMPDIR=.th SERVER_SUITES_ONLY="test-knowledge-local-guide" node ../../scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import { LOCAL_GUIDE_HELPED, LOCAL_GUIDE_PAGES } from '@beanpool/core';
import { ensureGenesis } from './genesis.js';
import { initTls } from './services/tls.js';
import { initStateEngine, broadcast } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { NODE_PROFILE_KEY, getProfileSwitches } from './config/node-profile.js';
import { registerMemberInternal } from './engine/members.js';
import { grantNodeRole } from './engine/node-roles.js';
import { claimGrantor } from './claim-code.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { publishKnowledge } from './engine/knowledge.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
function require_(cond: unknown, msg: string): void {
    assert(cond, msg);
    if (!cond) throw new Error(`setup failed: ${msg}`);
}

interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}

interface Res { status: number; body: any; text: string }
async function call(id: Id | null, method: 'GET' | 'POST', urlPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const h: Record<string, string> = { ...headers };
    if (method !== 'GET') h['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        h['X-Public-Key'] = id.pk;
        h['X-Signature'] = signRequest(id.priv, { method, path: urlPath.split('?')[0], timestamp: ts, nonce, body: raw });
        h[SIGNED_FOR_HEADER] = signedForHost();
        h['X-Timestamp'] = String(ts);
        h['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${urlPath}`, { method, headers: h, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    return { status: res.status, body: parsed, text };
}
const show = (r: Res | null) => (r ? `${r.status} ${r.text.slice(0, 220)}` : '-');

const PAGE = {
    title: 'How recycling works at the tip',
    body: 'Bring glass, cans and paper sorted.',
    topic: 'local-services',
    place: null,
    sources: [{ url: 'https://council.example/waste', label: 'Council waste page' }],
    lang: 'en',
};
const helped = (id: Id, post: string, on = true) => call(id, 'POST', `/api/knowledge/posts/${post}/helped`, { on });
const ledgerRows = () => (db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n;
const tables = () => (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n;
const setOverride = (name: string, value: string) =>
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`${NODE_PROFILE_KEY}.${name}`, value);
const dropOverride = (name: string) => db.prepare('DELETE FROM node_config WHERE key = ?').run(`${NODE_PROFILE_KEY}.${name}`);

async function main(): Promise<void> {
    await ensureGenesis();
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const owen = newId('Owen');
    const claim = claimGrantor(crypto.randomBytes(4).toString('hex'));
    require_(!!registerMemberInternal(broadcast, owen.pk, owen.name, null, claim), 'Owen claims the community: its first member');
    grantNodeRole(owen.pk, 'owner', claim);
    const [wes, mel, pat, ida, kit] = ['Wes', 'Mel', 'Pat', 'Ida', 'Kit'].map(newId);
    for (const who of [wes, mel, pat, ida, kit]) {
        const made = await call(owen, 'POST', '/api/invite/generate', { publicKey: owen.pk });
        const joined = await call(who, 'POST', '/api/invite/redeem', { code: made.body?.invite?.code, publicKey: who.pk, callsign: who.name });
        require_(made.status === 200 && joined.status === 200, `${who.name} joins with Owen's invite`);
    }
    for (const who of [owen, wes, mel, pat, ida, kit]) db.prepare("UPDATE members SET avatar_ref = 'bundled://fox' WHERE public_key = ?").run(who.pk);
    require_(getProfileSwitches().knowledge === true, 'Learn is on here (a local community)');
    require_(LOCAL_GUIDE_PAGES === 3 && LOCAL_GUIDE_HELPED === 3, "the design's numbers: 3 pages, each helped by 3 members");
    const TAPPERS = [mel, pat, ida];

    /** The badge as both places show it: the trust profile, and the writer's line of `page` on a member's read by id. */
    const badgeOn = async (subject: Id, page: string, reader: Id = kit) => {
        const profile = await call(reader, 'POST', '/api/trust/profile', { targetPubkey: subject.pk });
        const read = await call(reader, 'GET', `/api/marketplace/posts?type=knowledge&id=${page}`);
        const k = Array.isArray(read.body) ? read.body.find((p: any) => p?.id === page)?.knowledge : undefined;
        return { profile: profile.body?.badges, line: k?.writerLocalGuide, raw: `${show(profile)} | ${show(read)}` };
    };
    const ledger0 = ledgerRows();
    const tables0 = tables();

    // ── 1. The rule ──────────────────────────────────────────────────────────────────────────────
    console.log('── 1. the rule ──');
    const pages: string[] = [];
    const usePage = async (n: number) => {
        const id = publishKnowledge(broadcast, owen.pk, { ...PAGE, title: `Page ${n} by Wes` }, { writer: wes.pk }).id;
        pages.push(id);
        for (const who of TAPPERS) require_((await helped(who, id)).status === 200, `${who.name} taps "This helped" on Wes's page ${n}`);
        return id;
    };
    const P1 = await usePage(1);
    let b = await badgeOn(wes, P1);
    assert(JSON.stringify(b.profile) === '[]' && b.line === false, `1. one used page: no badge, on the profile or the writer's line (${b.raw})`);
    await usePage(2);
    b = await badgeOn(wes, P1);
    assert(JSON.stringify(b.profile) === '[]' && b.line === false, '1. two used pages: still none');
    // A third page helped twice: not used, so not counted.
    const P3 = publishKnowledge(broadcast, owen.pk, { ...PAGE, title: 'Page 3 by Wes' }, { writer: wes.pk }).id;
    for (const who of [mel, pat]) require_((await helped(who, P3)).status === 200, `${who.name} taps Wes's page 3`);
    b = await badgeOn(wes, P3);
    assert(JSON.stringify(b.profile) === '[]' && b.line === false, `1. a third page helped by two: not used, still none (${b.raw})`);
    require_((await helped(ida, P3)).status === 200, 'Ida taps page 3: its third');
    b = await badgeOn(wes, P3);
    assert(JSON.stringify(b.profile) === '["local-guide"]' && b.line === true, `1. three used pages: Local guide, on the profile and the writer's line (${b.raw})`);
    const fromOwen = await badgeOn(wes, P1, owen);
    assert(JSON.stringify(fromOwen.profile) === '["local-guide"]' && fromOwen.line === true, '1. the same to an owner: it is no secret and no privilege');
    const own = await badgeOn(wes, P1, wes);
    assert(JSON.stringify(own.profile) === '["local-guide"]' && own.line === true, '1. and to Wes himself, on his own profile and page');
    const other = await badgeOn(mel, P1);
    assert(JSON.stringify(other.profile) === '[]', "1. a member who wrote nothing: an empty list, never a missing one (Mel's profile)");

    // ── 2. Close the class: each way a page stops counting x both places ────────────────────────────
    console.log('── 2. every way it goes ──');
    const ways: Array<{ name: string; go: () => Promise<void> | void; back?: () => Promise<void> | void }> = [
        { name: 'a tap taken back (helped by two)', go: async () => { require_((await helped(ida, P3, false)).status === 200, 'Ida takes her tap back'); },
            back: async () => { require_((await helped(ida, P3)).status === 200, 'Ida taps again'); } },
        { name: 'hidden by reports', go: () => { db.prepare('UPDATE posts SET hidden_by_reports_at = ? WHERE id = ?').run(new Date().toISOString(), P3); },
            back: () => { db.prepare('UPDATE posts SET hidden_by_reports_at = NULL WHERE id = ?').run(P3); } },
        { name: 'Learn switched off by the owners', go: () => { setOverride('knowledge', 'false'); }, back: () => { dropOverride('knowledge'); } },
    ];
    for (const way of ways) {
        await way.go();
        const ledgerNow = ledgerRows();
        const profile = await call(kit, 'POST', '/api/trust/profile', { targetPubkey: wes.pk });
        assert(JSON.stringify(profile.body?.badges) === '[]', `2. ${way.name}: the profile's badge goes (${show(profile)})`);
        if (way.name.startsWith('Learn switched off')) {
            const read = await call(kit, 'GET', `/api/marketplace/posts?type=knowledge&id=${P1}`);
            assert(read.status === 200 && Array.isArray(read.body) && read.body.length === 0, '2. Learn off: no page is read, so no writer\'s line either');
        } else {
            const line = await badgeOn(wes, P1);
            assert(line.line === false, `2. ${way.name}: the writer's line on his other pages loses it too (${line.raw})`);
        }
        assert(ledgerRows() === ledgerNow, `2. ${way.name}: no ledger row`);
        await way.back?.();
        const again = await badgeOn(wes, P1);
        assert(JSON.stringify(again.profile) === '["local-guide"]' && again.line === true, `2. ${way.name}, undone: it is back, worked out again, nothing stored`);
    }
    // Taken down: for good. The badge goes with it until a third page is used again.
    const down = await call(owen, 'POST', `/api/knowledge/posts/${P3}/take-down`, { reasonCategory: 'other' });
    require_(down.status === 200, `Owen takes page 3 down (${show(down)})`);
    b = await badgeOn(wes, P1);
    assert(JSON.stringify(b.profile) === '[]' && b.line === false, `2. a page taken down: the badge goes (${b.raw})`);
    await usePage(4);
    b = await badgeOn(wes, P1);
    assert(JSON.stringify(b.profile) === '["local-guide"]' && b.line === true, '2. a new third used page: back');

    // Gathered with the assistant: Owen's own two used pages and one gathered page are not three of his own.
    const ownPages = [] as string[];
    for (const n of [1, 2]) {
        const id = publishKnowledge(broadcast, owen.pk, { ...PAGE, title: `Owen's page ${n}` }).id;
        for (const who of TAPPERS) require_((await helped(who, id)).status === 200, `${who.name} taps Owen's page ${n}`);
        ownPages.push(id);
    }
    const G = publishKnowledge(broadcast, owen.pk, { ...PAGE, title: 'Gathered with the assistant' }, { createdVia: 'assistant-draft:grant-test' }).id;
    for (const who of TAPPERS) require_((await helped(who, G)).status === 200, `${who.name} taps the gathered page`);
    require_((db.prepare('SELECT knowledge_helped AS n, created_via AS via FROM posts WHERE id = ?').get(G) as any)?.n === 3, 'the gathered page is used');
    const owenB = await badgeOn(owen, ownPages[0]);
    assert(JSON.stringify(owenB.profile) === '[]' && owenB.line === false, `2. two own used pages and one gathered: no badge (${owenB.raw})`);
    const gRead = await call(kit, 'GET', `/api/marketplace/posts?type=knowledge&id=${G}`);
    const gK = Array.isArray(gRead.body) ? gRead.body[0]?.knowledge : undefined;
    assert(gK?.gathered === true && !('writerLocalGuide' in (gK ?? {})), `2. a gathered page's read carries no writer's badge at all (${show(gRead)})`);

    // ── 3. The wire: by id alone ──────────────────────────────────────────────────────────────────
    console.log('── 3. the wire ──');
    const list = await call(kit, 'GET', '/api/marketplace/posts?type=knowledge');
    const sync = await call(kit, 'GET', `/api/marketplace/posts?types=offer,need,knowledge&updatedAfter=${encodeURIComponent('2000-01-01T00:00:00.000Z')}`);
    const carries = (r: Res) => Array.isArray(r.body) ? r.body.some((p: any) => p?.knowledge && 'writerLocalGuide' in p.knowledge)
        : Array.isArray(r.body?.posts) ? r.body.posts.some((p: any) => p?.knowledge && 'writerLocalGuide' in p.knowledge) : null;
    assert(list.status === 200 && carries(list) === false, `3. a list read carries no writer's badge (${show(list)})`);
    assert(sync.status === 200 && carries(sync) === false, `3. a sync read carries none either, so no copy keeps one (${show(sync)})`);
    const ids = await call(kit, 'GET', `/api/marketplace/posts?type=knowledge&ids=${[P1, ownPages[0]].join(',')}`);
    const byIds = new Map((Array.isArray(ids.body) ? ids.body : []).map((p: any) => [p.id, p.knowledge?.writerLocalGuide]));
    assert(byIds.get(P1) === true && byIds.get(ownPages[0]) === false, `3. an ids= read: each page its own writer's answer (${show(ids)})`);
    const unsigned = await call(null, 'GET', `/api/marketplace/posts?type=knowledge&id=${P1}`);
    assert(!(Array.isArray(unsigned.body) && unsigned.body.some((p: any) => p?.knowledge)), `3. an unsigned read gets no page, so no badge (${show(unsigned)})`);
    const noTarget = await call(null, 'POST', '/api/trust/profile', { targetPubkey: wes.pk });
    assert(noTarget.status === 401 && noTarget.body?.badges === undefined, '3. an unsigned trust profile read is refused, as before');

    // ── 4. Nothing paid, nothing stored ────────────────────────────────────────────────────────────
    console.log('── 4. nothing paid ──');
    assert(ledgerRows() === ledger0, `4. no ledger row from any of it (${ledger0} → ${ledgerRows()})`);
    assert(tables() === tables0, '4. no table made: the badge is worked out when read');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
