/**
 * One spelling of an address, end to end (several addresses S8 round 2, PR #3260's deciding review): every place an address
 * passes between the server, the take-over envelope, the signed list and the phone uses core's one spelling (addressOf:
 * `host`, or `host:port`), port included, and nothing splits a host from its port but core's spelling.
 *
 * The table: each address kind (a name, a name at a port, an IPv4 number, one at a port, an IPv6 number, one at a port, a
 * home-network number), written as an owner might type it, goes
 *   1. through the real spares route (POST /api/local/admin/app-addresses/spares, the real HTTPS server and every
 *      middleware, an owner's fresh phone session): stored, and named in the signed list's `spares`, in the one spelling;
 *   2. into the take-over envelope (readSealingInputs: the bundle the main server seals), exactly as stored;
 *   3. through the take-over's `public-address` step (services/takeover.ts takeOverAddresses) on a standby whose own web
 *      address it is, the port known only from that web address, which the step replaces with the main server's: the
 *      promoted list (GET /api/node/addresses, at take-over count + 1) names it as an address, spelled exactly the same, and
 *      no longer as a spare; a request signed for its host is this community's; the address stays spelled so after an
 *      owner removes another address in Settings (the owner-confirmed list keeps its port);
 *   4. to the phone: it proves at that spelling with the community's key (core verifyAddressProof), the phone takes the
 *      promoted list as newer (core chooseAddressList) and goes to the spare (core takeSpare, the phone's own decision).
 * A spare naming the standby's host at another port than it answers on is not where it answers: it stays a spare.
 *
 * Mutation (checked by hand when this was written): the step writing the spare's host alone, as before round 2, turns
 * every ported row red at 3 and 4.
 *
 * Run: SERVER_SUITES_ONLY=test-address-spelling TEST_ALL_JOBS=2 node scripts/run-server-suites.mjs
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
for (const k of ['CF_RECORD_NAME', 'BEANPOOL_ADDRESSES', 'PUBLIC_ADDRESS_NAME', 'PUBLIC_ADDRESS_AUTO', 'PUBLIC_IP', 'NODE_ROLE', 'BEANPOOL_TEST_IDENTITY_EPOCH_URL']) {
    delete process.env[k];
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { privateKeyFromRaw, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
    ADDRESS_LIST_PATH, ADDRESS_PROOF_PATH, addressOf, checkAddressList, chooseAddressList, newAddressProofNonce, takeSpare,
    verifyAddressProof, type SignedAddressList,
} from '@beanpool/core';

const V = createRequire(import.meta.url)('@beanpool/core/vectors/address-list.json');

let testsRun = 0;
let testsPassed = 0;
function assert(cond: unknown, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        // Counted, and the run goes on, so one run reports every row that fails.
        console.error(`✗ ${msg}`);
    }
}
const show = (v: unknown) => JSON.stringify(v);

/** Each kind: as an owner might type it, and its one spelling. */
const KINDS: { kind: string; typed: string; spelled: string }[] = [
    { kind: 'a name', typed: 'Standby.Example.NET.', spelled: 'standby.example.net' },
    { kind: 'a name at a port', typed: 'https://Standby.Example.NET:8443/', spelled: 'standby.example.net:8443' },
    { kind: 'an IPv4 number', typed: '198.51.100.7', spelled: '198.51.100.7' },
    { kind: 'an IPv4 number at a port', typed: 'https://198.51.100.7:8443', spelled: '198.51.100.7:8443' },
    { kind: 'an IPv6 number', typed: '[2001:DB8:0:0::7]', spelled: '[2001:db8::7]' },
    { kind: 'an IPv6 number at a port', typed: 'https://[2001:db8:0::7]:8443/', spelled: '[2001:db8::7]:8443' },
    { kind: 'a home-network number', typed: '192.168.1.20:8443', spelled: '192.168.1.20:8443' },
];

async function main(): Promise<void> {
    const dataDir = process.env.BEANPOOL_DATA_DIR;
    if (!dataDir) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    fs.mkdirSync(dataDir, { recursive: true });
    const seed = new Uint8Array(Buffer.from(V.keys.community.seedHex, 'hex'));
    const key = privateKeyFromRaw(new Uint8Array([...seed, ...ed25519.getPublicKey(seed)]));
    fs.writeFileSync(path.join(dataDir, 'libp2p_key'), privateKeyToProtobuf(key), { mode: 0o600 });
    fs.writeFileSync(path.join(dataDir, 'genesis.json'), JSON.stringify({
        communityId: V.communityIds.community, publicKey: '00'.repeat(32), genesisHash: '11'.repeat(32), createdAt: '2026-11-16T00:00:00.000Z',
    }));

    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { getLocalConfig, updateLocalConfig } = await import('./config/local-config.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const own = await import('./engine/own-addresses.js');
    const env = await import('./services/takeover-envelope.js');
    const { takeOverAddresses } = await import('./services/takeover.js');
    const { ownerPhoneSessionHeaders, seedOwnerForTests } = await import('./admin-auth-test-harness.js');

    await initTls();
    se.initStateEngine();
    const httpsServer = await import('./https-server.js');
    const BASE = `https://127.0.0.1:${await httpsServer.startHttpsServer(0)}`;
    const PEER = V.keys.community.peerId as string;
    se.seedGenesisMember(crypto.randomBytes(32).toString('hex'), 'Olive');
    const ownerKey = seedOwnerForTests('Anna');
    /** The owner's phone hand-off, just unlocked: the fresh proof an owner's change asks (admin-auth.ts requireFreshProof). */
    const owner = () => ownerPhoneSessionHeaders(ownerKey);

    const call = async (method: 'GET' | 'POST', p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
        pruneAuthAttempts(Date.now() + 120_000);
        resetGatewayRateLimit();
        const res = await fetch(`${BASE}${p}`, {
            method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await res.text();
        let json: any = null;
        try { json = JSON.parse(text); } catch { json = text; }
        return { status: res.status, body: json };
    };
    const signedList = async (): Promise<SignedAddressList | null> => {
        const r = await call('GET', ADDRESS_LIST_PATH);
        return r.status === 200 && checkAddressList(r.body).ok ? r.body as SignedAddressList : null;
    };
    /** As the phone asks (address-verify.ts proofAt): `for` the address in its one spelling, a fresh nonce, verified by core. */
    const proveAt = async (address: string) => {
        const nonce = newAddressProofNonce();
        const r = await call('GET', `${ADDRESS_PROOF_PATH}?for=${encodeURIComponent(address)}&nonce=${nonce}`);
        if (r.status !== 200) return { status: r.status, verdict: null };
        return { status: 200, verdict: verifyAddressProof(r.body, { peerId: PEER, for: address, nonce }) };
    };
    /** The community's main server, as each row starts: its registrar name, one address an owner confirmed, no spares. */
    const asMainServer = () => {
        se.updateNodeConfig({
            publicAddress: { name: 'coop', mode: 'direct', hostname: 'coop.example.org', status: 'live' },
            ownerAddresses: ['owner-confirmed.example'], addressSpares: [], mainAddress: null, registrarNames: [],
        } as any);
        own.forgetOwnAddresses();
    };
    /** A standby whose own web address is `address` (its port known from nothing else), with nothing of the community's. */
    const asStandbyAt = (address: string) => {
        se.updateNodeConfig({ publicAddress: address, ownerAddresses: [], addressSpares: [], mainAddress: null, registrarNames: [] } as any);
        own.forgetOwnAddresses();
    };
    /** A take-over from `bundle`: the `public-address` step (the code under test), and the count the `role` step writes. */
    const takeOver = (bundle: any) => {
        takeOverAddresses(bundle, bundle.publicAddress);
        updateLocalConfig({ identityEpoch: (Number(bundle.identityEpoch) || 0) + 1, identityEpochSince: new Date().toISOString() });
    };
    const sealedBundle = async () => {
        await env.flushTakeoverChecks();
        const inputs = env.readSealingInputs();
        return inputs.ok ? inputs.bundle : null;
    };

    try {
        await env.makeRecoveryCode();
        for (const k of KINDS) {
            console.log(`\n— ${k.kind}: ${show(k.typed)} → ${k.spelled} —`);
            asMainServer();
            // 1. The route takes it, in the one spelling.
            const added = await call('POST', '/api/local/admin/app-addresses/spares', { action: 'add', address: k.typed }, owner());
            assert(added.status === 200 && show(added.body?.spares) === show([k.spelled]),
                `${k.kind}: the spares route stores it as ${k.spelled} (${added.status} ${show(added.body?.spares ?? added.body)})`);
            const held = await signedList();
            assert(!!held && show(held.list.spares) === show([k.spelled]) && !held.list.addresses.includes(k.spelled),
                `${k.kind}: the main server's signed list names it in its spares, spelled ${k.spelled} (${show(held?.list.spares)})`);
            // 2. The envelope carries it as stored.
            const bundle = await sealedBundle();
            assert(!!bundle && show(bundle.addressSpares) === show([k.spelled]),
                `${k.kind}: the take-over envelope carries ${k.spelled} as stored (${show(bundle?.addressSpares)})`);
            if (!held || !bundle) continue;
            // 3. A standby at that address takes over: the promoted list names it as an address, spelled the same.
            asStandbyAt(k.spelled);
            takeOver(bundle);
            const promoted = await signedList();
            assert(!!promoted && promoted.list.epoch === held.list.epoch + 1 && promoted.list.addresses.includes(k.spelled) && !promoted.list.spares.includes(k.spelled),
                `${k.kind}: the promoted list, at take-over count ${held.list.epoch + 1}, names ${k.spelled} as an address and not as a spare (${promoted?.list.epoch} ${show(promoted?.list.addresses)} / ${show(promoted?.list.spares)})`);
            assert(own.audienceStanding(own.normalizeAddress(k.spelled)!) === 'own',
                `${k.kind}: a request signed for its host is this community's (${own.audienceStanding(own.normalizeAddress(k.spelled)!)})`);
            // 4. The phone: the spare proves at that spelling, the promoted list is newer, and the phone goes there.
            const spare = held.list.spares[0];
            const p = await proveAt(spare);
            const choice = chooseAddressList(promoted, { peerId: PEER, kept: held });
            const taken = p.verdict?.ok === true && choice.action === 'replace' && takeSpare({
                listedAnswers: false, epoch: held.list.epoch, spare,
                answer: { proof: { kind: 'proved', epoch: p.verdict.epoch, seq: p.verdict.seq }, list: choice.signed.list },
            });
            assert(taken, `${k.kind}: the phone holding the old list proves ${spare} with the key and goes there (proof ${p.status} ${show(p.verdict)}, list ${choice.action})`);
            // The owner-confirmed list keeps the port when another address is removed in Settings.
            const removed = await call('POST', '/api/local/admin/app-addresses/remove', { address: 'owner-confirmed.example' }, owner());
            const afterRemove = await signedList();
            assert(removed.status === 200 && !!afterRemove && afterRemove.list.addresses.includes(k.spelled) && !afterRemove.list.addresses.includes('owner-confirmed.example'),
                `${k.kind}: after another address is removed in Settings, the list still names ${k.spelled} (${removed.status} ${show(afterRemove?.list.addresses)})`);
        }

        console.log('\n— a spare naming the standby\'s host at another port than it answers on —');
        asMainServer();
        await call('POST', '/api/local/admin/app-addresses/spares', { action: 'add', address: '198.51.100.9:8443' }, owner());
        const bundle = await sealedBundle();
        asStandbyAt('198.51.100.9:9443');
        if (bundle) takeOver(bundle);
        const promoted = await signedList();
        assert(!!promoted && !promoted.list.addresses.includes('198.51.100.9:8443') && promoted.list.spares.includes('198.51.100.9:8443'),
            `it is not where this server answers, so it stays a spare (${show(promoted?.list.addresses)} / ${show(promoted?.list.spares)})`);
        assert(addressOf('198.51.100.9:8443') === '198.51.100.9:8443' && getLocalConfig().identityEpoch === (bundle?.identityEpoch ?? -1) + 1,
            'the take-over count went on as for every row');

        console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    } catch (e: any) {
        console.error(`❌ ${e?.stack || e}`);
        process.exitCode = 1;
    }
    if (testsPassed !== testsRun) process.exitCode = 1;
    process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
