/**
 * Every writer of a member's name takes the one name rule, over REAL HTTP (review of #1956: N3, N3b).
 *
 *   1. A visitor's row (registerVisitor, which the federation paths call) takes a name from a peer only while it is free,
 *      and a peer never renames a member who named themselves "Visitor-…".
 *   2. A Commons project's and a crowdfund's title edit, to a member's name in another case: the enterprise row gets a name
 *      of its own (the title with "-" and the id's first six, as a create on a clash), never a database error.
 *   3. A member holding a key's "Visitor-<first 8>" (names are not reserved, and a key's first 8 are public): a member
 *      still opens a conversation with that key, and every federation path still makes its row, by no name or a taken
 *      one, under a "Visitor-…" name free by the one rule (deciding review of #1977, B1).
 *   4. A project's suffixed name is checked too: with "Rake" and "Rake-<first six of the id>" held, an edit to "Rake"
 *      lengthens the id part (N1).
 *   5. A peer's name is cut to a member's 32 characters (N5).
 *
 * (A restore by name, which this suite also read, was deleted in S3: the lookup listing two accounts whose names fold the
 * same, a collect naming one of their keys, a visitor's or an enterprise's row beside a member. A restore finds its
 * account from a verified sign-in, never a name: test-recovery-find.)
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-name-writers.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME; // self-signed / LAN mode

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, generateInvite } from './state-engine.js';
import { startHttpsServer, resetAdminRateLimit } from './https-server.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { registerVisitor } from './engine/members.js';
import { foldName } from '@beanpool/engine';
import { db } from './db/db.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

let BASE = '';
type Id = { pk: string; priv: crypto.KeyObject };
type Res = { status: number; body: any };

function keypair(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey };
}

function resetLimits(): void {
    resetGatewayRateLimit();
    resetAdminRateLimit();
    pruneAuthAttempts(Date.now() + 120_000);
}

async function call(method: string, id: Id | null, path: string, body?: unknown): Promise<Res> {
    resetLimits();
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = signRequest(id.priv, { method, path: path.split('?')[0], timestamp: ts, nonce, body: bodyString });
        headers[SIGNED_FOR_HEADER] = signedForHost();
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? bodyString : undefined });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

let founder: Id;

/** Joins by a fresh invite, signed by the joining key, as a phone does. */
async function join(callsign: string): Promise<Id> {
    const id = keypair();
    const code = generateInvite(founder.pk)!.code;
    const res = await call('POST', id, '/api/invite/redeem', { code, publicKey: id.pk, callsign });
    if (res.status !== 200) throw new Error(`join ${callsign}: ${res.status} ${JSON.stringify(res.body)}`);
    return id;
}

/** No other live row holds a name that folds the same as `pk`'s. */
const foldsAlone = (pk: string): boolean => !db.prepare(`SELECT 1 FROM members a JOIN members b ON b.callsign_fold = a.callsign_fold
    WHERE a.public_key = ? AND b.public_key != a.public_key AND b.status NOT IN ('migrated', 'pruned') LIMIT 1`).get(pk);
const nameOf = (pk: string) => (db.prepare('SELECT callsign FROM members WHERE public_key = ?').get(pk) as { callsign: string } | undefined)?.callsign;
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body?.error ?? '')}`;

async function main(): Promise<void> {
    console.log('Every writer of a name takes the one name rule\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    founder = keypair();
    seedGenesisMember(founder.pk, 'Founder');

    // Cyrillic, where it matters: the older unique index on lower(callsign) folds A–Z only, so a writer that skips the
    // rule writes "ДАША" beside "Даша" without a word, and "MARISOL" beside "Marisol" fails with a raw database error.
    const dasha = await join('Даша');

    console.log('— 1. a visitor\'s row from a peer —');
    await join('Marisol');
    const v1 = keypair().pk, v2 = keypair().pk, v3 = keypair().pk;
    const visit = (pk: string, name: string | undefined): string => {
        try { registerVisitor(pk, name, 'https://peer.example'); return ''; } catch (e) { return (e as Error).message; }
    };
    const e1 = visit(v1, 'даша');
    assert(!e1 && nameOf(v1) === `Visitor-${v1.slice(0, 8)}`, `a peer naming its member "даша" beside the member "Даша" leaves the visitor "Visitor-…" (got "${nameOf(v1)}"${e1 ? `, ${e1}` : ''})`);
    const e3 = visit(v3, 'MARISOL');
    assert(!e3 && nameOf(v3) === `Visitor-${v3.slice(0, 8)}`, `a peer naming its member "MARISOL" beside "Marisol" leaves the visitor "Visitor-…", no database error (got "${nameOf(v3)}"${e3 ? `, ${e3}` : ''})`);
    registerVisitor(v2, null as unknown as string, 'https://peer.example');
    assert(nameOf(v2) === `Visitor-${v2.slice(0, 8)}`, `a peer sending no name (null) leaves the visitor "Visitor-…", never "null" (got "${nameOf(v2)}")`);
    visit(v2, ' Wanderer ');
    assert(nameOf(v2) === 'Wanderer', `a free name from a peer is kept, trimmed (got "${nameOf(v2)}")`);
    const e4 = visit(v1, 'wanderer');
    assert(!e4 && nameOf(v1) === `Visitor-${v1.slice(0, 8)}`, `a "Visitor-…" row is not renamed to another visitor's name (got "${nameOf(v1)}"${e4 ? `, ${e4}` : ''})`);
    visit(v1, 'Roamer');
    assert(nameOf(v1) === 'Roamer', `a "Visitor-…" row takes a free name (got "${nameOf(v1)}")`);
    const placeholderMember = await join('Visitor-abc');
    visit(placeholderMember.pk, 'Somebody New');
    assert(nameOf(placeholderMember.pk) === 'Visitor-abc', `a member who named themselves "Visitor-abc" is not renamed by a peer (got "${nameOf(placeholderMember.pk)}")`);
    assert(nameOf(dasha.pk) === 'Даша', `and the member "Даша" keeps that name throughout (got "${nameOf(dasha.pk)}")`);

    console.log('\n— 2. a project\'s and a crowdfund\'s title edits —');
    const proposed = await call('POST', founder, '/api/commons/projects', { title: 'Seed Library', description: 'Seeds', requestedAmount_c: 5000 });
    const projectId = proposed.body?.project?.id as string | undefined;
    assert(proposed.status === 200 && !!projectId && nameOf(projectId) === 'Seed Library', `a Commons project is proposed with its title as its name (got ${proposed.status}, "${projectId && nameOf(projectId)}")`);
    if (projectId) {
        const edit = await call('POST', founder, '/api/commons/projects/update', { projectId, title: 'ДАША', description: 'Seeds', requestedAmount_c: 5000 });
        const row = nameOf(projectId) ?? '';
        assert(edit.status === 200 && foldName(row) !== foldName('Даша') && row === `ДАША-${projectId.slice(0, 6)}`,
            `a Commons project's title edit to "ДАША" names its row "ДАША-<id>", not the member's name (got ${show(edit)}, "${row}")`);
        const commons = (db.prepare(`SELECT value FROM node_config WHERE key = 'commons_projects'`).get() as { value: string }).value;
        assert((JSON.parse(commons) as any[]).find((p) => p.id === projectId)?.title === 'ДАША', `the project keeps the title "ДАША" as typed`);
        const ascii = await call('POST', founder, '/api/commons/projects/update', { projectId, title: 'MARISOL', description: 'Seeds', requestedAmount_c: 5000 });
        assert(ascii.status === 200 && nameOf(projectId) === `MARISOL-${projectId.slice(0, 6)}`,
            `a title edit to "MARISOL" beside "Marisol" saves, with the row "MARISOL-<id>", no database error (got ${show(ascii)}, "${nameOf(projectId)}")`);
        const back = await call('POST', founder, '/api/commons/projects/update', { projectId, title: 'Seed Library Two', description: 'Seeds', requestedAmount_c: 5000 });
        assert(back.status === 200 && nameOf(projectId) === 'Seed Library Two', `a free title is its row's name again (got "${nameOf(projectId)}")`);
    }
    const created = await call('POST', founder, '/api/crowdfund/projects', { title: 'Tool Shed', description: 'Tools', goalAmount_c: 10000 });
    const crowdId = created.body?.project?.id as string | undefined;
    assert(created.status === 200 && !!crowdId && nameOf(crowdId) === 'Tool Shed', `a crowdfund is created with its title as its name (got ${show(created)}, "${crowdId && nameOf(crowdId)}")`);
    if (crowdId) {
        const edit = await call('POST', founder, '/api/crowdfund/projects/update', { id: crowdId, title: 'даша', description: 'Tools', goalAmount_c: 10000 });
        const row = nameOf(crowdId) ?? '';
        assert(edit.status === 200 && row === `даша-${crowdId.slice(0, 6)}`, `a crowdfund's title edit to "даша" names its row "даша-<id>" (got ${show(edit)}, "${row}")`);
        // A crowdfund shows its row's name as its title, so it reads as a create on a clash reads (createCrowdfundProject).
        assert(edit.body?.project?.title === row, `the crowdfund reads as "даша-<id>", as a create on a clash does (got "${edit.body?.project?.title}")`);
        const withDeadline = await call('POST', founder, '/api/crowdfund/projects/update', { id: crowdId, title: 'marisol', description: 'Tools', goalAmount_c: 10000, deadlineAt: null });
        assert(withDeadline.status === 200 && nameOf(crowdId) === `marisol-${crowdId.slice(0, 6)}`,
            `an edit that also sets the deadline, to "marisol", saves with the row "marisol-<id>", no database error (got ${show(withDeadline)}, "${nameOf(crowdId)}")`);
    }

    console.log('\n— 3. a member holding a key\'s "Visitor-…" name —');
    const k = keypair();
    await join(`Visitor-${k.pk.slice(0, 8)}`);
    const dm = await call('POST', founder, '/api/messages/conversation', { type: 'dm', participants: [founder.pk, k.pk], createdBy: founder.pk });
    assert(dm.status === 200 && nameOf(k.pk) === `Visitor-${k.pk.slice(0, 12)}` && foldsAlone(k.pk),
        `a member still opens a conversation with a key whose "Visitor-<first 8>" a member holds; its row is "Visitor-<first 12>" (got ${show(dm)}, "${nameOf(k.pk) ?? '(no row)'}")`);
    const k2 = keypair().pk;
    await join(`Visitor-${k2.slice(0, 8)}`);
    await join(`Visitor-${k2.slice(0, 12)}`);
    const e5 = visit(k2, undefined);
    assert(!e5 && nameOf(k2) === `Visitor-${k2.slice(0, 16)}` && foldsAlone(k2),
        `a peer naming no name, with "Visitor-<first 8>" and "<first 12>" held, makes the row "Visitor-<first 16>" (got "${nameOf(k2) ?? '(no row)'}"${e5 ? `, ${e5}` : ''})`);
    const k3 = keypair().pk;
    await join(`VISITOR-${k3.slice(0, 8).toUpperCase()}`);
    const e6 = visit(k3, 'MARISOL');
    assert(!e6 && nameOf(k3) === `Visitor-${k3.slice(0, 12)}` && foldsAlone(k3),
        `a peer naming a taken name, with "VISITOR-<FIRST 8>" held in capitals, makes the row "Visitor-<first 12>" (got "${nameOf(k3) ?? '(no row)'}"${e6 ? `, ${e6}` : ''})`);

    console.log('\n— 4. a project\'s suffixed name is checked too —');
    const shed = await call('POST', founder, '/api/crowdfund/projects', { title: 'Garden Shed', description: 'Shed', goalAmount_c: 10000 });
    const shedId = shed.body?.project?.id as string | undefined;
    if (shedId) {
        await join('Rake');
        await join(`Rake-${shedId.slice(0, 6)}`);
        const rake = await call('POST', founder, '/api/crowdfund/projects/update', { id: shedId, title: 'Rake', description: 'Shed', goalAmount_c: 10000 });
        assert(rake.status === 200 && nameOf(shedId) === `Rake-${shedId.slice(0, 8)}` && foldsAlone(shedId),
            `with "Rake" and "Rake-<first six>" held, an edit to "Rake" names the row "Rake-<first eight>" (got ${show(rake)}, "${nameOf(shedId)}")`);
    } else assert(false, `a crowdfund is created for the suffix case (got ${show(shed)})`);

    console.log('\n— 5. a peer\'s long name —');
    const longName = `${'Ana'.repeat(10)} Long Name From Afar`;
    const v4 = keypair().pk;
    visit(v4, longName);
    assert(nameOf(v4) === longName.slice(0, 32).trim(), `a peer's ${longName.length}-character name is cut to a member's 32 (got ${nameOf(v4)?.length} characters)`);

    console.log(`\n${passed}/${run} passed`);
}

main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(e); process.exit(1); });
