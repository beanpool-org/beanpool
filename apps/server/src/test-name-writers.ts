/**
 * Every writer of a member's name takes the one name rule, and a sign-in restore by name reaches the account the device
 * chose, over REAL HTTP (review of #1956: N3, N3b, and the queued "collect takes the looked-up key").
 *
 *   1. Two accounts whose names fold the same (kept, never renamed, by #1956's migration): the lookup lists both, a
 *      collect that names one of the keys it listed opens a session for THAT account, one with no key (an app from before)
 *      is refused as ambiguous as it was, and a key the name does not hold, a visitor's key, or a key that is not a string
 *      opens nothing.
 *   2. A visitor's row holding a member's name in another case (as one written before this change can hold it): the member's restore by name
 *      still opens, and the lookup lists the member alone.
 *   3. A visitor's row (registerVisitor, which the federation paths call) takes a name from a peer only while it is free,
 *      and a peer never renames a member who named themselves "Visitor-…".
 *   4. A Commons project's and a crowdfund's title edit, to a member's name in another case: the enterprise row gets a name
 *      of its own (the title with "-" and the id's first six, as a create on a clash), never a database error, and the
 *      member's restore by name still opens.
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
import { collectionState } from './engine/recovery-release.js';
import { foldName } from '@beanpool/engine';
import { db } from './db/db.js';

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
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`), id.priv).toString('base64');
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

/** A sign-in copy, so the lookup lists the account and a collect can open (as test-callsign-any-alphabet seeds one). */
function giveSignInCopy(pk: string): void {
    db.prepare(`INSERT INTO recovery_shares (owner_pubkey, holder_type, holder_ref, share_index, encrypted_share, share_iv, share_tag, generation)
                VALUES (?, 'sso', 'google', 1, 'x', 'y', 'z', 1)`).run(pk);
}

/** A row as a node from before #1956 (or before this change) may hold it: written straight in, its name unchecked. */
function rowAsBefore(callsign: string, visitor: boolean): string {
    const pk = keypair().pk;
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, is_visitor) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(pk, callsign, new Date().toISOString(), visitor ? null : founder.pk, visitor ? null : 'before', visitor ? 1 : 0);
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
    return pk;
}

const nameOf = (pk: string) => (db.prepare('SELECT callsign FROM members WHERE public_key = ?').get(pk) as { callsign: string } | undefined)?.callsign;
const lookup = async (name: string) => call('GET', null, `/api/recovery/lookup/${encodeURIComponent(name)}`);
const lookedUpKeys = (r: Res): string[] => (Array.isArray(r.body) ? r.body.map((c: any) => c.publicKey) : []);

/** A collect by a fresh device; the account the session it opened is for, if it opened one. */
async function collect(body: Record<string, unknown>): Promise<{ res: Res; owner: string | undefined }> {
    const res = await call('POST', keypair(), '/api/recovery/collect', body);
    const id = res.body?.collectionId;
    return { res, owner: typeof id === 'string' ? collectionState(id)?.collection.ownerPubkey : undefined };
}

const show = (r: Res) => `${r.status} ${JSON.stringify(r.body?.error ?? '')}`;

async function main(): Promise<void> {
    console.log('Every writer of a name takes the one name rule; a restore reaches the chosen account\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    founder = keypair();
    seedGenesisMember(founder.pk, 'Founder');

    console.log('— 1. two accounts whose names fold the same —');
    const upper = rowAsBefore('Олег', false);
    const lower = rowAsBefore('олег', false);
    const other = await join('Someone Else');
    const guest = rowAsBefore('Wayfarer', true);
    for (const pk of [upper, lower, other.pk, guest]) giveSignInCopy(pk);
    const both = lookedUpKeys(await lookup('олег'));
    assert(both.length === 2 && both.includes(upper) && both.includes(lower), `the lookup for "олег" lists both accounts (got ${both.length})`);
    const old = await collect({ callsign: 'олег' });
    assert(old.res.status === 409 && !old.owner, `a collect with no key (an app from before) is refused as ambiguous, as it was (got ${show(old.res)})`);
    const a = await collect({ callsign: 'олег', candidatePublicKey: upper });
    assert(a.res.status === 200 && a.owner === upper, `a collect naming "Олег"'s key opens a session for "Олег" (got ${show(a.res)}, ${a.owner === upper ? 'theirs' : 'not theirs'})`);
    const b = await collect({ callsign: 'ОЛЕГ', candidatePublicKey: lower });
    assert(b.res.status === 200 && b.owner === lower, `a collect naming "олег"'s key opens a session for "олег" (got ${show(b.res)}, ${b.owner === lower ? 'theirs' : 'not theirs'})`);
    const nobody = await collect({ callsign: 'Missing Name' });
    const notHeld = await collect({ callsign: 'олег', candidatePublicKey: other.pk });
    assert(notHeld.res.status === 400 && !notHeld.owner && notHeld.res.body?.error === nobody.res.body?.error,
        `a key the name does not hold opens nothing, with the answer a name nobody holds gets (got ${show(notHeld.res)})`);
    const notString = await collect({ callsign: 'олег', candidatePublicKey: 42 });
    assert(notString.res.status === 400 && !notString.owner, `a key that is not a string opens nothing (got ${show(notString.res)})`);
    const visitorsKey = await collect({ callsign: 'Wayfarer', candidatePublicKey: guest });
    assert(visitorsKey.res.status === 400 && !visitorsKey.owner, `a visitor's own name and key open nothing (got ${show(visitorsKey.res)})`);
    const single = await collect({ callsign: 'someone else', candidatePublicKey: other.pk });
    const singleOld = await collect({ callsign: 'Someone Else' });
    assert(single.res.status === 200 && single.owner === other.pk && singleOld.res.status === 200 && singleOld.owner === other.pk,
        `a name one account holds opens for it with its key and without one (got ${show(single.res)} / ${show(singleOld.res)})`);

    // Cyrillic, where it matters: the older unique index on lower(callsign) folds A–Z only, so a writer that skips the
    // rule writes "ДАША" beside "Даша" without a word, and "MARISOL" beside "Marisol" fails with a raw database error.
    console.log('\n— 2. a visitor\'s row holding a member\'s name —');
    const dasha = await join('Даша');
    giveSignInCopy(dasha.pk);
    const shadow = rowAsBefore('ДАША', true);
    giveSignInCopy(shadow);
    const listed = lookedUpKeys(await lookup('даша'));
    assert(listed.length === 1 && listed[0] === dasha.pk, `the lookup for "даша" lists the member alone, not the visitor (got ${listed.length})`);
    const d = await collect({ callsign: 'даша' });
    assert(d.res.status === 200 && d.owner === dasha.pk, `the member's restore by name opens for the member (got ${show(d.res)})`);
    const viaShadow = await collect({ callsign: 'даша', candidatePublicKey: shadow });
    assert(viaShadow.res.status === 400 && !viaShadow.owner, `the visitor's key under that name opens nothing (got ${show(viaShadow.res)})`);
    db.prepare('DELETE FROM recovery_shares WHERE owner_pubkey = ?').run(shadow);
    db.prepare(`UPDATE members SET status = 'pruned' WHERE public_key = ?`).run(shadow);

    console.log('\n— 3. a visitor\'s row from a peer —');
    const marisol = await join('Marisol');
    giveSignInCopy(marisol.pk);
    const v1 = keypair().pk, v2 = keypair().pk, v3 = keypair().pk;
    const visit = (pk: string, name: string): string => {
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
    const stillOne = lookedUpKeys(await lookup('ДАША'));
    assert(stillOne.length === 1 && stillOne[0] === dasha.pk, `the lookup for "ДАША" still lists the member alone (got ${stillOne.length})`);

    console.log('\n— 4. a project\'s and a crowdfund\'s title edits —');
    const proposed = await call('POST', founder, '/api/commons/projects', { title: 'Seed Library', description: 'Seeds', requestedAmount: 50 });
    const projectId = proposed.body?.project?.id as string | undefined;
    assert(proposed.status === 200 && !!projectId && nameOf(projectId) === 'Seed Library', `a Commons project is proposed with its title as its name (got ${proposed.status}, "${projectId && nameOf(projectId)}")`);
    if (projectId) {
        const edit = await call('POST', founder, '/api/commons/projects/update', { projectId, title: 'ДАША', description: 'Seeds', requestedAmount: 50 });
        const row = nameOf(projectId) ?? '';
        assert(edit.status === 200 && foldName(row) !== foldName('Даша') && row === `ДАША-${projectId.slice(0, 6)}`,
            `a Commons project's title edit to "ДАША" names its row "ДАША-<id>", not the member's name (got ${show(edit)}, "${row}")`);
        const commons = (db.prepare(`SELECT value FROM node_config WHERE key = 'commons_projects'`).get() as { value: string }).value;
        assert((JSON.parse(commons) as any[]).find((p) => p.id === projectId)?.title === 'ДАША', `the project keeps the title "ДАША" as typed`);
        const ascii = await call('POST', founder, '/api/commons/projects/update', { projectId, title: 'MARISOL', description: 'Seeds', requestedAmount: 50 });
        assert(ascii.status === 200 && nameOf(projectId) === `MARISOL-${projectId.slice(0, 6)}`,
            `a title edit to "MARISOL" beside "Marisol" saves, with the row "MARISOL-<id>", no database error (got ${show(ascii)}, "${nameOf(projectId)}")`);
        const back = await call('POST', founder, '/api/commons/projects/update', { projectId, title: 'Seed Library Two', description: 'Seeds', requestedAmount: 50 });
        assert(back.status === 200 && nameOf(projectId) === 'Seed Library Two', `a free title is its row's name again (got "${nameOf(projectId)}")`);
    }
    const created = await call('POST', founder, '/api/crowdfund/projects', { title: 'Tool Shed', description: 'Tools', goalAmount: 100 });
    const crowdId = created.body?.project?.id as string | undefined;
    assert(created.status === 200 && !!crowdId && nameOf(crowdId) === 'Tool Shed', `a crowdfund is created with its title as its name (got ${show(created)}, "${crowdId && nameOf(crowdId)}")`);
    if (crowdId) {
        const edit = await call('POST', founder, '/api/crowdfund/projects/update', { id: crowdId, title: 'даша', description: 'Tools', goalAmount: 100 });
        const row = nameOf(crowdId) ?? '';
        assert(edit.status === 200 && row === `даша-${crowdId.slice(0, 6)}`, `a crowdfund's title edit to "даша" names its row "даша-<id>" (got ${show(edit)}, "${row}")`);
        // A crowdfund shows its row's name as its title, so it reads as a create on a clash reads (createCrowdfundProject).
        assert(edit.body?.project?.title === row, `the crowdfund reads as "даша-<id>", as a create on a clash does (got "${edit.body?.project?.title}")`);
        const withDeadline = await call('POST', founder, '/api/crowdfund/projects/update', { id: crowdId, title: 'marisol', description: 'Tools', goalAmount: 100, deadlineAt: null });
        assert(withDeadline.status === 200 && nameOf(crowdId) === `marisol-${crowdId.slice(0, 6)}`,
            `an edit that also sets the deadline, to "marisol", saves with the row "marisol-<id>", no database error (got ${show(withDeadline)}, "${nameOf(crowdId)}")`);
    }
    const afterEdits = await collect({ callsign: 'Даша' });
    assert(afterEdits.res.status === 200 && afterEdits.owner === dasha.pk, `after the edits the member's restore by name still opens for the member (got ${show(afterEdits.res)})`);
    const m = await collect({ callsign: 'MARISOL' });
    assert(m.res.status === 200 && m.owner === marisol.pk, `and "Marisol"'s too (got ${show(m.res)})`);

    console.log(`\n${passed}/${run} passed`);
}

main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(e); process.exit(1); });
