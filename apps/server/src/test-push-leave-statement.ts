/**
 * A phone's leave statement removes exactly the leaving key's registration of that phone's token, here only, and never
 * one the same account made after it — over a REAL HTTPS round trip, through the signature middleware.
 *
 * When an account leaves a phone (Sign Out, Replace, the node-mismatch delete) the phone signs, with the leaving key K
 * while it still holds it, "K no longer wants push token T at this community" with the phone's own stamp, and presents
 * it, unsigned, until the community confirms (apps/native utils/push-leave.ts). With no connection at Sign Out, the old
 * signed DELETE never happened and K's alerts (message previews included) kept reaching the phone. Here:
 *
 *   1. a valid statement removes K's row for T and nothing else: not K's other tokens, not another key's row for T;
 *   2. a statement for another community, a forged one, a tampered one, another key's, a malformed one: nothing goes;
 *   3. a registration of T by K the phone sent before the leave and delivered after it is refused (409), for a day;
 *   4. K registering T again after the leave (signing back in on the same phone) is never undone by that statement,
 *      presented late or replayed, and a late older registration never lowers the row's stamp back within its reach;
 *   5. a registration from an app before stamps (no `registeredAt`) is removed by any statement; a bad stamp is refused;
 *   6. the online form, K's own signed DELETE carrying the leave's stamp, does exactly what the statement does.
 *
 * The statements are signed here byte for byte (0xFF, then the text), not with @beanpool/core's builder, so this suite
 * also pins the format the phone signs.
 *
 * Local only: it talks to the server it starts on localhost and nothing else. No push service is contacted.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-push-leave-statement.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
// This community's one name: a statement signed for any other host is another community's.
process.env.BEANPOOL_ADDRESSES = 'mullum.test';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { db } from './db/db.js';
import { startHttpsServer } from './https-server.js';

const PORT = 8781;
const BASE = `https://localhost:${PORT}`;
const HOST = 'mullum.test';
const OTHER_HOST = 'bellingen.test';

let run = 0;
let passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}

interface Identity { name: string; pub: string; priv: crypto.KeyObject }
function keyPair(name: string): Identity {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pub = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    return { name, pub, priv: privateKey };
}
function member(name: string): Identity {
    const id = keyPair(name);
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(id.pub, `${name}-${id.pub.slice(0, 6)}`);
    return id;
}

/** Format-2 bytes: 0xFF, then the text in UTF-8. */
const bound = (text: string) => Buffer.concat([Buffer.from([0xff]), Buffer.from(text, 'utf8')]);

interface Answer { status: number; body: any }

/** A request signed by `signer` for this community (request binding), or unsigned. */
async function send(method: 'POST' | 'DELETE', path: string, body: unknown, signer: Identity | null): Promise<Answer> {
    const bodyString = JSON.stringify(body);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (signer) {
        const ts = String(Date.now());
        const nonce = crypto.randomBytes(16).toString('hex');
        const text = `beanpool-request/2\n${HOST}\n${method}\n${path}\n${ts}\n${nonce}\n${bodyString}`;
        headers['X-Public-Key'] = signer.pub;
        headers['X-Signature'] = crypto.sign(null, bound(text), signer.priv).toString('base64');
        headers['X-Timestamp'] = ts;
        headers['X-Nonce'] = nonce;
        headers['X-Signed-For'] = HOST;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: bodyString });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed };
}

const register = (who: Identity, token: string, registeredAt?: unknown) =>
    send('POST', '/api/push-tokens', { publicKey: who.pub, token, platform: 'android', ...(registeredAt === undefined ? {} : { registeredAt }) }, who);

interface Statement { key: string; token: string; leftAt: number; signature: string; signedFor: string }

/** K's leave statement for `token` at `host`, signed by `signer` (K itself unless a forgery is wanted). */
function statement(k: Identity, token: string, leftAt: number, opts: { host?: string; signer?: Identity } = {}): Statement {
    const host = opts.host ?? HOST;
    const text = `beanpool-push-leave/2\n${host}\n${k.pub}\n${token}\n${leftAt}`;
    return { key: k.pub, token, leftAt, signature: crypto.sign(null, bound(text), (opts.signer ?? k).priv).toString('base64'), signedFor: host };
}

/** Present a statement, unsigned (or signed by `presenter`, whose signature the route never reads). */
function present(s: Statement, overrides: Record<string, unknown> = {}, presenter: Identity | null = null, pathKey = s.key): Promise<Answer> {
    const body = { token: s.token, leftAt: s.leftAt, signature: s.signature, signedFor: s.signedFor, ...overrides };
    return send('POST', `/api/push-tokens/leave/${pathKey}`, body, presenter);
}

interface Row { public_key: string; token: string; registered_at: number | null }
function rows(): Row[] {
    return db.prepare('SELECT public_key, token, registered_at FROM push_tokens ORDER BY public_key, token').all() as Row[];
}
const has = (who: Identity, token: string) => rows().some((r) => r.public_key === who.pub && r.token === token);
const stampOf = (who: Identity, token: string) => rows().find((r) => r.public_key === who.pub && r.token === token)?.registered_at;
const snapshot = () => JSON.stringify(rows());
const show = (a: Answer) => `${a.status} ${JSON.stringify(a.body)}`;
const confirmed = (a: Answer) => a.status === 200 && a.body?.left === true;
/** The phone stops presenting a statement the node will never act on; it keeps one refused for anything else. */
const refusedForGood = (a: Answer) => a.status >= 400 && a.status < 500 && a.body?.code === 'push_leave_refused';

async function main(): Promise<void> {
    console.log('\nRunning push leave statements...\n');

    await initTls();
    initStateEngine();
    const kim = member('kim');
    const ben = member('ben');
    await startHttpsServer(PORT);

    const PHONE = 'ExponentPushToken[kims-phone]';
    const TABLET = 'ExponentPushToken[kims-tablet]';

    // Kim's phone registered her at stamp 1000, and her tablet at 5; Ben's key registered the same phone token.
    assert((await register(kim, PHONE, 1000)).status === 200, 'Kim registers her phone, stamped 1000 by the phone');
    assert((await register(kim, TABLET, 5)).status === 200, 'Kim registers her tablet');
    assert((await register(ben, PHONE, 7)).status === 200, 'Ben\'s key registers the same phone token');
    assert(stampOf(kim, PHONE) === 1000, `the node keeps the phone's stamp (${stampOf(kim, PHONE)})`);

    // ── 2. What removes nothing ───────────────────────────────────────────────────────────────
    console.log('\n── Statements that remove nothing');
    const before = snapshot();
    const elsewhere = await present(statement(kim, PHONE, 2000, { host: OTHER_HOST }));
    assert(elsewhere.status === 421 && elsewhere.body?.code === 'wrong_community',
        `Kim's statement for another community is refused 421 wrong_community, which the phone keeps presenting (${show(elsewhere)})`);
    const forged = await present(statement(kim, PHONE, 2000, { signer: ben }));
    assert(forged.status === 403 && refusedForGood(forged), `a statement naming Kim but signed by Ben is refused for good (${show(forged)})`);
    const tampered = await present(statement(kim, TABLET, 2000), { token: PHONE });
    assert(tampered.status === 403 && refusedForGood(tampered), `Kim's statement for her tablet, presented for her phone, is refused (${show(tampered)})`);
    const later = await present(statement(kim, PHONE, 2000), { leftAt: 9_999_999 });
    assert(later.status === 403 && refusedForGood(later), `a statement whose stamp was changed is refused (${show(later)})`);
    const bensForKim = await present(statement(ben, PHONE, 2000), {}, null, kim.pub);
    assert(bensForKim.status === 403 && refusedForGood(bensForKim), `Ben's own valid statement presented as Kim's is refused (${show(bensForKim)})`);
    const upper = await present(statement(kim, PHONE, 2000), {}, null, kim.pub.toUpperCase());
    assert(upper.status >= 400 && upper.status < 500, `Kim's key in capitals in the path is refused (${show(upper)})`);
    for (const [label, o] of [
        ['no signature', { signature: undefined }], ['no host', { signedFor: undefined }], ['a token over two lines', { token: `${PHONE}\nx` }],
        ['a negative stamp', { leftAt: -1 }], ['a fractional stamp', { leftAt: 1.5 }], ['a stamp as text', { leftAt: '2000' }],
        ['no token', { token: undefined }],
    ] as Array<[string, Record<string, unknown>]>) {
        const r = await present(statement(kim, PHONE, 2000), o);
        assert(r.status === 400 && refusedForGood(r), `a statement with ${label} is refused 400 for good (${show(r)})`);
    }
    const junkKey = await present(statement(kim, PHONE, 2000), {}, null, 'not-a-key');
    assert(junkKey.status === 400 && refusedForGood(junkKey), `a path that names no key is refused (${show(junkKey)})`);
    assert(snapshot() === before, '...and not one row changed');

    // ── 1. Kim's statement, presented unsigned ────────────────────────────────────────────────
    console.log('\n── Kim leaves her phone');
    const kimLeaves = statement(kim, PHONE, 2000);
    const first = await present(kimLeaves);
    assert(confirmed(first), `Kim's statement, presented unsigned, is confirmed (${show(first)})`);
    assert(!has(kim, PHONE), '...her row for the phone token goes');
    assert(has(kim, TABLET) && has(ben, PHONE), '...her tablet stays, and Ben\'s row for the same phone token stays');
    assert(JSON.stringify(first.body) === JSON.stringify({ left: true }), '...and the answer says nothing about what was there');
    const again = await present(kimLeaves);
    assert(confirmed(again) && has(kim, TABLET) && has(ben, PHONE), `presenting it again is confirmed and changes nothing more (${show(again)})`);
    const bySomeoneElse = await present(kimLeaves, {}, ben);
    assert(confirmed(bySomeoneElse) && has(ben, PHONE), `presented with Ben's signature on the request, it does only what Kim asked (${show(bySomeoneElse)})`);

    // ── 3. The registration the phone sent before leaving, delivered after ────────────────────
    console.log('\n── A registration sent before the leave and delivered after it');
    const late = await register(kim, PHONE, 1500);
    assert(late.status === 409 && late.body?.code === 'push_token_left', `a registration stamped before the leave is refused 409 (${show(late)})`);
    assert(!has(kim, PHONE), '...and Kim\'s row is not back');
    const lateAtTheLeave = await register(kim, PHONE, 2000);
    assert(lateAtTheLeave.status === 409 && !has(kim, PHONE), `so is one stamped at the leave itself (${show(lateAtTheLeave)})`);
    const bensAfter = await register(ben, PHONE, 8);
    assert(bensAfter.status === 200, `Kim's leave refuses no other key's registration of the token (${show(bensAfter)})`);

    // ── 4. Kim signs back in on the same phone ────────────────────────────────────────────────
    console.log('\n── Kim signs back in on the same phone');
    const back = await register(kim, PHONE, 3000);
    assert(back.status === 200 && back.body?.success === true && stampOf(kim, PHONE) === 3000, `Kim registers the phone again, stamped 3000 (${show(back)})`);
    const replay = await present(kimLeaves);
    assert(confirmed(replay) && has(kim, PHONE), `the old statement presented late (or replayed) is confirmed, and her new registration stays (${show(replay)})`);
    const lateOlder = await register(kim, PHONE, 2800);
    assert(lateOlder.status === 200 && stampOf(kim, PHONE) === 3000,
        `a registration stamped 2800 delivered after the one stamped 3000 leaves the row's stamp at 3000 (${show(lateOlder)}, ${stampOf(kim, PHONE)})`);
    const between = await present(statement(kim, PHONE, 2900));
    assert(confirmed(between) && has(kim, PHONE), `so a statement stamped 2900 still leaves her 3000 registration (${show(between)})`);
    const leavesAgain = await present(statement(kim, PHONE, 4000));
    assert(confirmed(leavesAgain) && !has(kim, PHONE) && has(ben, PHONE), `her next Sign Out (stamped 4000) removes it, and only it (${show(leavesAgain)})`);

    assert(confirmed(await present(statement(ben, PHONE, 9))) && !has(ben, PHONE), 'Ben\'s key leaves the phone too, with its own statement');

    // A day later the record of the leave is gone: it only ever answers a request still in flight.
    db.prepare(`UPDATE push_token_leaves SET applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours')`).run();
    const dayLater = await register(kim, PHONE, 3500);
    assert(dayLater.status === 200 && has(kim, PHONE), `after a day the leave no longer refuses an earlier stamp (${show(dayLater)})`);
    assert((await present(statement(kim, PHONE, 4000))).status === 200 && !has(kim, PHONE), '...and the statement still removes it when presented');
    const kept = (db.prepare('SELECT COUNT(*) AS n FROM push_token_leaves').get() as { n: number }).n;
    assert(kept === 1, `the leaves recorded more than a day ago are cleared as the next one is applied (${kept} left)`);

    // ── 5. An app from before stamps; a bad stamp ─────────────────────────────────────────────
    console.log('\n── Registrations without a stamp');
    const OLD_APP = 'ExponentPushToken[old-app]';
    assert((await register(kim, OLD_APP)).status === 200 && stampOf(kim, OLD_APP) === null, 'a registration from an app before stamps is kept, with none');
    assert(confirmed(await present(statement(kim, OLD_APP, 1))) && !has(kim, OLD_APP), '...and any statement from Kim for that token removes it');
    for (const bad of ['1000', -3, 0, 1.25, { $gt: 0 }]) {
        const r = await register(kim, 'ExponentPushToken[bad-stamp]', bad);
        assert(r.status === 400 && !has(kim, 'ExponentPushToken[bad-stamp]'), `a registration stamped ${JSON.stringify(bad)} is refused 400 (${show(r)})`);
    }

    // ── The online form: Kim's own signed DELETE, carrying the leave's stamp ─────────────────
    console.log('\n── The signed DELETE with the leave\'s stamp');
    const NEW_PHONE = 'ExponentPushToken[kims-new-phone]';
    assert((await register(kim, NEW_PHONE, 5000)).status === 200 && (await register(ben, NEW_PHONE, 5)).status === 200,
        'Kim and Ben\'s key register a new phone token');
    const earlierDelete = await send('DELETE', '/api/push-tokens', { publicKey: kim.pub, token: NEW_PHONE, leftAt: 4500 }, kim);
    assert(earlierDelete.status === 200 && has(kim, NEW_PHONE), `Kim's DELETE stamped before her registration leaves it (${show(earlierDelete)})`);
    const benDeletesKims = await send('DELETE', '/api/push-tokens', { publicKey: kim.pub, token: NEW_PHONE, leftAt: 9000 }, ben);
    assert(benDeletesKims.status === 403 && has(kim, NEW_PHONE), `Ben's DELETE naming Kim, stamped, is still refused (${show(benDeletesKims)})`);
    const kimDeletes = await send('DELETE', '/api/push-tokens', { publicKey: kim.pub, token: NEW_PHONE, leftAt: 6000 }, kim);
    assert(kimDeletes.status === 200 && !has(kim, NEW_PHONE) && has(ben, NEW_PHONE),
        `Kim's DELETE stamped after it removes her row and only hers (${show(kimDeletes)})`);
    const lateAfterDelete = await register(kim, NEW_PHONE, 5500);
    assert(lateAfterDelete.status === 409 && !has(kim, NEW_PHONE), `and a registration stamped before it, delivered after, is refused (${show(lateAfterDelete)})`);
    for (const [label, b] of [['a stamp as text', { leftAt: '6000', token: NEW_PHONE }], ['a stamp with no token', { leftAt: 6000 }]] as const) {
        const r = await send('DELETE', '/api/push-tokens', { publicKey: ben.pub, ...b }, ben);
        assert(r.status === 400 && has(ben, NEW_PHONE), `a DELETE with ${label} is refused 400, and nothing goes (${show(r)})`);
    }

    // The signed DELETE is as it was: the signer's own row only, and never unsigned.
    const unsignedDelete = await send('DELETE', '/api/push-tokens', { publicKey: kim.pub, token: TABLET }, null);
    assert(unsignedDelete.status === 401 && has(kim, TABLET), `an unsigned DELETE naming Kim is still refused 401 (${show(unsignedDelete)})`);
    assert(confirmed(await present(statement(kim, TABLET, 6))) && !has(kim, TABLET), 'and her tablet\'s own statement removes her tablet row');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        throw new Error(`${run - passed} check(s) failed`);
    }
    console.log('⭐️ push leave statement checks PASSED.');
}

main().then(() => process.exit(0)).catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
