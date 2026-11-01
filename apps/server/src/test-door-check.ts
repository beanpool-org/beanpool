/**
 * The person check at the 12-words door on a busy day (services/door-check.ts), over REAL HTTPS through the real signature
 * middleware. Cloudflare is never contacted: `fetch` to siteverify is answered here, and anything else goes through.
 *
 *   1. a node with no keys: nothing changes, however busy; the same with only some of the keys, and with the switch off;
 *      a local community's switch is off by default, so no key can bring the check there
 *   2. at ordinary levels (under `checkFromLevel`): no check, and siteverify is never asked, with the keys set
 *   3. a script with no token, busy: 429 check_required, in words, naming the sign-in, no work handed out, and the page
 *      to go to; a join with good work from a quiet moment refused the same way and its work NOT spent, nobody joined
 *   4. a token: passes, the work is handed out, the join stands, and the secret, the token and no address went to
 *      Cloudflare; with the pass, a new challenge needs no second check
 *   5. a wrong key's token, a wrong hostname, a wrong action, an old token, a junk token: 403 check_failed, no pass, no work
 *   6. a replayed token: refused here, without asking Cloudflare again; two at once: one passes
 *   7. the sign-in door never needs it, however busy
 *   8. an outage: no answer, a 5xx, internal-error: the requirement drops, the log says so, and a join needs only its
 *      work; when Cloudflare answers again the requirement is back within the probe's time
 *   9. nobody can force that: junk, an over-long token and no token at all are refused while Cloudflare answers, and a
 *      client's token that gets no answer changes nothing while the server's own probe is answered; probes are not one
 *      per request; and Cloudflare limiting this server's calls, the one thing a flood of tokens could cause, is no outage
 *  10. the owners' setting: the shape reads it where the door is open, and only there (test-community-shape-write sets it)
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-door-check.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.GOOGLE_CLIENT_IDS;
delete process.env.TURNSTILE_SITE_KEY;
delete process.env.TURNSTILE_SECRET_KEY;
delete process.env.TURNSTILE_PAGE_URL;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { DOOR_NUMBERS, _resetDoorBusyForTests, _resetWordsJoinsForTests } from './engine/door-signal.js';
import { getProfileSwitches } from './config/node-profile.js';
import { _clearSpentDoorWorkForTests } from './services/door-work.js';
import {
    PROBE_FORCED_EVERY_MS, PROBE_STANDS_MS, SITEVERIFY_URL, TOKEN_LIFE_MS, _resetDoorCheckForTests, doorCheckPassed, forgetDoorCheckPass, siteverifyUp, verifyDoorCheck,
} from './services/door-check.js';
import { solveOffLoop } from './door-work-test-solver.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

// ── Cloudflare, played here ─────────────────────────────────────────────────────────────────────
const SITE_KEY = '0x4AAAAtestsitekey';
const SECRET = 'test-secret-not-a-real-one';
const PAGE = 'https://check.example.org/';

interface Issued { hostname?: string; action?: string; cdata: string; made?: number }
type Mode = 'ok' | 'down' | 'http500' | 'internal' | 'bad_secret' | 'limited';
const cf = {
    mode: 'ok' as Mode,
    /** Fail only calls for a client's token: Cloudflare is up and this one call was lost. */
    loseClientTokens: false,
    issued: new Map<string, Issued>(),
    used: new Set<string>(),
    forms: [] as URLSearchParams[],
    probes: 0,
};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
    if (String(input) !== SITEVERIFY_URL) return realFetch(input, init);
    const form = new URLSearchParams(init?.body?.toString() ?? '');
    cf.forms.push(form);
    const token = form.get('response') ?? '';
    const isProbe = !cf.issued.has(token) && token.startsWith('beanpool-');
    if (isProbe) cf.probes++;
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (cf.mode === 'down' || (cf.loseClientTokens && !isProbe)) throw new TypeError('fetch failed');
    if (cf.mode === 'http500') return new Response('<html>bad gateway</html>', { status: 502 });
    if (cf.mode === 'limited') return new Response('<html>too many requests</html>', { status: 429 });
    if (cf.mode === 'internal') return reply(200, { success: false, 'error-codes': ['internal-error'] });
    if (cf.mode === 'bad_secret' || form.get('secret') !== SECRET) return reply(200, { success: false, 'error-codes': ['invalid-input-secret'] });
    const issued = cf.issued.get(token);
    if (!issued) return reply(200, { success: false, 'error-codes': ['invalid-input-response'] });
    if (cf.used.has(token)) return reply(200, { success: false, 'error-codes': ['timeout-or-duplicate'] });
    cf.used.add(token);
    return reply(200, {
        success: true, hostname: issued.hostname ?? 'check.example.org', action: issued.action ?? 'join', cdata: issued.cdata,
        challenge_ts: new Date(issued.made ?? Date.now()).toISOString(), 'error-codes': [],
    });
}) as typeof fetch;

function tokenFor(pk: string, over: Partial<Issued> = {}): string {
    const token = `0.${crypto.randomBytes(24).toString('base64url')}`;
    cf.issued.set(token, { cdata: pk.slice(0, 32), ...over });
    return token;
}

// ── joiners and requests ────────────────────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject }
function newId(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey };
}
interface Res { status: number; body: any }
async function post(id: Id, path: string, body: unknown, ip: string): Promise<Res> {
    resetGatewayRateLimit();
    pruneAuthAttempts(Date.now() + 120_000);
    const raw = JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const res = await realFetch(`${BASE}${path}`, {
        method: 'POST',
        headers: {
            'CF-Connecting-IP': ip, 'Content-Type': 'application/json', 'X-Public-Key': id.pk, 'X-Timestamp': String(ts), 'X-Nonce': nonce,
            'X-Signature': crypto.sign(null, Buffer.from(`POST\n${path}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64'),
        },
        body: raw,
    });
    let parsed: any;
    try { parsed = await res.json(); } catch { parsed = undefined; }
    return { status: res.status, body: parsed };
}
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)}`;
const askWork = (id: Id, ip: string, turnstile?: unknown) => post(id, '/api/join/work', { door: 'words', ...(turnstile === undefined ? {} : { turnstile }) }, ip);
const join = (id: Id, name: string, work: unknown, ip: string) => post(id, '/api/join', { door: 'words', callsign: name, work }, ip);
const isMember = (pk: string) => !!db.prepare('SELECT 1 FROM members WHERE public_key = ?').get(pk);
async function solved(r: Res): Promise<{ challenge: string; counters: number[] }> {
    if (!r.body?.work) throw new Error(`no work: ${show(r)}`);
    return { challenge: r.body.work.challenge, counters: await solveOffLoop(r.body.work.challenge) };
}

function setRow(key: string, value: string | null): void {
    if (value === null) db.prepare('DELETE FROM node_config WHERE key = ?').run(key);
    else db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
function setKeys(on: boolean): void {
    if (on) { process.env.TURNSTILE_SITE_KEY = SITE_KEY; process.env.TURNSTILE_SECRET_KEY = SECRET; process.env.TURNSTILE_PAGE_URL = PAGE; } else {
        delete process.env.TURNSTILE_SITE_KEY; delete process.env.TURNSTILE_SECRET_KEY; delete process.env.TURNSTILE_PAGE_URL;
    }
}
/** The door at level 2 from the first join on any network (one step each for the network and the node), or as it ships. */
function setBusy(on: boolean): void {
    setRow('doorNumbers.networkSteps', on ? '1,100,200,300' : null);
    setRow('doorNumbers.nodeSteps', on ? '1,2000,5000' : null);
}
function fresh(): void {
    _resetDoorCheckForTests();
    _clearSpentDoorWorkForTests();
    _resetDoorBusyForTests();
    _resetWordsJoinsForTests();
    cf.mode = 'ok';
    cf.loseClientTokens = false;
    cf.forms = [];
    cf.probes = 0;
}
let nextIp = 10;
const anotherIp = () => `198.51.100.${nextIp++}`;

async function main(): Promise<void> {
    console.log('\n=== The person check at the 12-words door, over real HTTPS ===\n');
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    console.log('── 0. the numbers ──');
    assert(DOOR_NUMBERS.global.checkFromLevel === 2, 'the check starts at level 2');
    assert(getProfileSwitches('local' as any).doorCheck === false, 'a local community: the switch is off by default');
    assert(getProfileSwitches('global' as any).doorCheck === true, 'the global kind: on by default');
    process.env.NODE_PROFILE = 'global';

    // ── 1. no keys ───────────────────────────────────────────────────────────────────────────────
    console.log('\n── 1. a node with no keys: nothing changes ──');
    fresh(); setKeys(false); setBusy(true);
    const nk = newId(); const nkIp = anotherIp();
    const nkWork = await askWork(nk, nkIp);
    assert(nkWork.status === 200 && nkWork.body?.work && nkWork.body?.turnstile === null && nkWork.body.work.level >= 2, `no keys, busy: work as ever (${nkWork.status}, level ${nkWork.body?.work?.level})`);
    const nkJoin = await join(nk, 'No Keys', await solved(nkWork), nkIp);
    assert(nkJoin.status === 200 && isMember(nk.pk), `no keys, busy: the join stands (${nkJoin.status})`);
    assert(cf.forms.length === 0, 'no keys: Cloudflare is never asked');
    process.env.TURNSTILE_SITE_KEY = SITE_KEY;
    const some = await askWork(newId(), anotherIp());
    assert(some.status === 200 && !!some.body?.work, `only some of the keys: the check is off (${some.status})`);
    setKeys(true);
    process.env.TURNSTILE_PAGE_URL = 'http://check.example.org/';
    const plain = await askWork(newId(), anotherIp());
    assert(plain.status === 200 && !!plain.body?.work, `a page that isn't https: the check is off (${plain.status})`);
    setKeys(true);
    process.env.NODE_PROFILE = '';
    const local = await askWork(newId(), anotherIp());
    assert(local.status === 404 && local.body?.code === 'invite_only', `a local community with the keys: its door is shut as ever, no check (${local.status})`);
    process.env.NODE_PROFILE = 'global';
    setRow('nodeProfile.doorCheck', 'false');
    const off = await askWork(newId(), anotherIp());
    assert(off.status === 200 && !!off.body?.work, `the switch off, keys set, busy: no check (${off.status})`);
    setRow('nodeProfile.doorCheck', null);

    // ── 2. ordinary levels ───────────────────────────────────────────────────────────────────────
    console.log('\n── 2. at ordinary levels nobody sees it ──');
    fresh(); setKeys(true); setBusy(false);
    const quiet = newId(); const quietIp = anotherIp();
    const quietWork = await askWork(quiet, quietIp);
    assert(quietWork.status === 200 && quietWork.body?.work?.level === 0 && quietWork.body?.turnstile === null, `a quiet door: work at level 0, no check (${quietWork.status})`);
    const quietJoin = await join(quiet, 'Quiet', await solved(quietWork), quietIp);
    assert(quietJoin.status === 200 && isMember(quiet.pk), `the join stands (${quietJoin.status})`);
    assert(cf.forms.length === 0, 'and Cloudflare is never asked');
    setRow('doorNumbers.networkSteps', '1,100,200,300');
    const one = await askWork(newId(), anotherIp());
    assert(one.status === 200 && one.body?.work?.level === 1, `level 1: still no check (level ${one.body?.work?.level})`);

    // ── 3. no token, busy ────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. a script with no token, busy ──');
    fresh(); setBusy(false);
    const script = newId(); const scriptIp = anotherIp();
    const stocked = await solved(await askWork(script, scriptIp)); // work stocked up while the door was quiet
    setBusy(true);
    const refused = await askWork(script, scriptIp);
    assert(refused.status === 429 && refused.body?.code === 'check_required' && !refused.body?.work, `no token: 429 check_required and no work handed out (${show(refused)})`);
    assert(/sign in/i.test(refused.body?.error ?? ''), `in words, pointing to the sign-in door (${refused.body?.error})`);
    assert(refused.body?.turnstile?.siteKey === SITE_KEY && refused.body?.turnstile?.page === PAGE && !JSON.stringify(refused.body).includes(SECRET), 'names the page and the site key, never the secret');
    const noPass = await join(script, 'Script', stocked, scriptIp);
    assert(noPass.status === 429 && noPass.body?.code === 'check_required' && !isMember(script.pk), `work stocked while the door was quiet buys nothing: refused at the join (${show(noPass)})`);
    setBusy(false);
    const notSpent = await join(script, 'Script', stocked, scriptIp);
    assert(notSpent.status === 200, `the refusal came before the work: that work is not spent (${show(notSpent)})`);

    // ── 4. a token ───────────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. a token ──');
    fresh(); setBusy(true);
    const ada = newId(); const adaIp = anotherIp();
    const token = tokenFor(ada.pk);
    const adaWork = await askWork(ada, adaIp, token);
    assert(adaWork.status === 200 && !!adaWork.body?.work, `a good token: work handed out (${adaWork.status})`);
    const form = cf.forms[0];
    assert(form?.get('secret') === SECRET && form?.get('response') === token && !form?.has('remoteip'), 'Cloudflare gets the secret and the token, and no address');
    const adaAgain = await askWork(ada, adaIp);
    assert(adaAgain.status === 200 && !!adaAgain.body?.work && cf.forms.length === 1, `with the pass, a new challenge needs no second check (${adaAgain.status})`);
    const adaJoin = await join(ada, 'Ada', await solved(adaAgain), adaIp);
    assert(adaJoin.status === 200 && isMember(ada.pk) && !doorCheckPassed(ada.pk), `the join stands, and the pass is done with (${adaJoin.status})`);

    // ── 5. tokens that do not count ──────────────────────────────────────────────────────────────
    console.log('\n── 5. tokens that do not count ──');
    fresh();
    const bea = newId(); const beaIp = anotherIp();
    const other = newId();
    for (const [what, t] of [
        ['a token made for another key', tokenFor(other.pk)],
        ['another site\'s hostname', tokenFor(bea.pk, { hostname: 'elsewhere.example.org' })],
        ['another action', tokenFor(bea.pk, { action: 'login' })],
        ['an old token', tokenFor(bea.pk, { made: Date.now() - TOKEN_LIFE_MS - 1_000 })],
        ['a token Cloudflare never made', '0.not-a-token-at-all'],
    ] as const) {
        const r = await askWork(bea, beaIp, t);
        assert(r.status === 403 && r.body?.code === 'check_failed' && !r.body?.work && !doorCheckPassed(bea.pk), `${what}: 403 check_failed, no pass, no work (${r.status})`);
    }
    const stillNo = await join(bea, 'Bea', { challenge: 'x', counters: [] }, beaIp);
    assert(stillNo.status === 429 && !isMember(bea.pk), `and the join is still refused (${stillNo.status})`);

    // ── 6. a replayed token ──────────────────────────────────────────────────────────────────────
    console.log('\n── 6. a replayed token ──');
    fresh();
    const cam = newId(); const camIp = anotherIp();
    const once = tokenFor(cam.pk);
    assert((await askWork(cam, camIp, once)).status === 200, 'its first use passes');
    forgetDoorCheckPass(cam.pk);
    const asked = cf.forms.length;
    const replay = await askWork(cam, camIp, once);
    assert(replay.status === 403 && replay.body?.code === 'check_failed' && !doorCheckPassed(cam.pk), `a replay: refused (${show(replay)})`);
    assert(cf.forms.length === asked, 'without asking Cloudflare again');
    // Asked of the check itself: over HTTP the second request may arrive after the first passed, and a key with a pass
    // sends no token to judge.
    const both = tokenFor(cam.pk);
    const twice = await Promise.all([verifyDoorCheck(both, cam.pk), verifyDoorCheck(both, cam.pk)]);
    assert([...twice].sort().join() === 'failed,passed', `the same token twice at once: one passes (${twice.join(', ')})`);

    // ── 7. the sign-in door ──────────────────────────────────────────────────────────────────────
    console.log('\n── 7. the sign-in door never needs it ──');
    fresh();
    const signing = await post(newId(), '/api/join/work', { door: 'sign-in' }, anotherIp());
    assert(signing.status === 200 && signing.body?.code !== 'check_required' && cf.forms.length === 0, `busy: the sign-in door is not asked (${show(signing)})`);

    // ── 8. an outage ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── 8. an outage shuts nobody out ──');
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); realWarn(...args); };
    for (const mode of ['down', 'http500', 'internal', 'bad_secret'] as const) {
        fresh(); cf.mode = mode; warnings.length = 0;
        const eve = newId(); const eveIp = anotherIp();
        const eveWork = await askWork(eve, eveIp);
        assert(eveWork.status === 200 && !!eveWork.body?.work, `${mode}: the requirement drops, work handed out with no token (${eveWork.status})`);
        assert(warnings.some((w) => /can't be asked/.test(w)), `${mode}: the log says so`);
        const eveJoin = await join(eve, 'Eve', await solved(eveWork), eveIp);
        assert(eveJoin.status === 200 && isMember(eve.pk), `${mode}: the join stands on its work (${eveJoin.status})`);
    }
    console.warn = realWarn;
    fresh(); cf.mode = 'down';
    const noWork = await join(newId(), 'No Work', undefined, anotherIp());
    assert(noWork.status === 400 && noWork.body?.code === 'work_required', `the outage drops the check and never the work (${show(noWork)})`);
    fresh(); cf.mode = 'down';
    const t0 = Date.now();
    assert(await siteverifyUp(false, t0) === false, 'down: the probe says so');
    cf.mode = 'ok';
    assert(await siteverifyUp(false, Date.now() + 1) === false, 'its answer stands for a while, so an outage is one probe a minute');
    assert(await siteverifyUp(false, Date.now() + PROBE_STANDS_MS + 5_000) === true, 'and once Cloudflare answers, the next probe brings the requirement back');
    const back = await askWork(newId(), anotherIp());
    assert(back.status === 429 && back.body?.code === 'check_required', `the check is back on (${back.status})`);

    // ── 9. nobody can force it ───────────────────────────────────────────────────────────────────
    console.log('\n── 9. no client can force an outage ──');
    fresh();
    const mal = newId(); const malIp = anotherIp();
    for (const [what, junk, code] of [
        ['a junk token', 'junk', 'check_failed'],
        ['a token that claims to be the probe\'s', 'beanpool-door-check-probe', 'check_failed'],
        ['an over-long token', 'x'.repeat(5_000), 'check_failed'],
        ['a token with a line break', 'a\nb', 'check_failed'],
        ['a token that is not text', { token: 'x' }, 'check_failed'],
        ['null', null, 'check_required'],
        ['nothing at all', undefined, 'check_required'],
    ] as const) {
        const r = await askWork(mal, malIp, junk);
        assert(r.body?.code === code && !r.body?.work, `${what}: refused (${r.status} ${r.body?.code})`);
    }
    assert(!cf.forms.some((f) => (f.get('response') ?? '').length > 2_048), 'an over-long token is never sent');
    fresh();
    cf.loseClientTokens = true; // Cloudflare is up; only this one client's call went unanswered
    const lost = await askWork(mal, malIp, tokenFor(mal.pk));
    assert(lost.status === 429 && lost.body?.code === 'check_required' && !lost.body?.work, `a client's token that gets no answer proves nothing: the server's own probe was answered, so refused (${show(lost)})`);
    assert(cf.probes >= 1, 'the probe decided');
    const was = cf.probes;
    for (let i = 0; i < 8; i++) await askWork(mal, malIp, tokenFor(mal.pk));
    assert(cf.probes === was, `eight more unanswered tokens: no more probes inside ${PROBE_FORCED_EVERY_MS / 1000} s, so a client can't drive them (${cf.probes - was} extra)`);
    cf.loseClientTokens = false;
    const notBurnt = tokenFor(mal.pk);
    cf.loseClientTokens = true;
    assert(await verifyDoorCheck(notBurnt, mal.pk) === 'unknown', 'a token that got no answer was not judged');
    cf.loseClientTokens = false;
    assert(await verifyDoorCheck(notBurnt, mal.pk) === 'passed', 'so it is not spent: the same token works when sent again');
    // Every junk token is one call to Cloudflare, so a flood of them is the one thing a client could send to make it stop
    // answering this server. A limit is Cloudflare answering: no outage, and the check stays on.
    fresh(); cf.mode = 'limited';
    const flood = newId(); const floodIp = anotherIp();
    const metTheLimit = tokenFor(flood.pk);
    const limited = await askWork(flood, floodIp, metTheLimit);
    assert(limited.status === 429 && limited.body?.code === 'check_required' && !limited.body?.work, `Cloudflare limiting this server is no outage: a token it wouldn't judge is refused (${show(limited)})`);
    const limitedBare = await askWork(newId(), anotherIp());
    assert(limitedBare.status === 429 && limitedBare.body?.code === 'check_required' && !limitedBare.body?.work, `and no token is still refused (${show(limitedBare)})`);
    assert(await siteverifyUp(false, Date.now() + PROBE_STANDS_MS + 5_000) === true, 'the server\'s own probe reads a limit as Cloudflare answering');
    cf.mode = 'ok';
    assert(await verifyDoorCheck(metTheLimit, flood.pk) === 'passed', 'a token that met the limit was not judged, so it counts when sent again');

    // ── 10. the owners' setting ──────────────────────────────────────────────────────────────────
    console.log('\n── 10. the owners\' setting ──');
    fresh();
    const { readShape } = await import('./config/community-shape.js');
    const shape = readShape() as any;
    assert(shape.settings?.doorCheck?.value === true && shape.settings?.doorCheck?.source !== 'owner', `the shape reads it on the global kind, by default (${JSON.stringify(shape.settings?.doorCheck)})`);
    process.env.NODE_PROFILE = '';
    const localShape = readShape() as any;
    assert(localShape.settings?.doorCheck === undefined, 'a local community has no such setting: its door is shut');
    process.env.NODE_PROFILE = 'global';
    setBusy(false);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
