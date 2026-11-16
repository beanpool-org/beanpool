/**
 * One community, several addresses, slice S2: the server publishes its signed address list and proves an address (design
 * scratch/fable-design/DESIGN-several-addresses-fable.md §2.2, §2.3, §6, §7; decided by Marty 16 Nov), over the real HTTPS
 * server through every middleware a node runs, with S0's frozen vectors (@beanpool/core/vectors/address-list.json). Nothing
 * leaves this machine: the addresses in the split-brain section answer on 127.0.0.1.
 *
 *  1. S0's vectors: with the vectors' key, community and addresses, the server's list IS the frozen list, byte for byte and
 *     signature for signature, and its proof at the vectors' time IS the frozen proof. Every frozen question gets the frozen
 *     answer: a proof (verified by core, as a phone will), 400 or 421.
 *  2. The counter, on a clock held still: `seq` goes up for each kind of change, to one more or to the clock's floor (whole
 *     seconds since 2026-01-01) when that is higher, so the first change jumps from the vectors' 14 to the floor and each
 *     one after it is one more (an own domain added and removed, the main moved and moved back, the operator's list, a
 *     hand-set name, a beanpool.org name going live, marked lost and cleared, a port, the server key, the community id),
 *     and never for no change (reads, the same list written again or in another order or spelling, a former or pending
 *     name, a loopback name, an unrelated setting). The timer numbers a change no read saw.
 *  3. Kept over a restart: a first server numbers its first list at the floor; a second process on the same data dir signs
 *     the same list at the same number, and numbers the next change after it (an hour later: at that hour's floor).
 *  4. A take-over raises the epoch: the list is signed at the new take-over count, beating every list from before it, a
 *     higher counter included; the take-over envelope carries the owner's main address and the list's number.
 *  5. The proof: 421 for every address off the list (a former name, a lost one, a removed one, loopback, another spelling,
 *     another port, none, two), 400 for a bad nonce; the Host header is never read; never cached; readable from another
 *     origin for GET and HEAD alone.
 *  6. The table: (each address kind: a beanpool.org name, an own domain, a hand-set name, the operator's list, a public number,
 *     an IPv6 number, a home-network name, a name at a port) x (main, other, was main, removed, former, lost) -> listed or not,
 *     main or not, proved (200) or refused (421), the other address still proved, and what outside readers are told
 *     (mainPublicUrl: a home-network main tells them nothing, from #3222's round-2 review).
 *  7. A restore or a roll-back never takes the number back (#3232 round 2, the deciding review's case), with real state.db
 *     files and a process per boot: the nightly backup restored onto a fresh machine after the lost server signed a newer
 *     list; the same after a past take-over, from a database-only backup (never a lower epoch); a roll-back through the real
 *     rollBackTo (the notice carries the number signed before it); and a clock far behind (on the same machine the notice
 *     still puts it past; on a fresh machine it falls back to the kept seq + 1 and the boot logs why).
 *  8. The table: (restart, change, no change, restore, restore on a fresh machine, roll-back, take-over) taken two at a
 *     time after a change since the backup -> every list signed is at or above every one signed before it, strictly above
 *     each with other content; no bump for no change or a restart; a take-over's epoch above every epoch before it.
 *  9. The split-brain check asks EVERY listed address, at once: one address leading to a server with a higher take-over count
 *     replaces this one, wherever it is in the list; once replaced, the server signs no list and no proof (503).
 *
 * Run: SERVER_SUITES_ONLY=test-address-list TEST_ALL_JOBS=2 node scripts/run-server-suites.mjs
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.BEANPOOL_ADDRESSES;
delete process.env.PUBLIC_ADDRESS_NAME;
delete process.env.PUBLIC_ADDRESS_AUTO;
delete process.env.PUBLIC_IP;
delete process.env.BEANPOOL_TEST_IDENTITY_EPOCH_URL;

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { privateKeyFromRaw, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
    ADDRESS_LIST_PATH, ADDRESS_PROOF_PATH, checkAddressList, chooseAddressList, compareAddressNumbers, newAddressProofNonce,
    verifyAddressProof, type SignedAddressList,
} from '@beanpool/core';

const SCRIPT = fileURLToPath(import.meta.url);
const V = createRequire(import.meta.url)('@beanpool/core/vectors/address-list.json');

let testsRun = 0;
let testsPassed = 0;
function assert(cond: unknown, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        // Counted, and the run goes on, so a run on main reports every one missing.
        console.error(`✗ ${msg}`);
    }
}
const show = (v: unknown) => JSON.stringify(v);

/** The node key file for a 32-byte seed (hex), as libp2p writes it. */
async function writeNodeKey(dir: string, seedHex: string): Promise<void> {
    const seed = new Uint8Array(Buffer.from(seedHex, 'hex'));
    const key = privateKeyFromRaw(new Uint8Array([...seed, ...ed25519.getPublicKey(seed)]));
    fs.writeFileSync(path.join(dir, 'libp2p_key'), privateKeyToProtobuf(key), { mode: 0o600 });
}

function writeGenesis(dir: string, communityId: string): void {
    fs.writeFileSync(path.join(dir, 'genesis.json'), JSON.stringify({
        communityId, publicKey: '00'.repeat(32), genesisHash: '11'.repeat(32), createdAt: '2026-11-16T00:00:00.000Z',
    }));
}

// ── The clock the seq floor reads ─────────────────────────────────────────────────────────

/** 2026-11-16 02:00 UTC: where the held clocks start. */
const T0 = Date.UTC(2026, 10, 16, 2, 0, 0);
const HOUR = 3_600_000;
/** The floor at `ms`, worked out here (not read from the server): whole seconds since 2026-01-01, 0 before it. */
const floorAt = (ms: number): number => Math.max(0, Math.floor((ms - Date.UTC(2026, 0, 1)) / 1000));

/** Hold the server's floor clock at `ms` (the server before round 2 has no floor: nothing to hold). */
async function holdClock(ms: number): Promise<void> {
    const al: any = await import('./services/address-list.js');
    al.addressListClockForTests?.(() => ms);
}

// ── The restart: a second process on one data dir (section 3) ─────────────────────────────

async function child(step: string): Promise<void> {
    if (step === 'spec') return specChild(JSON.parse(process.env.ADDRESS_TEST_SPEC!));
    const dir = process.env.BEANPOOL_DATA_DIR!;
    // This module's first lines clear BEANPOOL_ADDRESSES for the orchestrator; the restarted server has one address.
    process.env.BEANPOOL_ADDRESSES = 'coop.example.org';
    await holdClock(Number(process.env.ADDRESS_TEST_CLOCK_MS));
    const se = await import('./state-engine.js');
    se.initStateEngine();
    const { forgetOwnAddresses } = await import('./engine/own-addresses.js');
    const { signedAddressList, keptAddressList } = await import('./services/address-list.js');
    const out: Record<string, unknown> = {};
    if (step === 'first') {
        await writeNodeKey(dir, V.keys.community.seedHex);
        writeGenesis(dir, V.communityIds.community);
        out.before = keptAddressList();
        out.first = await signedAddressList();
        se.updateNodeConfig({ ownerAddresses: ['second.example.org'] });
        forgetOwnAddresses();
        out.changed = await signedAddressList();
    } else {
        out.kept = keptAddressList();
        out.again = await signedAddressList();
        out.again2 = await signedAddressList();
        se.updateNodeConfig({ ownerAddresses: ['second.example.org', 'third.example.org'] });
        forgetOwnAddresses();
        out.changed = await signedAddressList();
    }
    console.log(`RESULT ${JSON.stringify(out)}`);
    process.exit(0);
}

function runChild(dir: string, step: string, extraEnv: Record<string, string> = {}): any {
    const r = spawnSync(process.execPath, [...process.execArgv, SCRIPT, '--child', step], {
        env: { ...process.env, BEANPOOL_DATA_DIR: dir, BEANPOOL_ADDRESSES: 'coop.example.org', ...extraEnv }, encoding: 'utf8', timeout: 180_000,
    });
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
    if (!line) {
        console.error(`child ${step} gave no result (exit ${r.status}):\n${(r.stdout || '').slice(-1500)}\n${(r.stderr || '').slice(-1500)}`);
        return null;
    }
    return { ...JSON.parse(line.slice('RESULT '.length)), output: `${r.stdout || ''}\n${r.stderr || ''}` };
}

// ── A restore and a roll-back: one process per boot, real state.db files (section 7) ──────

interface Spec {
    /** The floor clock this process holds. */
    clock: number;
    /** The boot after a swap, wired as index.ts wires step 2.52: each notice delivered, before anything is signed. */
    boot?: boolean;
    /** The take-over count in local-config.json (a promoted server's). */
    epoch?: number;
    /** The owner's own domains before the first list is signed. */
    owner?: string[];
    /** After the first list: keep a restore point (the name is returned). */
    point?: boolean;
    /** After the first list: the owner's own domains change, and the list is signed again (`then`). */
    then?: string[];
    /** Last: roll back to this restore point through the real rollBackTo (routes/backup.ts), with no restart. */
    rollBackTo?: string;
}

async function specChild(spec: Spec): Promise<void> {
    const dir = process.env.BEANPOOL_DATA_DIR!;
    process.env.BEANPOOL_ADDRESSES = 'coop.example.org';
    await holdClock(spec.clock);
    if (!fs.existsSync(path.join(dir, 'libp2p_key'))) await writeNodeKey(dir, V.keys.community.seedHex);
    if (!fs.existsSync(path.join(dir, 'genesis.json'))) writeGenesis(dir, V.communityIds.community);
    const se = await import('./state-engine.js');
    se.initStateEngine();
    const own = await import('./engine/own-addresses.js');
    const al: any = await import('./services/address-list.js');
    const rp = await import('./services/restore-points.js');
    const { updateLocalConfig } = await import('./config/local-config.js');
    const out: Record<string, unknown> = {};
    if (spec.boot) {
        const lo = await import('./services/lights-out.js');
        out.delivered = rp.deliverRestoreNotices({ announce: () => {}, log: () => {}, remember: lo.noteRestoredCopy, renumber: al.renumberAddressListAfterSwap } as any);
    }
    if (spec.epoch !== undefined) updateLocalConfig({ identityEpoch: spec.epoch, identityEpochSince: '2026-11-01T00:00:00.000Z' });
    if (spec.owner) {
        se.updateNodeConfig({ ownerAddresses: spec.owner });
        own.forgetOwnAddresses();
    }
    const first = await al.signedAddressList();
    out.signed = first.ok ? first.signed : first;
    if (spec.point) out.point = rp.takeRestorePoint('restore').name;
    if (spec.then) {
        se.updateNodeConfig({ ownerAddresses: spec.then });
        own.forgetOwnAddresses();
        const then = await al.signedAddressList();
        out.then = then.ok ? then.signed : then;
    }
    if (spec.rollBackTo) {
        const backup = await import('./routes/backup.js');
        await backup.rollBackTo(rp.resolveRestorePoint(spec.rollBackTo)!, spec.rollBackTo, null);
        out.notices = fs.readdirSync(dir).filter((f) => f.startsWith('restore-notice-')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    }
    console.log(`RESULT ${JSON.stringify(out)}`);
    process.exit(0);
}

const runSpec = (dir: string, spec: Spec): any => runChild(dir, 'spec', { ADDRESS_TEST_SPEC: JSON.stringify(spec) });

/** A copy of a stopped server's database (a backup's state.db): the file and its write-ahead log, as they are. */
function copyDatabase(fromDir: string, toDir: string): void {
    fs.mkdirSync(toDir, { recursive: true });
    for (const f of ['state.db', 'state.db-wal', 'state.db-shm']) {
        fs.rmSync(path.join(toDir, f), { force: true });
        if (f !== 'state.db-shm' && fs.existsSync(path.join(fromDir, f))) fs.copyFileSync(path.join(fromDir, f), path.join(toDir, f));
    }
}

/**
 * A restore onto a fresh machine (routes/backup.ts restoreFromTar, by hand): the community's key and genesis, the
 * backup's database, no local-config.json, and the notice the restore leaves. The fresh machine had signed nothing, so the
 * notice carries no address list; a database-only backup carries no take-over count either (`epoch` 0).
 */
function restoreOntoFreshMachine(keysFrom: string, backup: string, fresh: string): void {
    fs.mkdirSync(fresh, { recursive: true });
    for (const f of ['libp2p_key', 'genesis.json']) fs.copyFileSync(path.join(keysFrom, f), path.join(fresh, f));
    copyDatabase(backup, fresh);
    const at = new Date().toISOString();
    fs.writeFileSync(path.join(fresh, `restore-notice-${Date.now()}-${process.pid}.json`),
        JSON.stringify({ kind: 'restore', at, madeAt: at, point: 'before-restore', by: 'owner', epoch: 0, addressList: null }) + '\n', { mode: 0o600 });
}

// ── The orchestrator ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const dataDir = process.env.BEANPOOL_DATA_DIR;
    if (!dataDir) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    fs.mkdirSync(dataDir, { recursive: true });
    await writeNodeKey(dataDir, V.keys.community.seedHex);
    writeGenesis(dataDir, V.communityIds.community);

    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { updateLocalConfig } = await import('./config/local-config.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const own = await import('./engine/own-addresses.js');
    const al = await import('./services/address-list.js');
    const ie = await import('./services/identity-epoch.js');
    const env = await import('./services/takeover-envelope.js');
    const rp = await import('./services/restore-points.js');
    const lo = await import('./services/lights-out.js');
    const { getLocalConfig } = await import('./config/local-config.js');
    // The floor clock, held still unless a section moves it: every bump is then exactly what `bumped` says.
    let clock = T0;
    const alAny: any = al;
    alAny.addressListClockForTests?.(() => clock);
    const bumped = (seq: number): number => Math.max(seq + 1, floorAt(clock));

    await initTls();
    se.initStateEngine();
    const httpsServer = await import('./https-server.js');
    const port = await httpsServer.startHttpsServer(0);
    const BASE = `https://localhost:${port}`;
    const PEER = V.keys.community.peerId as string;
    const COMMUNITY = V.communityIds.community as string;

    /** A GET through the real middleware; `host` sets the Host header a request names (fetch cannot). */
    const get = (p: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> => {
        pruneAuthAttempts(Date.now() + 120_000);
        resetGatewayRateLimit();
        return new Promise((resolve, reject) => {
            // A connection of its own each time: section 7's processes take longer than the server keeps an idle one open.
            const req = https.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers, rejectUnauthorized: false, agent: false }, (res) => {
                let raw = '';
                res.on('data', (c) => { raw += c; });
                res.on('end', () => {
                    let body: any = null;
                    try { body = JSON.parse(raw); } catch { body = raw; }
                    resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
                });
            });
            req.on('error', reject);
            req.end();
        });
    };
    const list = () => get(ADDRESS_LIST_PATH);
    const q = (name: string, v: unknown): string => v === undefined || v === null ? ''
        : Array.isArray(v) ? [...v, ...v].map((x) => `${name}=${encodeURIComponent(String(x))}`).join('&')
            : `${name}=${encodeURIComponent(String(v))}`;
    const proof = (forAddress: unknown, nonce: unknown, headers: Record<string, string> = {}) =>
        get(`${ADDRESS_PROOF_PATH}?${[q('for', forAddress), q('nonce', nonce)].filter(Boolean).join('&')}`, headers);
    /** A proof for `address` with a fresh nonce, and whether core verifies it for the vectors' key, as a phone will. */
    const proved = async (address: string): Promise<{ status: number; ok: boolean; epoch?: number; seq?: number }> => {
        const nonce = newAddressProofNonce();
        const r = await proof(address, nonce);
        if (r.status !== 200) return { status: r.status, ok: false };
        const v = verifyAddressProof(r.body, { peerId: PEER, for: address, nonce });
        return { status: 200, ok: v.ok, ...(v.ok ? { epoch: v.epoch, seq: v.seq } : {}) };
    };

    const reset = (c: { owner?: string[]; env?: string; cf?: string; pa?: unknown; names?: unknown[]; main?: string | null } = {}) => {
        if (c.env) process.env.BEANPOOL_ADDRESSES = c.env; else delete process.env.BEANPOOL_ADDRESSES;
        if (c.cf) process.env.CF_RECORD_NAME = c.cf; else delete process.env.CF_RECORD_NAME;
        se.updateNodeConfig({ publicAddress: (c.pa ?? null) as any, ownerAddresses: c.owner ?? [], registrarNames: (c.names ?? []) as any, mainAddress: c.main ?? null });
        own.forgetOwnAddresses();
    };
    const now = new Date().toISOString();
    const regName = (address: string, role: 'current' | 'former', status: string, extra: Record<string, unknown> = {}) => ({
        address, role, status, reason: null, since: now, formerSince: role === 'former' ? now : null, heldUntil: null,
        releasedByUsAt: null, renamedByUsAt: null, lost: null, ...extra,
    });

    try {
        // ── 1. S0's vectors ──
        console.log('\n=== 1. S0\'s vectors: the server signs the frozen list and the frozen proof ===\n');
        const kept = V.lists.kept.doc as SignedAddressList;
        reset({ env: 'coop.example.org,riverside.example,203.0.113.5', main: 'coop.example.org' });
        updateLocalConfig({ identityEpoch: 2 });
        const { v: _v, ...keptFields } = kept.list;
        se.updateNodeConfig({ addressList: keptFields });
        const r1 = await list();
        assert(r1.status === 200 && show(r1.body) === show(kept),
            `GET ${ADDRESS_LIST_PATH} with the vectors' key, community and addresses at (2, 14) is the frozen list, signature and all (${r1.status} ${show(r1.body).slice(0, 160)})`);
        assert(r1.headers['cache-control'] === 'no-store', `never cached (${r1.headers['cache-control']})`);
        const good = V.proofs.find((p: any) => p.name === 'good');
        const realNow = Date.now;
        let frozen: { status: number; body: any };
        Date.now = () => V.ts * 1000;
        try {
            frozen = await proof(good.question.for, good.question.nonce);
        } finally {
            Date.now = realNow;
        }
        assert(frozen.status === 200 && show(frozen.body) === show(good.answer),
            `the proof for ${good.question.for} at the vectors' time is the frozen proof, byte for byte (${frozen.status} ${show(frozen.body).slice(0, 160)})`);
        const wrongQuestions: string[] = [];
        for (const qn of V.questions as { for: unknown; nonce: unknown; refusal: 400 | 421 | null }[]) {
            const r = await proof(qn.for, qn.nonce);
            const want = qn.refusal ?? 200;
            let ok = r.status === want;
            if (ok && want === 200) ok = verifyAddressProof(r.body, { peerId: PEER, for: qn.for as string, nonce: qn.nonce as string }).ok;
            if (ok && want !== 200) ok = r.body?.code === (want === 400 ? 'bad_nonce' : 'not_listed');
            if (!ok) wrongQuestions.push(`${show(qn.for)} ${show(qn.nonce)} → ${r.status} (want ${want})`);
        }
        assert(wrongQuestions.length === 0, `each of the ${V.questions.length} frozen questions gets the frozen answer: a proof core verifies, 400 bad_nonce or 421 not_listed${wrongQuestions.length ? ` — ${wrongQuestions.join(' | ')}` : ''}`);

        // ── 2. The counter ──
        console.log('\n=== 2. The counter: up for each kind of change (one more, or the floor), none for no change ===\n');
        let prev = (await list()).body as SignedAddressList;
        assert(prev.list.seq === 14 && prev.list.epoch === 2, `it starts from the kept number (${prev.list.epoch}, ${prev.list.seq})`);
        const step = async (label: string, change: () => void | Promise<void>, bumps: boolean) => {
            await change();
            own.forgetOwnAddresses();
            const a = await list();
            const b = await list();
            const got = a.body as SignedAddressList;
            const sameKey = got.list?.peerId === prev.list.peerId;
            const choice = chooseAddressList(got, { peerId: got.list?.peerId ?? PEER, kept: sameKey ? prev : null });
            const want = bumps ? bumped(prev.list.seq) : prev.list.seq;
            // What a phone holding the list before makes of it: the same list kept; a newer one taken; another key's is a first
            // list of another community; the same key with another community id is refused (core's chooseAddressList).
            const okChoice = !bumps ? choice.action === 'keep' && choice.why === 'same'
                : !sameKey ? choice.action === 'replace' && choice.why === 'first'
                    : got.list.communityId !== prev.list.communityId ? choice.action === 'refuse' && choice.why === 'other-community'
                        : choice.action === 'replace' && choice.why === 'newer';
            assert(a.status === 200 && checkAddressList(a.body).ok && got.list.seq === want && got.list.epoch === prev.list.epoch
                && show(b.body) === show(a.body) && okChoice && al.keptAddressList()?.seq === want,
                `${label}: ${bumps ? `seq ${prev.list.seq} → ${want}` : `seq stays ${want}`}, and the next read is the same list (${a.status} seq ${got.list?.seq}, `
                + `${show(got.list?.addresses)} main ${got.list?.main}; a phone holding the one before: ${choice.action} ${(choice as any).why})`);
            prev = got;
        };
        await step('three more reads', async () => { await list(); await list(); }, false);
        await step('an own domain added', () => { se.updateNodeConfig({ ownerAddresses: ['second.example.org'] }); }, true);
        await step('the same owner list written again', () => { se.updateNodeConfig({ ownerAddresses: ['second.example.org'] }); }, false);
        await step('the same address in another spelling', () => { se.updateNodeConfig({ ownerAddresses: ['Second.Example.Org.'] }); }, false);
        await step('the main moved to it (Make main)', () => { own.setMainAddress('second.example.org'); }, true);
        await step('the main moved back', () => { own.setMainAddress('coop.example.org'); }, true);
        await step('the owner list in another order, with one more', () => { se.updateNodeConfig({ ownerAddresses: ['third.example.org', 'second.example.org'] }); }, true);
        await step('the owner list in another order again', () => { se.updateNodeConfig({ ownerAddresses: ['second.example.org', 'third.example.org'] }); }, false);
        await step('an own domain removed', () => { se.updateNodeConfig({ ownerAddresses: ['second.example.org'] }); }, true);
        await step("the operator's list gains a name", () => { process.env.BEANPOOL_ADDRESSES = 'coop.example.org,riverside.example,203.0.113.5,proxy.example.com'; }, true);
        await step("the operator's list gains a loopback name (never listed)", () => { process.env.BEANPOOL_ADDRESSES = 'coop.example.org,riverside.example,203.0.113.5,proxy.example.com,localhost'; }, false);
        await step("the operator's list loses the name", () => { process.env.BEANPOOL_ADDRESSES = 'coop.example.org,riverside.example,203.0.113.5'; }, true);
        await step('a hand-set name (CF_RECORD_NAME)', () => { process.env.CF_RECORD_NAME = 'hall.example.net'; }, true);
        await step('the hand-set name unset', () => { delete process.env.CF_RECORD_NAME; }, true);
        await step('a beanpool.org name claimed, waiting for approval (no route yet)', () => {
            se.updateNodeConfig({ publicAddress: { name: 'orchard', hostname: 'orchard.beanpool.org', status: 'pending', mode: 'direct' } as any });
        }, false);
        await step('the beanpool.org name goes live', () => {
            se.updateNodeConfig({ publicAddress: { name: 'orchard', hostname: 'orchard.beanpool.org', status: 'live', mode: 'direct' } as any });
        }, true);
        await step('a former beanpool.org name recorded (never listed)', () => {
            se.updateNodeConfig({ registrarNames: [regName('meadow.beanpool.org', 'former', 'released')] as any });
        }, false);
        await step('the live name marked lost', () => {
            se.updateNodeConfig({ registrarNames: [regName('meadow.beanpool.org', 'former', 'released'),
                regName('orchard.beanpool.org', 'current', 'live', { lost: { since: now, why: 'another-key', holderKey: null } })] as any });
        }, true);
        await step('the lost mark cleared', () => {
            se.updateNodeConfig({ registrarNames: [regName('meadow.beanpool.org', 'former', 'released'), regName('orchard.beanpool.org', 'current', 'live')] as any });
        }, true);
        await step('an unrelated setting (the area name)', () => { se.updateNodeConfig({ areaName: 'The valley' } as any); }, false);
        await step('the beanpool.org name let go', () => { se.updateNodeConfig({ publicAddress: null, registrarNames: [] as any }); }, true);
        await step('a port on the resolver\'s address', () => {
            se.updateNodeConfig({ publicAddress: { mode: 'own', hostname: 'coop.example.org:8443' } as any });
        }, true);
        assert(prev.list.addresses.includes('coop.example.org:8443') && prev.list.main === 'coop.example.org:8443',
            `the port survives into the list and the main (${show(prev.list.addresses)} main ${prev.list.main})`);
        await step('the port taken off', () => { se.updateNodeConfig({ publicAddress: null }); }, true);
        await step('another server key', async () => { await writeNodeKey(dataDir, V.keys.other.seedHex); }, true);
        assert(prev.list.peerId === V.keys.other.peerId, `the list names the other key now (${prev.list.peerId})`);
        await step('the key back', async () => { await writeNodeKey(dataDir, V.keys.community.seedHex); }, true);
        await step('another community id', () => { writeGenesis(dataDir, V.communityIds.other); }, true);
        await step('the community id back', () => { writeGenesis(dataDir, COMMUNITY); }, true);
        // The timer: a change no read saw is numbered by the tick, and the next read is that number, not one more.
        se.updateNodeConfig({ ownerAddresses: ['second.example.org', 'third.example.org'] });
        own.forgetOwnAddresses();
        al.tickAddressList();
        const ticked = al.keptAddressList();
        const afterTick = (await list()).body as SignedAddressList;
        assert(ticked?.seq === bumped(prev.list.seq) && afterTick.list.seq === ticked.seq && afterTick.list.addresses.includes('third.example.org'),
            `the timer's tick numbers a change no read saw (kept ${prev.list.seq} → ${ticked?.seq}), and the next read is that number (${afterTick.list.seq})`);
        prev = afterTick;

        // ── 3. Kept over a restart ──
        console.log('\n=== 3. Kept over a restart ===\n');
        const restartDir = fs.mkdtempSync(path.join(os.tmpdir(), 'address-list-restart-'));
        const firstAt = T0 + HOUR;
        const first = runChild(restartDir, 'first', { ADDRESS_TEST_CLOCK_MS: String(firstAt) });
        const f1 = floorAt(firstAt);
        assert(first && first.before === null && first.first?.ok && first.first.signed.list.seq === f1 && first.changed?.signed.list.seq === f1 + 1,
            `a first server numbers its first list at the floor (${f1}) and its first change one more on the same clock (${show(first?.first?.signed?.list?.seq)}, ${show(first?.changed?.signed?.list?.seq)})`);
        const again = runChild(restartDir, 'again', { ADDRESS_TEST_CLOCK_MS: String(firstAt + HOUR) });
        assert(again && again.kept?.seq === f1 + 1 && show(again.again?.signed) === show(first?.changed?.signed) && show(again.again2) === show(again.again),
            `started again on the same data dir an hour later, it signs the same list at the same number, signature and all: no bump for no change (${show(again?.again?.signed?.list?.seq)})`);
        assert(again && again.changed?.signed.list.seq === floorAt(firstAt + HOUR) && again.changed.signed.list.addresses.includes('third.example.org'),
            `and numbers its next change after it: that hour's floor, ${floorAt(firstAt + HOUR)} (${show(again?.changed?.signed?.list?.seq)})`);
        fs.rmSync(restartDir, { recursive: true, force: true });

        // ── 4. A take-over raises the epoch ──
        console.log('\n=== 4. A take-over raises the epoch; the envelope carries the main and the number ===\n');
        const before = (await list()).body as SignedAddressList;
        updateLocalConfig({ identityEpoch: 3, identityEpochSince: new Date().toISOString() });
        const raised = (await list()).body as SignedAddressList;
        assert(raised.list.epoch === 3 && raised.list.seq === before.list.seq && compareAddressNumbers(raised.list, before.list) === 1,
            `the list is signed at the new take-over count, the counter as it was (${before.list.epoch}.${before.list.seq} → ${raised.list.epoch}.${raised.list.seq})`);
        const c4 = chooseAddressList(raised, { peerId: PEER, kept: before });
        assert(c4.action === 'replace' && c4.why === 'newer', `a phone holding the list from before takes it (${c4.action} ${(c4 as any).why})`);
        // A promoted server's counter can be lower than the old server's: the take-over count still wins.
        const highOld = { ...before, list: { ...before.list, seq: before.list.seq + 50 } };
        se.updateNodeConfig({ addressList: { ...al.keptAddressList()!, seq: 1 } });
        const lowNew = (await list()).body as SignedAddressList;
        assert(lowNew.list.epoch === 3 && lowNew.list.seq === 1 && compareAddressNumbers(lowNew.list, highOld.list) === 1,
            `a list at take-over count 3 and counter 1 beats one at 2 and ${highOld.list.seq} (${compareAddressNumbers(lowNew.list, highOld.list)})`);
        prev = lowNew;
        await step('a change after the take-over (an own domain removed)', () => { se.updateNodeConfig({ ownerAddresses: ['second.example.org'] }); }, true);
        own.setMainAddress('second.example.org');
        const numbered = (await list()).body as SignedAddressList;
        prev = numbered;
        se.seedGenesisMember(crypto.randomBytes(32).toString('hex'), 'Olive');
        await env.makeRecoveryCode();
        const inputs = env.readSealingInputs();
        assert(inputs.ok && inputs.bundle.mainAddress === 'second.example.org' && show(inputs.bundle.addressList) === show(al.keptAddressList()),
            `the take-over envelope carries the owner's main address and the last list's number (${inputs.ok ? show({ main: inputs.bundle.mainAddress, seq: (inputs.bundle.addressList as any)?.seq, epoch: (inputs.bundle.addressList as any)?.epoch }) : inputs.state})`);
        assert(inputs.ok && show(al.readAddressListRecord(inputs.bundle.addressList)) === show(al.keptAddressList()),
            'and the take-over reads that number back as it was signed');
        own.setMainAddress('coop.example.org');

        // ── 5. The proof ──
        console.log('\n=== 5. The proof: only for the list, never by the Host header ===\n');
        reset({
            env: 'coop.example.org,riverside.example,203.0.113.5', owner: ['second.example.org'], main: 'coop.example.org',
            pa: { name: 'orchard', hostname: 'orchard.beanpool.org', status: 'live', mode: 'direct' },
            names: [regName('meadow.beanpool.org', 'former', 'released'), regName('willow.beanpool.org', 'former', 'live', { lost: { since: now, why: 'another-key', holderKey: null } })],
        });
        const onList = (await list()).body as SignedAddressList;
        assert(show(onList.list.addresses) === show(['203.0.113.5', 'coop.example.org', 'orchard.beanpool.org', 'riverside.example', 'second.example.org']),
            `the list: every published address with a route, none former or lost (${show(onList.list.addresses)})`);
        for (const a of onList.list.addresses) {
            const p = await proved(a);
            assert(p.status === 200 && p.ok && p.epoch === onList.list.epoch && p.seq === onList.list.seq, `${a}: proved, naming the list's number (${show(p)})`);
        }
        const offList: [string, unknown][] = [
            ['a former name', 'meadow.beanpool.org'], ['a lost name', 'willow.beanpool.org'], ['a removed address', 'third.example.org'],
            ['loopback by name', 'localhost'], ['loopback by number', '127.0.0.1'], ['IPv6 loopback', '[::1]'],
            ['another spelling: capitals', 'COOP.EXAMPLE.ORG'], ['another spelling: a trailing dot', 'coop.example.org.'],
            ['another spelling: port 443 written', 'coop.example.org:443'], ['another port', 'coop.example.org:8443'],
            ['a URL, not an address', 'https://coop.example.org'], ['another community\'s address', 'elsewhere.example'],
            ['none', undefined], ['two', ['coop.example.org']], ['empty', ''],
        ];
        for (const [what, a] of offList) {
            const r = await proof(a, newAddressProofNonce());
            assert(r.status === 421 && r.body?.code === 'not_listed' && !('sig' in (r.body ?? {})), `${what} (${show(a)}): 421 not_listed, nothing signed (${r.status} ${r.body?.code})`);
        }
        for (const [what, n] of [['no nonce', undefined], ['31 hex', 'a'.repeat(31)], ['upper case', 'A'.repeat(32)], ['not hex', 'z'.repeat(32)], ['two', ['0'.repeat(32)]], ['a line break', `${'0'.repeat(16)}\n${'0'.repeat(15)}`]] as [string, unknown][]) {
            const r = await proof('coop.example.org', n);
            assert(r.status === 400 && r.body?.code === 'bad_nonce', `${what}: 400 bad_nonce (${r.status} ${r.body?.code})`);
        }
        const forgedHostNonce = newAddressProofNonce();
        const forgedHost = await proof('coop.example.org', forgedHostNonce, { Host: 'elsewhere.example' });
        assert(forgedHost.status === 200 && verifyAddressProof(forgedHost.body, { peerId: PEER, for: 'coop.example.org', nonce: forgedHostNonce }).ok,
            `a Host header naming another address changes nothing: the proof is for the address asked (${forgedHost.status} for ${forgedHost.body?.for})`);
        const listedHost = await proof('elsewhere.example', newAddressProofNonce(), { Host: 'coop.example.org' });
        assert(listedHost.status === 421, `and a Host header naming a listed address signs nothing for an address off the list (${listedHost.status})`);
        const cors = await get(ADDRESS_PROOF_PATH + `?for=coop.example.org&nonce=${newAddressProofNonce()}`, { Origin: 'https://riverside.example' });
        const corsList = await get(ADDRESS_LIST_PATH, { Origin: 'https://riverside.example' });
        assert(cors.headers['access-control-allow-origin'] === '*' && corsList.headers['access-control-allow-origin'] === '*'
            && !cors.headers['access-control-allow-credentials'] && cors.headers['cache-control'] === 'no-store',
            `both reads are readable from another address's web app, with no credential, and never cached (${cors.headers['access-control-allow-origin']}, ${corsList.headers['access-control-allow-origin']}, ${cors.headers['cache-control']})`);

        // ── 6. The table ──
        console.log('\n=== 6. The table: each address kind × main, other, was main, removed, former, lost ===\n');
        type Cfg = Parameters<typeof reset>[0];
        interface Kind {
            name: string; x: string; host: string; companion: string;
            present: (main?: string | null) => Cfg; absent: (main?: string | null) => Cfg;
            former?: () => Cfg; lost?: () => Cfg; outside: string | null;
        }
        const live = (n: string) => ({ name: n, hostname: `${n}.beanpool.org`, status: 'live', mode: 'direct' });
        const KINDS: Kind[] = [
            {
                name: 'a beanpool.org name', x: 'orchard.beanpool.org', host: 'orchard.beanpool.org', companion: 'second.example.org',
                present: (main) => ({ pa: live('orchard'), owner: ['second.example.org'], main }),
                absent: (main) => ({ owner: ['second.example.org'], names: [regName('orchard.beanpool.org', 'former', 'released', { releasedByUsAt: now })], main }),
                former: () => ({ pa: live('meadow'), owner: ['second.example.org'], names: [regName('orchard.beanpool.org', 'former', 'live', { renamedByUsAt: now })] }),
                lost: () => ({ pa: live('orchard'), owner: ['second.example.org'], names: [regName('orchard.beanpool.org', 'current', 'live', { lost: { since: now, why: 'another-key', holderKey: null } })] }),
                outside: 'https://orchard.beanpool.org',
            },
            {
                name: 'an own domain', x: 'coop.example.org', host: 'coop.example.org', companion: 'second.example.org',
                present: (main) => ({ owner: ['second.example.org', 'coop.example.org'], main }), absent: (main) => ({ owner: ['second.example.org'], main }),
                outside: 'https://coop.example.org',
            },
            {
                name: 'a hand-set name', x: 'hall.example.net', host: 'hall.example.net', companion: 'second.example.org',
                present: (main) => ({ cf: 'hall.example.net', owner: ['second.example.org'], main }), absent: (main) => ({ owner: ['second.example.org'], main }),
                outside: 'https://hall.example.net',
            },
            {
                name: "the operator's list", x: 'proxy.example.com', host: 'proxy.example.com', companion: 'second.example.org',
                present: (main) => ({ env: 'proxy.example.com', owner: ['second.example.org'], main }), absent: (main) => ({ owner: ['second.example.org'], main }),
                outside: 'https://proxy.example.com',
            },
            {
                name: 'a public number', x: '203.0.113.5', host: '203.0.113.5', companion: '198.51.100.7',
                present: (main) => ({ owner: ['198.51.100.7', '203.0.113.5'], main }), absent: (main) => ({ owner: ['198.51.100.7'], main }),
                outside: 'https://203.0.113.5',
            },
            {
                name: 'an IPv6 number', x: '[2001:db8::5]', host: '[2001:db8::5]', companion: '203.0.113.9',
                present: (main) => ({ owner: ['203.0.113.9', '[2001:db8::5]'], main }), absent: (main) => ({ owner: ['203.0.113.9'], main }),
                outside: 'https://[2001:db8::5]',
            },
            {
                name: 'a home-network name', x: 'nas.local', host: 'nas.local', companion: '192.168.1.20',
                present: (main) => ({ owner: ['192.168.1.20', 'nas.local'], main }), absent: (main) => ({ owner: ['192.168.1.20'], main }),
                outside: null,
            },
            {
                name: 'a name at a port', x: 'portal.example.org:8443', host: 'portal.example.org', companion: 'second.example.org',
                present: (main) => ({ pa: { mode: 'own', hostname: 'portal.example.org:8443' }, owner: ['second.example.org'], main }),
                absent: (main) => ({ owner: ['second.example.org'], main }),
                outside: 'https://portal.example.org:8443',
            },
        ];
        const rows: string[] = [];
        const wrong: string[] = [];
        const row = async (k: Kind, role: string, want: { listed: boolean; main: boolean; proved: boolean; outside?: string | null }) => {
            const r = await list();
            const doc = r.body as SignedAddressList;
            const valid = r.status === 200 && checkAddressList(r.body).ok && doc.list.peerId === PEER;
            const listed = valid && doc.list.addresses.includes(k.x);
            const isMain = valid && doc.list.main === k.x;
            const p = await proved(k.x);
            const companion = await proved(k.companion);
            const outside = own.mainPublicUrl();
            const line = `${k.name} (${k.x}) × ${role} → ${listed ? 'listed' : 'not listed'}, ${isMain ? 'main' : `main ${valid ? doc.list.main : '?'}`}, `
                + `proof ${p.status}${p.status === 200 ? (p.ok ? ' verified' : ' NOT verified') : ''}; ${k.companion} ${companion.status}`
                + `${want.outside !== undefined ? `; outside readers: ${outside}` : ''}`;
            rows.push(line);
            const ok = valid && listed === want.listed && isMain === want.main && (want.proved ? p.status === 200 && p.ok : p.status === 421)
                && companion.status === 200 && companion.ok && (want.outside === undefined || outside === want.outside);
            if (!ok) wrong.push(line);
        };
        for (const k of KINDS) {
            reset(k.present());
            const refusal = own.mainAddressRefusal(k.host);
            reset(k.present(k.host));
            await row(k, 'main', { listed: true, main: true, proved: true, outside: k.outside });
            if (refusal) wrong.push(`${k.name}: Make main refused (${refusal})`);
            reset(k.present(k.companion));
            await row(k, 'other', { listed: true, main: false, proved: true });
            reset(k.present(k.host));
            await list();
            own.setMainAddress(k.companion);
            await row(k, 'was main', { listed: true, main: false, proved: true });
            reset(k.present(k.host));
            await list();
            reset(k.absent(k.host));
            await row(k, 'removed', { listed: false, main: false, proved: false });
            if (k.former) {
                reset(k.former());
                await row(k, 'former', { listed: false, main: false, proved: false });
            } else {
                rows.push(`${k.name} × former → no such state: only a beanpool.org name becomes former (a removed one is the row above)`);
            }
            if (k.lost) {
                reset(k.lost());
                await row(k, 'lost', { listed: false, main: false, proved: false });
            }
        }
        console.log(`  ${rows.join('\n  ')}`);
        assert(wrong.length === 0, `every kind × role gives the outcome in the table (${rows.length} rows)${wrong.length ? ` — wrong: ${wrong.join(' | ')}` : ''}`);
        assert(rows.length === KINDS.length * 5 + 1, `the table has every row: ${KINDS.length} kinds × main, other, was main, removed, former, and a lost beanpool.org name (${rows.length})`);

        // ── 7. A restore or a roll-back never takes the number back ──
        console.log('\n=== 7. A restore or a roll-back never takes the number back (real state.db files, a process per boot) ===\n');
        const num = (s: SignedAddressList | undefined) => (s?.list ? `${s.list.epoch}.${s.list.seq}` : show(s));
        const phoneTakes = (offered: SignedAddressList | undefined, held: SignedAddressList | undefined): string => {
            if (!offered?.list || !held?.list) return 'nothing to compare';
            const c = chooseAddressList(offered, { peerId: PEER, kept: held });
            return `${c.action} ${(c as any).why}`;
        };
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'address-list-restore-'));
        try {
            // 7a. The deciding review's case: a list signed before the nightly backup, a newer one at noon, the server lost,
            // the nightly file restored onto a fresh machine an hour later.
            const lost = path.join(work, 'lost'), nightly = path.join(work, 'nightly'), fresh = path.join(work, 'fresh');
            fs.mkdirSync(lost);
            const night = runSpec(lost, { clock: T0 });
            copyDatabase(lost, nightly);
            const noon = runSpec(lost, { clock: T0 + 12 * HOUR, owner: ['second.example.org'] });
            restoreOntoFreshMachine(lost, nightly, fresh);
            const back = runSpec(fresh, { clock: T0 + 13 * HOUR, boot: true, then: ['third.example.org'] });
            const L0 = night?.signed as SignedAddressList, L1 = noon?.signed as SignedAddressList;
            const R1 = back?.signed as SignedAddressList, R2 = back?.then as SignedAddressList;
            assert(L0?.list && L1?.list && compareAddressNumbers(L1.list, L0.list) === 1 && back?.delivered === 1,
                `the lost server signed ${num(L0)} before the nightly backup and ${num(L1)} at noon; the restored server's boot delivered the notice (${back?.delivered})`);
            assert(R1?.list && L1?.list && compareAddressNumbers(R1.list, L1.list) === 1 && phoneTakes(R1, L1) === 'replace newer',
                `restored from the nightly file onto a fresh machine, its first list (${num(R1)}) outranks the newest the lost server signed (${num(L1)}), no address changed: a phone holding that one takes it (${phoneTakes(R1, L1)})`);
            assert(R2?.list && R1?.list && L1?.list && compareAddressNumbers(R2.list, R1.list) === 1 && compareAddressNumbers(R2.list, L1.list) === 1 && phoneTakes(R2, R1) === 'replace newer',
                `and the owner's next change (${num(R2)}) is above both, never the lost server's noon number with other content (${phoneTakes(R2, R1)})`);

            // 7b. The same after a past take-over: the lost server was a promoted one (take-over count 1) and the backup is
            // database-only, so neither the fresh local-config.json nor the notice says 1; the record restored does.
            const lostB = path.join(work, 'lost-b'), nightlyB = path.join(work, 'nightly-b'), freshB = path.join(work, 'fresh-b');
            fs.mkdirSync(lostB);
            const nightB = runSpec(lostB, { clock: T0, epoch: 1 });
            copyDatabase(lostB, nightlyB);
            const noonB = runSpec(lostB, { clock: T0 + 12 * HOUR, owner: ['second.example.org'] });
            restoreOntoFreshMachine(lostB, nightlyB, freshB);
            const backB = runSpec(freshB, { clock: T0 + 13 * HOUR, boot: true, then: ['third.example.org'] });
            const B1 = noonB?.signed as SignedAddressList, BR = backB?.signed as SignedAddressList, BR2 = backB?.then as SignedAddressList;
            assert(nightB?.signed?.list?.epoch === 1 && B1?.list?.epoch === 1, `the promoted server signed at take-over count 1 (${num(nightB?.signed)}, ${num(B1)})`);
            assert(BR?.list?.epoch === 1 && BR2?.list?.epoch === 1 && B1?.list && compareAddressNumbers(BR.list, B1.list) === 1 && phoneTakes(BR, B1) === 'replace newer',
                `restored onto a fresh machine from a database-only backup, it signs at take-over count 1, never 0 (${num(BR)}, then ${num(BR2)}), above the lost server's ${num(B1)} (${phoneTakes(BR, B1)})`);

            // 7c. A roll-back through the real rollBackTo: a point taken, a newer list, rolled back to the point.
            const rb = path.join(work, 'roll-back');
            fs.mkdirSync(rb);
            const before = runSpec(rb, { clock: T0, point: true });
            const rolled = runSpec(rb, { clock: T0 + HOUR, owner: ['second.example.org'], rollBackTo: before?.point });
            const after = runSpec(rb, { clock: T0 + HOUR + 60_000, boot: true, then: ['third.example.org'] });
            const P1 = rolled?.signed as SignedAddressList, PR = after?.signed as SignedAddressList, PR2 = after?.then as SignedAddressList;
            const carried = rolled?.notices?.[0]?.addressList;
            assert(before?.point && rolled?.notices?.length === 1 && rolled.notices[0].kind === 'roll-back' && P1?.list
                && carried?.epoch === P1.list.epoch && carried?.seq === P1.list.seq,
                `the real roll-back's notice carries the number signed before it (${show(carried ? { epoch: carried.epoch, seq: carried.seq } : carried)}; signed ${num(P1)})`);
            assert(PR?.list && P1?.list && compareAddressNumbers(PR.list, P1.list) === 1 && phoneTakes(PR, P1) === 'replace newer' && PR2?.list && compareAddressNumbers(PR2.list, PR.list) === 1,
                `rolled back to the point taken at ${num(before?.signed)}, its first list (${num(PR)}) outranks the one signed before the roll-back (${num(P1)}; ${phoneTakes(PR, P1)}), and its next change goes on above (${num(PR2)})`);

            // 7d. A clock far behind (2025: the floor is 0).
            const behind = Date.UTC(2025, 0, 1);
            const rbBehind = path.join(work, 'roll-back-behind');
            fs.mkdirSync(rbBehind);
            const bBefore = runSpec(rbBehind, { clock: T0, point: true });
            const bRolled = runSpec(rbBehind, { clock: T0 + HOUR, owner: ['second.example.org'], rollBackTo: bBefore?.point });
            const bAfter = runSpec(rbBehind, { clock: behind, boot: true });
            const bP1 = bRolled?.signed as SignedAddressList, bPR = bAfter?.signed as SignedAddressList;
            assert(bPR?.list && bP1?.list && bPR.list.seq === bP1.list.seq + 1 && compareAddressNumbers(bPR.list, bP1.list) === 1
                && !/behind the address list's number/.test(bAfter?.output ?? ''),
                `with the clock far behind, a roll-back still outranks what was signed before it: the notice carries that number, the boot goes one past it, and no clock warning (nothing can outrank it) (${num(bP1)} → ${num(bPR)})`);
            const freshBehind = path.join(work, 'fresh-behind');
            restoreOntoFreshMachine(lost, nightly, freshBehind);
            const fBehind = runSpec(freshBehind, { clock: behind, boot: true });
            const fR = fBehind?.signed as SignedAddressList;
            assert(fR?.list && L0?.list && fR.list.seq === L0.list.seq + 1 && compareAddressNumbers(fR.list, L0.list) === 1
                && /behind the address list's number/.test(fBehind?.output ?? ''),
                `restored onto a fresh machine with the clock far behind, it falls back to the kept seq + 1 (${num(L0)} → ${num(fR)}), above all the backup kept, and the boot logs that the clock is behind `
                + `(the module comment's limit: the lost server's noon list ${num(L1)} can outrank it until the clock is right)`);
        } finally {
            fs.rmSync(work, { recursive: true, force: true });
        }

        // ── 8. The table ──
        console.log('\n=== 8. The table: restart, change, no change, restore, restore on a fresh machine, roll-back, take-over ===\n');
        const EVENTS = ['restart', 'change', 'no change', 'restore', 'restore on a fresh machine', 'roll-back', 'take-over'] as const;
        type Event = typeof EVENTS[number];
        interface Snap {
            node: { addressList: unknown; ownerAddresses: string[]; mainAddress: string | null };
            local: { identityEpoch: number; identityEpochSince: string | null; restoredCopy: unknown };
        }
        const snap = (): Snap => {
            const n = se.getNodeConfig() as any;
            const c = getLocalConfig() as any;
            return {
                node: { addressList: n.addressList ?? null, ownerAddresses: [...(n.ownerAddresses ?? [])], mainAddress: n.mainAddress ?? null },
                local: { identityEpoch: ie.ownIdentityEpoch().epoch, identityEpochSince: c.identityEpochSince ?? null, restoredCopy: c.restoredCopy ?? null },
            };
        };
        const putNode = (s: Snap) => se.updateNodeConfig({ addressList: s.node.addressList, ownerAddresses: s.node.ownerAddresses, mainAddress: s.node.mainAddress } as any);
        /** The notice a restore or a roll-back leaves, delivered as index.ts wires step 2.52. */
        const deliver = (notice: Record<string, unknown>) => {
            rp.leaveRestoreNotice({ at: new Date(clock).toISOString(), madeAt: null, point: 'table', by: 'owner', ...notice } as any);
            return rp.deliverRestoreNotices({ announce: () => {}, log: () => {}, remember: lo.noteRestoredCopy, renumber: alAny.renumberAddressListAfterSwap } as any);
        };
        // `point`: a restore point on this machine, taken at the start. `backup`: the community's newest nightly backup, taken
        // at the start and again after a take-over (the promoted server's own): restoring one made before a take-over onto a
        // fresh machine takes the identity epoch itself back (identity-epoch.ts), the limit the PR names.
        let point: Snap = snap();
        let backup: Snap = snap();
        const apply = (e: Event): void => {
            clock += 60_000;
            const owners = ((se.getNodeConfig() as any).ownerAddresses ?? []) as string[];
            if (e === 'change') {
                se.updateNodeConfig({ ownerAddresses: owners.includes('third.example.org') ? owners.filter((a) => a !== 'third.example.org') : [...owners, 'third.example.org'] });
            } else if (e === 'no change') {
                se.updateNodeConfig({ ownerAddresses: [...owners] });
            } else if (e === 'restore') {
                // On this machine: state.db goes back, local-config.json stays; the notice carries the list last signed.
                const going = alAny.addressListForNotice?.() ?? null;
                putNode(point);
                deliver({ kind: 'restore', epoch: point.local.identityEpoch, addressList: going });
            } else if (e === 'restore on a fresh machine') {
                // The newest backup onto a machine with no local-config.json; database-only (no take-over count), and the
                // fresh machine had signed nothing.
                putNode(backup);
                updateLocalConfig({ identityEpoch: 0, identityEpochSince: null, restoredCopy: null } as any);
                deliver({ kind: 'restore', epoch: 0, addressList: null });
            } else if (e === 'roll-back') {
                // state.db and local-config.json both go back to the point's; the notice carries the list last signed.
                const going = alAny.addressListForNotice?.() ?? null;
                putNode(point);
                updateLocalConfig({ identityEpoch: point.local.identityEpoch, identityEpochSince: point.local.identityEpochSince, restoredCopy: point.local.restoredCopy } as any);
                deliver({ kind: 'roll-back', addressList: going });
            } else if (e === 'take-over') {
                // What the take-over's steps write (services/takeover.ts): `public-address` keeps the carried list through
                // addressListAfterTakeover, `role` writes the keys' count + 1 (the keys carry local-config's count).
                const carried = al.keptAddressList();
                const keysEpoch = ie.ownIdentityEpoch().epoch;
                if (carried) se.updateNodeConfig({ addressList: alAny.addressListAfterTakeover ? alAny.addressListAfterTakeover(carried, keysEpoch) : carried } as any);
                updateLocalConfig({ identityEpoch: keysEpoch + 1, identityEpochSince: new Date(clock).toISOString() });
            }
            own.forgetOwnAddresses();
        };
        const contentOf = (l: SignedAddressList['list']) => show({ peerId: l.peerId, communityId: l.communityId, main: l.main, addresses: [...l.addresses].sort(), spares: [...l.spares].sort() });
        /** A world of its own (no list kept, take-over count 0, never restored): a change since the backup, then `events`. */
        const runWorld = async (events: Event[]): Promise<{ line: string; problems: string[] }> => {
            reset({ env: 'coop.example.org', owner: ['second.example.org'], main: 'coop.example.org' });
            se.updateNodeConfig({ addressList: null } as any);
            updateLocalConfig({ identityEpoch: 0, identityEpochSince: null, restoredCopy: null } as any);
            const history: { epoch: number; seq: number; content: string; after: string }[] = [];
            const trail: string[] = [];
            const problems: string[] = [];
            const sign = async (after: string) => {
                let r: Awaited<ReturnType<typeof list>>;
                try {
                    r = await list();
                } catch (e: any) {
                    problems.push(`${after}: the read failed (${e?.message || e})`);
                    return;
                }
                const l = (r.body as SignedAddressList)?.list;
                if (r.status !== 200 || !l) {
                    problems.push(`${after}: no list (${r.status} ${show(r.body).slice(0, 120)})`);
                    return;
                }
                const me = { epoch: l.epoch, seq: l.seq, content: contentOf(l), after };
                for (const h of history) {
                    const order = compareAddressNumbers(me, h);
                    if (order < 0) problems.push(`${after} signed ${me.epoch}.${me.seq}, below ${h.epoch}.${h.seq} (signed after ${h.after})`);
                    else if (order === 0 && h.content !== me.content) problems.push(`${after} signed ${me.epoch}.${me.seq} with other content than after ${h.after}`);
                }
                const last = history[history.length - 1];
                if (last && (after === 'restart' || after === 'no change') && compareAddressNumbers(me, last) !== 0) {
                    problems.push(`${after} moved the number (${last.epoch}.${last.seq} → ${me.epoch}.${me.seq})`);
                }
                if (after === 'take-over' && history.some((h) => h.epoch >= me.epoch)) {
                    problems.push(`the take-over signed at epoch ${me.epoch}, not above every epoch before it (${Math.max(...history.map((h) => h.epoch))})`);
                }
                history.push(me);
                trail.push(`${after} ${me.epoch}.${me.seq}`);
            };
            await sign('start');
            point = snap();
            backup = snap();
            for (const e of ['change', ...events] as Event[]) {
                apply(e);
                await sign(e);
                if (e === 'take-over') backup = snap();
            }
            return { line: trail.join(' → '), problems };
        };
        const tableRowsB: string[] = [];
        const tableWrong: string[] = [];
        const worlds: Event[][] = [];
        for (const e1 of EVENTS) for (const e2 of EVENTS) worlds.push([e1, e2, 'change']);
        // And the longer ones a pair cannot hold: a take-over after a restore onto a fresh machine that followed a take-over
        // (the list's epoch is then above the keys'), a roll-back across a take-over and a take-over after it, the same
        // backup restored twice, two roll-backs to one point.
        worlds.push(['take-over', 'restore on a fresh machine', 'take-over', 'change'], ['take-over', 'roll-back', 'take-over', 'change'],
            ['restore', 'restore', 'change'], ['roll-back', 'change', 'roll-back', 'change']);
        for (const events of worlds) {
            const w = await runWorld(events);
            tableRowsB.push(`${events.join(', ')}: ${w.line}`);
            if (w.problems.length) tableWrong.push(`${events.join(', ')}: ${w.problems.join('; ')}`);
        }
        console.log(`  ${tableRowsB.join('\n  ')}`);
        assert(tableWrong.length === 0, `in each of the ${worlds.length} sequences every list is at or above every list signed before it and strictly above each with other content; `
            + `a restart or no change keeps the number; a take-over's epoch is above every epoch before it${tableWrong.length ? ` — wrong: ${tableWrong.join(' | ')}` : ''}`);
        assert(tableRowsB.length === EVENTS.length * EVENTS.length + 4, `the table has every pair (${EVENTS.length} × ${EVENTS.length}) and the 4 longer sequences (${tableRowsB.length})`);

        // ── 9. The split-brain check asks every listed address ──
        console.log('\n=== 9. The split-brain check asks every listed address; once replaced, nothing is signed ===\n');
        reset({ env: 'coop.example.org,riverside.example,203.0.113.5', owner: ['second.example.org'], main: 'coop.example.org' });
        const listedNow = ((await list()).body as SignedAddressList).list.addresses;
        process.env.BEANPOOL_TEST_IDENTITY_EPOCH_URL = 'https://127.0.0.1:9/test-epoch';
        assert(show(ie.ownEpochUrls()) === show(['https://127.0.0.1:9/test-epoch']), `a suite's stand-in address is asked alone, as before (${show(ie.ownEpochUrls())})`);
        delete process.env.BEANPOOL_TEST_IDENTITY_EPOCH_URL;
        // One local server per listed address. Each answers this server's own statement, or, when told, a newer take-over's.
        const identity = env.readNodeIdentity()!;
        const ownStatement = ie.currentSignedEpoch()!;
        const newer = ie.signEpochStatement({ v: 1, peerId: identity.peerId, communityId: COMMUNITY, epoch: ie.ownIdentityEpoch().epoch + 1, since: new Date().toISOString() }, identity.seed);
        const hits = new Map<string, number>();
        const answerNewerAt = new Set<string>();
        const fakes: http.Server[] = [];
        const origins: Record<string, string> = {};
        for (const a of listedNow) {
            const srv = http.createServer((req, res) => {
                hits.set(a, (hits.get(a) ?? 0) + 1);
                res.writeHead(req.url === '/api/node/identity-epoch' ? 200 : 404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(answerNewerAt.has(a) ? newer : ownStatement));
            });
            await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
            fakes.push(srv);
            origins[a] = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
        }
        ie.askAddressesAtForTests(origins);
        assert(show(ie.ownEpochUrls()) === show(listedNow.map((a) => `${origins[a]}/api/node/identity-epoch`)),
            `the check asks every address on the list (${listedNow.length}: ${listedNow.join(', ')})`);
        const current = await ie.checkIdentityEpoch();
        assert(current.state === 'current' && listedNow.every((a) => (hits.get(a) ?? 0) >= 1),
            `with every address answering this server, it is current, and every one was asked (${current.state}; ${show(Object.fromEntries(hits))})`);
        const stillOk = await proved('coop.example.org');
        assert(stillOk.status === 200 && stillOk.ok, `and still proves (${stillOk.status})`);
        const last = listedNow[listedNow.length - 1];
        answerNewerAt.add(last);
        hits.clear();
        const replaced = await ie.checkIdentityEpoch();
        assert(replaced.state === 'replaced' && (replaced as any).url === `${origins[last]}/api/node/identity-epoch` && (replaced as any).seen === newer.statement.epoch,
            `one address (${last}, the last on the list) leading to a newer take-over replaces this server (${replaced.state} at ${(replaced as any).url})`);
        const refusedList = await list();
        const refusedProof = await proof('coop.example.org', newAddressProofNonce());
        assert(refusedList.status === 503 && refusedList.body?.code === 'replaced' && refusedList.body?.readOnly === true && !refusedList.body?.sig,
            `once replaced, the list is refused: 503 replaced, nothing signed (${refusedList.status} ${refusedList.body?.code})`);
        assert(refusedProof.status === 503 && refusedProof.body?.code === 'replaced' && !refusedProof.body?.sig,
            `and so is every proof, for an address on the list too (${refusedProof.status} ${refusedProof.body?.code})`);
        const keptBefore = show(al.keptAddressList());
        se.updateNodeConfig({ ownerAddresses: ['second.example.org', 'third.example.org'] });
        own.forgetOwnAddresses();
        al.tickAddressList();
        await list();
        assert(show(al.keptAddressList()) === keptBefore, 'and a replaced server numbers no new list, whatever changes');
        ie.askAddressesAtForTests(null);
        for (const f of fakes) f.close();

        console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    } catch (e: any) {
        console.error(`❌ ${e?.stack || e}`);
        process.exitCode = 1;
    }
    if (testsPassed !== testsRun) process.exitCode = 1;
    process.exit(process.exitCode ?? 0);
}

if (process.argv.includes('--child')) {
    child(process.argv[process.argv.indexOf('--child') + 1]).catch((e) => { console.error(e); process.exit(1); });
} else {
    main().catch((e) => { console.error(e); process.exit(1); });
}
