import crypto from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
    buildBoundRequestHeaders,
    ed25519Signer,
    sealSeedToSso,
    sealVaultDepositBox,
    vaultTicketNonce,
} from '@beanpool/core';
import {
    BEANPOOL_APPLE_BUNDLE_ID,
    BEANPOOL_FACEBOOK_APP_ID,
    BEANPOOL_GOOGLE_CLIENT_IDS,
    type FetchLike,
    type SsoProvider,
} from '@beanpool/signin';
import { LocalDirectoryStore, type BackupStore } from '../api/backup-store.js';
import { createVaultApi, type VaultApi } from '../api/server.js';
import { confirmShare, custodianKey, genesis, presentShare, type CallOptions, type CustodianKey } from '../custodian/lib.js';
import { Keyholder } from '../keyholder/keyholder.js';
import { listenKeyholder, type KeyholderServer } from '../keyholder/server.js';
import type { CustodianShare } from '../shared/ceremony.js';

/**
 * A whole vault for a test: the keyholder on a real Unix socket and the API on a real port, in a temp directory, with
 * a clock the test moves. No provider is contacted: `stub.fetch` answers the pinned JWKS URLs (with a key made here),
 * GitHub's three device-flow endpoints and Expo's push endpoint, records every call, and throws on anything else.
 */

export const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

export interface Clock {
    now(): number;
    advance(ms: number): void;
}

export function makeClock(start = T0): Clock {
    let t = start;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
}

export interface PushCall {
    body: string;
    messages: { to: string; title: string; body: string; data: Record<string, unknown> }[];
}

/** The providers' side, shared by every vault a test starts (a restored vault must see the same providers). */
export class StubProviders {
    readonly rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    readonly kid = 'stub-kid';
    readonly calls: string[] = [];
    readonly pushes: PushCall[] = [];
    /** The GitHub account the next device-flow sign-in finishes as. */
    githubUserId = 583231;
    private deviceCodes = new Map<string, number>();
    private tokens = new Map<string, number>();
    private n = 0;

    static readonly JWKS: Record<string, string> = {
        google: 'https://www.googleapis.com/oauth2/v3/certs',
        apple: 'https://appleid.apple.com/auth/keys',
        facebook: 'https://www.facebook.com/.well-known/oauth/openid/jwks/',
    };

    readonly fetch: FetchLike = async (url, init) => {
        this.calls.push(url);
        const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
            status, headers: { 'Content-Type': 'application/json', 'cache-control': 'public, max-age=3600' },
        });
        if (Object.values(StubProviders.JWKS).includes(url)) {
            const jwk = { ...this.rsa.publicKey.export({ format: 'jwk' }), kid: this.kid, alg: 'RS256', use: 'sig' };
            return json({ keys: [jwk] });
        }
        if (url === 'https://github.com/login/device/code') {
            const code = `device-${++this.n}`;
            this.deviceCodes.set(code, this.githubUserId);
            return json({ device_code: code, user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
        }
        if (url === 'https://github.com/login/oauth/access_token') {
            const body = JSON.parse(String(init?.body ?? '{}')) as { device_code?: string };
            const user = this.deviceCodes.get(String(body.device_code));
            if (user === undefined) return json({ error: 'expired_token' });
            const token = `gho_${crypto.randomBytes(12).toString('hex')}`;
            this.tokens.set(token, user);
            return json({ access_token: token, token_type: 'bearer' });
        }
        if (url === 'https://api.github.com/user') {
            const auth = new Headers(init?.headers).get('Authorization') ?? '';
            const user = this.tokens.get(auth.replace(/^Bearer /, ''));
            return user === undefined ? json({ message: 'Bad credentials' }, 401) : json({ id: user, login: `user${user}`, email: `user${user}@example.com` });
        }
        if (url === 'https://exp.host/--/api/v2/push/send') {
            const body = String(init?.body ?? '');
            this.pushes.push({ body, messages: JSON.parse(body) });
            return json({ data: [] });
        }
        throw new Error(`the test tried to contact ${url}`);
    };

    /** An id_token as the provider would sign it. */
    mint(provider: Exclude<SsoProvider, 'github'>, claims: { sub: string; nonce: string; aud?: string; email?: string; now: number }): string {
        const iss = { google: 'https://accounts.google.com', apple: 'https://appleid.apple.com', facebook: 'https://www.facebook.com' }[provider];
        const aud = claims.aud ?? { google: BEANPOOL_GOOGLE_CLIENT_IDS[0], apple: BEANPOOL_APPLE_BUNDLE_ID, facebook: BEANPOOL_FACEBOOK_APP_ID }[provider];
        const seconds = Math.floor(claims.now / 1000);
        const payload = { iss, aud, sub: claims.sub, nonce: claims.nonce, iat: seconds, exp: seconds + 600, ...(claims.email ? { email: claims.email } : {}) };
        const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
        const input = `${b64({ alg: 'RS256', kid: this.kid, typ: 'JWT' })}.${b64(payload)}`;
        return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), this.rsa.privateKey).toString('base64url')}`;
    }
}

export interface Member {
    seed: Uint8Array;
    key: string;
}

export function newMember(): Member {
    const seed = crypto.randomBytes(32);
    return { seed, key: Buffer.from(ed25519.getPublicKey(seed)).toString('hex') };
}

export interface Reply {
    status: number;
    body: Record<string, any>;
}

export interface VaultUnderTest {
    dir: string;
    stateDir: string;
    dataDir: string;
    storeDir: string;
    socketPath: string;
    baseUrl: string;
    clock: Clock;
    stub: StubProviders;
    api: VaultApi;
    custodians: CustodianKey[];
    keyholder(): Keyholder;
    /** A reboot of the keyholder: everything in its memory is gone; it comes back locked. */
    restartKeyholder(): Promise<void>;
    /** A restart of the API alone (a crash, or a new release): on a new port, so `baseUrl` changes. */
    restartApi(): Promise<void>;
    close(): Promise<void>;
    call(opts?: Partial<CallOptions>): CallOptions;
}

export async function startVault(opts: {
    stub?: StubProviders;
    clock?: Clock;
    custodians?: CustodianKey[];
    storeDir?: string;
    trustProxy?: boolean;
    /** Wraps the backup store (a slow or failing one). */
    store?: (inner: BackupStore) => BackupStore;
} = {}): Promise<VaultUnderTest> {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bv-'));
    const stateDir = path.join(dir, 'keyholder');
    const dataDir = path.join(dir, 'data');
    const storeDir = opts.storeDir ?? path.join(dir, 'store');
    const socketPath = path.join(dir, 'kh.sock');
    const clock = opts.clock ?? makeClock();
    const stub = opts.stub ?? new StubProviders();
    const custodians = opts.custodians ?? [0, 1, 2].map(() => custodianKey(crypto.randomBytes(32)));
    const makeKeyholder = () => new Keyholder({ stateDir, genesisCustodians: custodians.map(c => c.publicKey), clock: clock.now, iterationExponent: 0 });
    let kh = makeKeyholder();
    let server: KeyholderServer = await listenKeyholder(kh, socketPath);
    const inner = new LocalDirectoryStore(storeDir);
    const store = opts.store ? opts.store(inner) : inner;
    const makeApi = async () => {
        const api = createVaultApi({
            dataDir, keyholderSocket: socketPath, hosts: ['127.0.0.1'], store, fetch: stub.fetch, clock: clock.now, trustProxy: opts.trustProxy,
        });
        const port = await api.listen(0, '127.0.0.1');
        return { api, baseUrl: `http://127.0.0.1:${port}` };
    };
    const first = await makeApi();
    const v: VaultUnderTest = {
        dir, stateDir, dataDir, storeDir, socketPath, baseUrl: first.baseUrl, clock, stub, api: first.api, custodians,
        keyholder: () => kh,
        restartKeyholder: async () => {
            await server.close();
            kh.lock();
            kh = makeKeyholder();
            server = await listenKeyholder(kh, socketPath);
        },
        restartApi: async () => {
            await v.api.close();
            const next = await makeApi();
            v.api = next.api;
            v.baseUrl = next.baseUrl;
        },
        close: async () => {
            await v.api.close();
            await server.close();
            kh.lock();
            rmSync(dir, { recursive: true, force: true });
        },
        call: (extra = {}) => ({ now: clock.now, acceptNoHardwareProof: true, ...extra }),
    };
    return v;
}

// ─── Talking to the vault ────────────────────────────────────────────────────────────────────

export async function signed(v: VaultUnderTest, p: string, body: unknown, seed: Uint8Array, extraHeaders: Record<string, string> = {}): Promise<Reply> {
    const url = `${v.baseUrl}${p}`;
    const text = JSON.stringify(body);
    const key = Buffer.from(ed25519.getPublicKey(seed)).toString('hex');
    const headers = await buildBoundRequestHeaders({ method: 'POST', url, body: text, publicKeyHex: key, sign: ed25519Signer(seed), timestamp: v.clock.now() });
    const res = await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', ...extraHeaders }, body: text });
    return { status: res.status, body: await res.json() as Record<string, any> };
}

export async function get(v: VaultUnderTest, p: string): Promise<Reply> {
    const res = await fetch(`${v.baseUrl}${p}`);
    return { status: res.status, body: await res.json() as Record<string, any> };
}

export interface Genesis {
    shares: CustodianShare[];
    ticketKey: string;
    depositKey: string;
}

/**
 * Genesis by custodian 0, confirmed by custodians 0 and 1 (so the vault is open), returning the three sealed shares
 * and the public keys the app would pin.
 */
export async function doGenesis(v: VaultUnderTest): Promise<Genesis> {
    const r = await genesis(v.baseUrl, v.custodians[0], v.call());
    if (r.status !== 200) throw new Error(`genesis failed: ${JSON.stringify(r.body)}`);
    const pk = r.body.publicKeys as { ticket: string[]; deposit: { key: string }[] };
    const shares = r.body.custodianShares as CustodianShare[];
    const confirmed = await confirmWith(v, shares, [0, 1]);
    if (confirmed[1].body.state !== 'open') throw new Error(`genesis not confirmed: ${JSON.stringify(confirmed[1].body)}`);
    return { shares, ticketKey: pk.ticket[0], depositKey: pk.deposit[0].key };
}

/** Custodians (indexes into `custodians`, v.custodians by default) confirm they hold their new share. */
export async function confirmWith(v: VaultUnderTest, shares: CustodianShare[], who: number[], custodians = v.custodians): Promise<Reply[]> {
    const out: Reply[] = [];
    for (const i of who) {
        const share = shares.find(s => s.custodian === custodians[i].publicKey) as CustodianShare;
        out.push(await confirmShare(v.baseUrl, custodians[i], share, v.call()));
    }
    return out;
}

/** Two custodians present their shares (indexes into v.custodians and shares). */
export async function unlockWith(v: VaultUnderTest, shares: CustodianShare[], who: number[]): Promise<Reply[]> {
    const out: Reply[] = [];
    for (const i of who) {
        const share = shares.find(s => s.custodian === v.custodians[i].publicKey) as CustodianShare;
        out.push(await presentShare(v.baseUrl, v.custodians[i], share, v.call()));
    }
    return out;
}

export async function ticketFor(v: VaultUnderTest, seed: Uint8Array, purpose: 'deposit' | 'restore', provider: SsoProvider): Promise<string> {
    const r = await signed(v, '/v1/ticket', { purpose, provider }, seed);
    if (r.status !== 200) throw new Error(`ticket refused: ${JSON.stringify(r.body)}`);
    return r.body.ticket as string;
}

/** A finished GitHub device-flow sign-in for `ticket`, as the phone would drive it. */
export async function githubProof(v: VaultUnderTest, seed: Uint8Array, ticket: string, userId: number): Promise<{ sessionId: string }> {
    v.stub.githubUserId = userId;
    const start = await signed(v, '/v1/github/start', { ticket }, seed);
    if (start.status !== 200) throw new Error(`github start refused: ${JSON.stringify(start.body)}`);
    v.clock.advance(6_000);
    const poll = await signed(v, '/v1/github/poll', { ticket, sessionId: start.body.sessionId }, seed);
    if (poll.body.status !== 'ok') throw new Error(`github poll: ${JSON.stringify(poll.body)}`);
    return { sessionId: start.body.sessionId as string };
}

/** The sign-in part of a deposit or restore body. */
export async function credential(v: VaultUnderTest, seed: Uint8Array, provider: SsoProvider, sub: string, ticket: string, over: { aud?: string; nonce?: string; email?: string } = {}) {
    if (provider === 'github') return { proof: await githubProof(v, seed, ticket, Number(sub)) };
    return { idToken: v.stub.mint(provider, { sub, nonce: over.nonce ?? vaultTicketNonce(ticket), aud: over.aud, email: over.email, now: v.clock.now() }) };
}

export async function depositBody(g: Genesis, member: Member, provider: SsoProvider, sub: string, pushToken?: string) {
    const clientCopy = await sealSeedToSso(member.seed, provider, sub);
    return { clientCopy, box: sealVaultDepositBox({ clientCopy, ...(pushToken ? { pushToken } : {}) }, g.depositKey, member.key, provider) };
}

export async function deposit(v: VaultUnderTest, g: Genesis, member: Member, provider: SsoProvider, sub: string, opts: { pushToken?: string; email?: string } = {}): Promise<Reply> {
    const ticket = await ticketFor(v, member.seed, 'deposit', provider);
    const cred = await credential(v, member.seed, provider, sub, ticket, { email: opts.email });
    const { box } = await depositBody(g, member, provider, sub, opts.pushToken);
    return signed(v, '/v1/copies', { ticket, provider, ...cred, box }, member.seed);
}

/** A restore from a new device: a throwaway key, its ticket, the sign-in. */
export async function startRestore(v: VaultUnderTest, provider: SsoProvider, sub: string): Promise<{ e: Uint8Array; reply: Reply }> {
    const e = crypto.randomBytes(32);
    const ticket = await ticketFor(v, e, 'restore', provider);
    const cred = await credential(v, e, provider, sub, ticket);
    return { e, reply: await signed(v, '/v1/restore', { ticket, provider, ...cred }, e) };
}

// ─── Looking at the disk ─────────────────────────────────────────────────────────────────────

/** Every file under `dir`, recursively (sockets skipped). */
export function filesUnder(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) out.push(...filesUnder(p));
        else if (st.isFile()) out.push(p);
    }
    return out;
}

/** The files under `dir` whose bytes contain any of `needles`, with the needle found. */
export function scan(dir: string, needles: (string | Uint8Array)[]): string[] {
    const hits: string[] = [];
    for (const file of filesUnder(dir)) {
        const bytes = readFileSync(file);
        for (const n of needles) {
            const needle = typeof n === 'string' ? Buffer.from(n, 'utf8') : Buffer.from(n);
            if (needle.length && bytes.includes(needle)) hits.push(`${path.relative(dir, file)}: ${typeof n === 'string' ? n.slice(0, 40) : Buffer.from(n).toString('hex').slice(0, 40)}`);
        }
    }
    return hits;
}
