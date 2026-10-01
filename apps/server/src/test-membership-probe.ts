/**
 * The membership probe, GET /api/community/membership/:publicKey (multi-community review F3, 2026-10-01).
 *
 * One key is a person's on every community, and members see each other's keys. Answered to anyone, the probe let whoever
 * held a key ask every community whether that person was in it: a map of a person across the fleet, from nothing but the
 * directory's addresses. Now it answers only a request signed by the key it asks about, and refuses anyone else the same
 * way whatever the key is. Over real HTTPS through the real signature middleware, on a local community and then on the
 * global profile (the same rule on both):
 *
 *   1. unsigned: 401 signature_required, the same body for a member's key, a visitor's row, a key with no row and one that
 *      is not a key; a HEAD too
 *   2. signed by another key (a member, a key with no row): 403 not_your_key, the same body whatever the key asked about
 *   3. signed by the key itself: a member hears it is one, with its name; a key with no row, or a visitor's row, that it
 *      is not (the apps' "join here"); the key in capitals is the same key
 *   4. the apps' own probes, each built as the app builds it with @beanpool/core's format 2 for this node's host: the
 *      phone's join check, community switcher and delete (native utils/membership-probe.ts, signed by the phone's key),
 *      its restore (db.ts fetchNodeCallsign, signed by the key restored, which is not saved yet), the web app's (lib/api.ts
 *      request, lib/web-join.ts): each answered, a member with its name
 *   5. an old app's probe in the old format (no community named): answered until the switch; after it, refused as an
 *      unsigned one is, never a wrong "not a member"
 *   6. a probe signed for another community's host is refused (request binding): a hostile community can't replay a
 *      member's own probe here
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.NODE_PROFILE;
// This community's name, which every probe below is signed for (request binding): the server checks the name signed for
// against its own, never the host it was reached at, so the requests reach it at localhost. A node that knows its name
// refuses one signed for any other.
const OWN_NAME = 'probe-community.example';
process.env.BEANPOOL_ADDRESSES = OWN_NAME;

import crypto from 'node:crypto';
import { buildBoundRequestHeaders, ed25519Signer } from '@beanpool/core';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember } from './state-engine.js';
import { registerVisitor } from './engine/members.js';
import { startHttpsServer } from './https-server.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { setSignatureSwitchClockForTests } from './engine/member-signature.js';

let BASE = '';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

interface Id { pk: string; seed: Uint8Array; privateKey: crypto.KeyObject }
function keypair(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const seed = new Uint8Array(privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32));
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), seed, privateKey };
}

interface Answer { status: number; body: any; text: string; headers: Headers }
async function answer(res: Response): Promise<Answer> {
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body, text, headers: res.headers };
}

/** The probe for `key`: unsigned, or signed by `signer` in format 2 for `forHost` (this community's name by default). */
async function probe(key: string, signer?: Id, opts: { forHost?: string; method?: string } = {}): Promise<Answer> {
    const path = `/api/community/membership/${key}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (signer) {
        const url = `https://${opts.forHost ?? OWN_NAME}${path}`;
        Object.assign(headers, await buildBoundRequestHeaders({ method: opts.method ?? 'GET', url, body: '', publicKeyHex: signer.pk, sign: ed25519Signer(signer.seed) }));
    }
    return answer(await fetch(`${BASE}${path}`, { method: opts.method ?? 'GET', headers }));
}

/** The probe signed as an app before request binding signs it: `GET\nPATH\nTS\nNONCE\n`, no community named. */
async function oldAppProbe(key: string, signer: Id): Promise<Answer> {
    const path = `/api/community/membership/${key}`;
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`GET\n${path}\n${ts}\n${nonce}\n`), signer.privateKey).toString('base64');
    return answer(await fetch(`${BASE}${path}`, { headers: { 'X-Public-Key': signer.pk, 'X-Signature': sig, 'X-Timestamp': String(ts), 'X-Nonce': nonce } }));
}

async function checks(where: string, alice: Id, bob: Id, nobody: Id, vic: Id, names: { alice: string; bob: string }): Promise<void> {
    resetGatewayRateLimit();
    const keys: Array<[string, string]> = [["Alice's (a member)", alice.pk], ["Vic's (a visitor's row)", vic.pk], ['a key with no row', nobody.pk], ['not a key', 'pubkey_unknown_456']];

    // ── 1. unsigned ──
    console.log(`\n── ${where} 1. unsigned: refused, the same whatever the key ──`);
    const unsigned = await Promise.all(keys.map(([, k]) => probe(k)));
    unsigned.forEach((r, i) => {
        assert(r.status === 401 && r.body?.code === 'signature_required' && !('isMember' in (r.body ?? {})) && !r.text.includes(names.alice),
            `${where}: unsigned, ${keys[i][0]}: 401 signature_required, no answer about the key (got ${r.status} ${r.text.slice(0, 100)})`);
    });
    assert(new Set(unsigned.map(r => r.text)).size === 1, `${where}: the same refusal word for word, whichever key was asked about`);
    const head = await Promise.all([alice.pk, nobody.pk].map(k => fetch(`${BASE}/api/community/membership/${k}`, { method: 'HEAD' })));
    assert(head.every(r => r.status === 401) && head[0].headers.get('content-length') === head[1].headers.get('content-length'),
        `${where}: a HEAD is refused the same, for a member's key and for no one's (${head.map(r => `${r.status}/${r.headers.get('content-length')}`).join(', ')})`);

    // ── 2. signed by another key ──
    console.log(`\n── ${where} 2. signed by another key: refused, the same whatever the key ──`);
    for (const [who, signer] of [['Bob, a member', bob], ['a key with no row', nobody]] as const) {
        const asked = await Promise.all(keys.filter(([, k]) => k !== signer.pk).map(([, k]) => probe(k, signer)));
        for (const r of asked) {
            assert(r.status === 403 && r.body?.code === 'not_your_key' && !('isMember' in (r.body ?? {})) && !r.text.includes(names.alice),
                `${where}: signed by ${who} about another key: 403 not_your_key, no answer about it (got ${r.status} ${r.text.slice(0, 100)})`);
        }
        assert(new Set(asked.map(r => r.text)).size === 1, `${where}: signed by ${who}, the same refusal word for word whichever key`);
    }

    // ── 3. signed by the key itself ──
    console.log(`\n── ${where} 3. signed by the key itself: the answer ──`);
    const own = await probe(alice.pk, alice);
    assert(own.status === 200 && own.body?.isMember === true && own.body?.callsign === names.alice,
        `${where}: Alice, signing her own probe, hears she is a member, with her name (got ${own.status} ${own.text.slice(0, 100)})`);
    assert(/no-store/.test(own.headers.get('cache-control') ?? '') && /private/.test(own.headers.get('cache-control') ?? ''),
        `${where}: and no shared cache keeps it (Cache-Control ${own.headers.get('cache-control')})`);
    const capitals = await probe(alice.pk.toUpperCase(), alice);
    assert(capitals.status === 200 && capitals.body?.isMember === true, `${where}: her key in capitals is her key (got ${capitals.status})`);
    const none = await probe(nobody.pk, nobody);
    assert(none.status === 200 && none.body?.isMember === false && none.body?.callsign === null && none.body?.isRecovering === false && none.body?.recoveryStatus === null,
        `${where}: a key with no row, signing its own, hears it is not a member: the apps' "join here" (got ${none.text.slice(0, 120)})`);
    const visitor = await probe(vic.pk, vic);
    assert(visitor.status === 200 && visitor.body?.isMember === false && visitor.body?.callsign === null,
        `${where}: a visitor's row, signing its own, is not a member either (got ${visitor.text.slice(0, 120)})`);

    // ── 4. the apps' own probes ──
    console.log(`\n── ${where} 4. the apps' own probes, as each builds them ──`);
    // The phone's restore: signed by the key the 12 words gave back, which the phone has not saved yet. A fresh key each,
    // so its nonce is new: each app makes one per request.
    const restored = await probe(bob.pk, { ...bob });
    assert(restored.status === 200 && restored.body?.isMember === true && restored.body?.callsign === names.bob,
        `${where}: the phone's restore, signed by the restored key, gets the member's name back (got ${restored.text.slice(0, 100)})`);
    // The phone's join check (before a redeem, and after one whose answer was lost) and the web app's door: a key not in
    // yet hears no, and once it is in hears yes.
    const joiner = keypair();
    const before = await probe(joiner.pk, joiner);
    seedGenesisMember(joiner.pk, `${where}-joiner`);
    const after = await probe(joiner.pk, joiner);
    assert(before.status === 200 && before.body?.isMember === false && after.status === 200 && after.body?.isMember === true,
        `${where}: the join check: not a member before joining, a member after (got ${before.text.slice(0, 60)} then ${after.text.slice(0, 60)})`);

    // ── 6. signed for another community ──
    console.log(`\n── ${where} 6. a probe signed for another community is refused here ──`);
    const elsewhere = await probe(alice.pk, alice, { forHost: 'other-community.example' });
    assert(elsewhere.status === 421 && elsewhere.body?.code === 'wrong_community' && !('isMember' in (elsewhere.body ?? {})),
        `${where}: Alice's own probe, signed for another community, is refused here and answers nothing (got ${elsewhere.status} ${elsewhere.body?.code ?? ''})`);
}

async function main() {
    console.log('Running membership probe tests...');

    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const alice = keypair();
    const bob = keypair();
    const nobody = keypair();
    const vic = keypair();
    seedGenesisMember(alice.pk, 'alice');
    seedGenesisMember(bob.pk, 'bob');
    registerVisitor(vic.pk, 'vic');

    await checks('local', alice, bob, nobody, vic, { alice: 'alice', bob: 'bob' });

    // ── 5. an old app (local) ──
    console.log('\n── local 5. an old app\'s probe, in the format that names no community ──');
    resetGatewayRateLimit();
    const old = await oldAppProbe(alice.pk, alice);
    assert(old.status === 200 && old.body?.isMember === true && old.body?.callsign === 'alice',
        `until the switch, an old app's own probe is answered (got ${old.status} ${old.text.slice(0, 80)})`);
    setSignatureSwitchClockForTests(() => Date.parse('2027-07-01T00:00:00Z'));
    const switched = await oldAppProbe(alice.pk, alice);
    assert(switched.status === 401 && switched.body?.code === 'signature_required',
        `after it, the old format is read as unsigned and refused, never a wrong "not a member" (got ${switched.status} ${switched.text.slice(0, 80)})`);
    setSignatureSwitchClockForTests(null);

    // The global profile: the same rule. Its people reads are members' already (G9a), and whether a key tried BeanPool
    // there is no one's business but the key's.
    process.env.NODE_PROFILE = 'global';
    const g = { alice: keypair(), bob: keypair(), nobody: keypair(), vic: keypair() };
    seedGenesisMember(g.alice.pk, 'galice');
    seedGenesisMember(g.bob.pk, 'gbob');
    registerVisitor(g.vic.pk, 'gvic');
    await checks('global', g.alice, g.bob, g.nobody, g.vic, { alice: 'galice', bob: 'gbob' });
    delete process.env.NODE_PROFILE;

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ membership probe checks PASSED.');
}
main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
