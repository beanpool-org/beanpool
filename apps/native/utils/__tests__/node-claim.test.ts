import { beforeEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, scryptSync } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { CLAIM_SCRYPT, claimText, signedRequestBytes } from '@beanpool/core';

vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});
// The phone's storage, as maps, for the claim that makes the account (utils/claim-key.ts, below): the key item in the
// secure store, the wizard's record and the anchor in AsyncStorage.
const phone = vi.hoisted(() => ({ async: new Map<string, string>(), secure: new Map<string, string>() }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => phone.async.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { phone.async.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { phone.async.delete(k); }),
        getAllKeys: vi.fn(async () => [...phone.async.keys()]),
        multiRemove: vi.fn(async (ks: string[]) => { for (const k of ks) phone.async.delete(k); }),
    },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async (k: string) => phone.secure.get(k) ?? null),
    setItemAsync: vi.fn(async (k: string, v: string) => { phone.secure.set(k, v); }),
    deleteItemAsync: vi.fn(async (k: string) => { phone.secure.delete(k); }),
}));

import {
    APP_CLAIM_SCRYPT, CLAIM_NAME_MAX, buildClaimBody, cleanClaimName, claimCodeDigits, claimCodeFromDigits, claimCommunity, claimNodeOrigin, claimOutcomeMessage,
    claimRouteFor, claimScryptIsTheApps, confirmLostClaim, isClaimCode, parseClaimLink, readClaimStatus, readNodeHasAddress, ownerCheckViaRole, claimSuccessActions, claimCodeFromScan, claimRouteFromSystemPath, claimProbeOrigin, claimLinkFromScan, CLAIM_CODE_PLACEHOLDER, type OwnerCheck,
} from '../node-claim';

// core's fixed vectors (packages/beanpool-core/src/__tests__/claim-proof.test.ts), made with Node's crypto.
const CODE = 'claim-a1b2-c3d4-e5f6-7890';
const SALT = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const KEY = '418c61634b782ba89a7feca46fbe1fdc8d68ab2c99995bdc778fe549d9f419e4';
const HOST = 'claim-test.example';
const CODE_ID = '0a1b2c3d';

// A real key: the seed, its public half, and the PWA's PKCS8 wrapping of the same seed.
const SEED = '11'.repeat(32);
const PUB = Buffer.from(ed25519.getPublicKey(Buffer.from(SEED, 'hex'))).toString('hex');
const PKCS8 = '302e020100300506032b657004220420' + SEED;
const ORIGIN = `https://${HOST}`;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function expectedProof(host: string, pub: string): string {
    return createHmac('sha256', Buffer.from(KEY, 'hex')).update(`beanpool-claim-proof/1\n${host}\n${CODE_ID}\n${pub}`).digest('hex');
}

describe('the scrypt is the app\'s own, and the server\'s', () => {
    it('hard-codes N=16384, r=8, p=1, 32 bytes, and core\'s helper uses exactly that', () => {
        expect(APP_CLAIM_SCRYPT).toEqual({ N: 16384, r: 8, p: 1, dkLen: 32 });
        expect(CLAIM_SCRYPT).toEqual(APP_CLAIM_SCRYPT);
        expect(claimScryptIsTheApps()).toBe(true);
        expect(claimScryptIsTheApps({ N: 1024, r: 8, p: 1, dkLen: 32 })).toBe(false);
    });

    it('the server derives K with core\'s CLAIM_SCRYPT, not parameters of its own', () => {
        const src = readFileSync(fileURLToPath(new URL('../../../server/src/claim-code.ts', import.meta.url).href), 'utf8');
        expect(src).toMatch(/import \{[^}]*\bCLAIM_SCRYPT\b[^}]*\} from '@beanpool\/core'/);
        expect(src).toMatch(/const \{ N, r, p, dkLen \} = CLAIM_SCRYPT;/);
        // and that is the key the server stores, byte for byte
        expect(scryptSync(createHash('sha256').update(CODE).digest('hex'), SALT, 32, { N: 16384, r: 8, p: 1 }).toString('hex')).toBe(KEY);
    });

    it('takes no scrypt parameters from the node\'s answer', async () => {
        const fetchImpl = vi.fn(async () => json(200, { unclaimed: true, codeId: CODE_ID, salt: SALT, communityName: 'Test', scrypt: { N: 2, r: 1, p: 1 } }));
        const s = await readClaimStatus(ORIGIN, fetchImpl as any);
        expect(s).toEqual({ kind: 'unclaimed', codeId: CODE_ID, salt: SALT, communityName: 'Test' });
    });
});

describe('the proof', () => {
    it('equals core\'s fixed vector and the server\'s HMAC over the stored key, signed by this phone\'s key', async () => {
        const body = await buildClaimBody({ origin: ORIGIN, identity: { publicKey: PUB, privateKey: SEED }, code: CODE, codeId: CODE_ID, salt: SALT, callsign: ' Ada ' });
        expect(Object.keys(body).sort()).toEqual(['callsign', 'codeId', 'proof', 'publicKey', 'signature', 'signedFor']);
        expect(body.signedFor).toBe(HOST);
        expect(body.callsign).toBe('Ada');
        expect(body.proof).toBe(expectedProof(HOST, PUB));
        const msg = signedRequestBytes(claimText(HOST, CODE_ID, PUB, body.proof));
        expect(ed25519.verify(Buffer.from(body.signature, 'base64'), msg, Buffer.from(PUB, 'hex'), { zip215: false })).toBe(true);
    });

    it('signs the same with a PWA-imported (PKCS8) key as with the raw seed', async () => {
        const raw = await buildClaimBody({ origin: ORIGIN, identity: { publicKey: PUB, privateKey: SEED }, code: CODE, codeId: CODE_ID, salt: SALT });
        const wrapped = await buildClaimBody({ origin: ORIGIN, identity: { publicKey: PUB, privateKey: PKCS8 }, code: CODE, codeId: CODE_ID, salt: SALT });
        expect(wrapped).toEqual(raw);
    });

    it('binds to the host the phone connects to (a port and the scheme are not part of it)', async () => {
        const body = await buildClaimBody({ origin: `http://192.168.1.20:8443`, identity: { publicKey: PUB, privateKey: SEED }, code: CODE, codeId: CODE_ID, salt: SALT });
        expect(body.signedFor).toBe('192.168.1.20');
        expect(body.proof).toBe(expectedProof('192.168.1.20', PUB));
    });

    it('refuses a code that is not whole, and an address that is not plain', async () => {
        await expect(buildClaimBody({ origin: ORIGIN, identity: { publicKey: PUB, privateKey: SEED }, code: 'claim-a1b2', codeId: CODE_ID, salt: SALT })).rejects.toThrow();
        await expect(buildClaimBody({ origin: 'https://a.test\\@evil.test', identity: { publicKey: PUB, privateKey: SEED }, code: CODE, codeId: CODE_ID, salt: SALT })).rejects.toThrow();
    });
});

describe('the code field', () => {
    it('groups hex digits and drops a pasted prefix', () => {
        expect(claimCodeDigits('A1B2c3d4E5F67890')).toBe('a1b2-c3d4-e5f6-7890');
        expect(claimCodeDigits('  claim-a1b2-c3d4-e5f6-7890\n')).toBe('a1b2-c3d4-e5f6-7890');
        expect(claimCodeDigits('a1b2-c3')).toBe('a1b2-c3');
        expect(claimCodeDigits('a1b2c3d4e5f678901234')).toBe('a1b2-c3d4-e5f6-7890');
        expect(claimCodeFromDigits('a1b2-c3d4-e5f6-7890')).toBe(CODE);
        expect(claimCodeFromDigits('a1b2-c3d4-e5f6-789')).toBeNull();
        expect(isClaimCode(' CLAIM-A1B2-C3D4-E5F6-7890 ')).toBe(true);
        expect(isClaimCode('claim-a1b2-c3d4-e5f6-789g')).toBe(false);
    });
});

describe('the claim link', () => {
    it('reads node, id and code from beanpool://claim', () => {
        expect(parseClaimLink(`beanpool://claim?node=${encodeURIComponent('https://mullum-new.example.org')}&id=${CODE_ID}&code=${CODE}`))
            .toEqual({ node: 'https://mullum-new.example.org', nodeRefused: false, codeId: CODE_ID, code: CODE });
        expect(parseClaimLink('beanpool://claim?node=http://192.168.1.20:8443&id=0A1B2C3D'))
            .toEqual({ node: 'http://192.168.1.20:8443', nodeRefused: false, codeId: CODE_ID, code: null });
        expect(parseClaimLink('beanpool://claim')).toEqual({ node: null, nodeRefused: false, codeId: null, code: null });
        expect(parseClaimLink('beanpool:///claim/?node=https%3A%2F%2Fa.example')?.node).toBe('https://a.example');
    });

    it('is not any other link', () => {
        expect(parseClaimLink('beanpool://claimx?node=https://a.example')).toBeNull();
        expect(parseClaimLink('https://a.example/claim?node=https://a.example')).toBeNull();
        expect(parseClaimLink('beanpool://invite?code=x')).toBeNull();
        expect(parseClaimLink(42)).toBeNull();
    });

    it('refuses hostile node= values, and drops bad id and code', () => {
        for (const bad of [
            'javascript:alert(1)', 'JavaScript://a.example', 'file:///etc/passwd', 'beanpool://claim',
            'https://a.example evil.test', ' https://a .example', 'https://a.example\tb',
            'https://user@evil.test', 'https://a.test\\@evil.test', 'https://a.test%40evil.test', 'https://a.test?x@evil.test/',
            'http://203.0.113.5:8443', 'http://public.example.org', 'ftp://a.example',
            'https://[deadbeef.de]/', 'https://[::1', '',
        ]) {
            const link = parseClaimLink(`beanpool://claim?node=${encodeURIComponent(bad)}&id=zzzz&code=claim-1`);
            expect({ bad, node: link?.node ?? null }).toEqual({ bad, node: null });
            expect(link?.nodeRefused).toBe(bad !== '');
            expect(link?.codeId).toBeNull();
            expect(link?.code).toBeNull();
        }
    });

    it('normalises what it accepts to one origin', () => {
        expect(claimNodeOrigin('HTTPS://A.Example:443/settings?x=1')).toBe('https://a.example');
        expect(claimNodeOrigin('http://[fd00::20]:8443/')).toBe('http://[fd00::20]:8443');
        expect(claimNodeOrigin('192.168.1.20:8443')).toBe('http://192.168.1.20:8443');
        expect(claimNodeOrigin('a.example:8443')).toBe('https://a.example:8443');
        expect(claimNodeOrigin('mycommunity')).toBe('https://mycommunity.beanpool.org');
        expect(claimNodeOrigin('localhost:8443')).toBe('http://localhost:8443');
    });

    it('opens the claim screen with only the checked fields', () => {
        expect(claimRouteFor(parseClaimLink(`beanpool://claim?node=https://a.example&id=${CODE_ID}&code=${CODE}`)!))
            .toBe(`/claim-community?node=https%3A%2F%2Fa.example&id=${CODE_ID}&code=${CODE}`);
        expect(claimRouteFor(parseClaimLink('beanpool://claim?node=javascript:alert(1)')!)).toBe('/claim-community?refused=1');
    });
});

describe('the entry: only a node that answers unclaimed', () => {
    it('unclaimed with a code → the claim is offered', async () => {
        const s = await readClaimStatus(ORIGIN, (async () => json(200, { unclaimed: true, codeId: CODE_ID, salt: SALT, communityName: 'Bean Town' })) as any);
        expect(s.kind).toBe('unclaimed');
    });

    it('claimed, an old node without the route, junk, or no answer → not offered', async () => {
        expect((await readClaimStatus(ORIGIN, (async () => json(200, { unclaimed: false })) as any)).kind).toBe('claimed');
        expect((await readClaimStatus(ORIGIN, (async () => json(404, { error: 'not found' })) as any)).kind).toBe('unreachable');
        expect((await readClaimStatus(ORIGIN, (async () => json(200, { hello: 1 })) as any)).kind).toBe('unreachable');
        expect((await readClaimStatus(ORIGIN, (async () => { throw new Error('offline'); }) as any)).kind).toBe('unreachable');
        expect((await readClaimStatus(ORIGIN, (async () => json(200, { unclaimed: true, codeId: null, salt: null })) as any)).kind).toBe('no-code');
        expect((await readClaimStatus(ORIGIN, (async () => json(200, { unclaimed: true, codeId: '../x', salt: SALT })) as any)).kind).toBe('no-code');
    });
});

describe('the server-written community name, before it is shown', () => {
    const nameFrom = async (communityName: unknown) => {
        const s = await readClaimStatus(ORIGIN, (async () => json(200, { unclaimed: true, codeId: CODE_ID, salt: SALT, communityName })) as any);
        if (s.kind !== 'unclaimed') throw new Error(`expected unclaimed, got ${s.kind}`);
        return s.communityName;
    };

    it('a newline, and a URL-looking second line, end up on one line', async () => {
        expect(await nameFrom('Bean Town\nhttps://bean-town.example')).toBe('Bean Town https://bean-town.example');
        expect(await nameFrom('Bean Town\r\n\r\n  https://x.example\u2028second\u2029third\u0085fourth\tfifth')).toBe('Bean Town https://x.example second third fourth fifth');
    });

    it('every bidi control is gone (U+200E/F, U+202A-202E, U+2066-2069, U+061C)', async () => {
        expect(await nameFrom('Bean \u202Eelpmaxe.live\u202C Town')).toBe('Bean elpmaxe.live Town');
        const bidi = '\u200E\u200F\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069\u061C';
        expect(await nameFrom(`A${bidi}B`)).toBe('AB');
        for (const ch of bidi) expect(await nameFrom(`x${ch}y`)).toBe('xy');
    });

    it('zero-width and other invisible characters are gone; control characters too', async () => {
        expect(await nameFrom('Be\u200Ban To\u200Ewn\u2060\uFEFF\u00AD')).toBe('Bean Town');
    });

    it('invisible characters beyond the basic plane go too: tag characters and musical format controls', async () => {
        for (const ch of ['\u{E0000}', '\u{E0020}', '\u{E0041}', '\u{E007F}', '\u{1D173}', '\u{1D17A}']) expect(await nameFrom(`A${ch}B`)).toBe('AB');
    });

    it('the zero-width non-joiner and joiner stay: Persian names and emoji sequences need them, and neither moves text', async () => {
        expect(await nameFrom('\u0645\u06CC\u200C\u0631\u0648\u0645')).toBe('\u0645\u06CC\u200C\u0631\u0648\u0645');
        expect(await nameFrom('Family \u{1F468}\u200D\u{1F469}\u200D\u{1F467} garden')).toBe('Family \u{1F468}\u200D\u{1F469}\u200D\u{1F467} garden');
        expect(await nameFrom('Bean\u0000\u0007\u001B[31m Town\u007F\u009B')).toBe('Bean[31m Town');
    });

    it('runs of whitespace become one space; trimmed; at most 80 characters, never half an emoji', async () => {
        expect(await nameFrom('  Bean \u00A0\u3000  Town  ')).toBe('Bean Town');
        expect(await nameFrom('x'.repeat(200))).toBe('x'.repeat(80));
        const cut = await nameFrom(`${'a'.repeat(79)}🫘🫘`);
        expect(Array.from(cut)).toHaveLength(80);
        expect(cut.endsWith('🫘')).toBe(true);
        expect(await nameFrom(`${'a'.repeat(79)} b`)).toBe('a'.repeat(79));
    });

    it('nothing left after cleaning, or no name at all → the address instead', async () => {
        expect(await nameFrom('\u202E\u200B \n\t\u2028\uFEFF')).toBe(HOST);
        expect(await nameFrom('   ')).toBe(HOST);
        expect(await nameFrom(undefined)).toBe(HOST);
        expect(await nameFrom(42)).toBe(HOST);
        const noCode = await readClaimStatus(ORIGIN, (async () => json(200, { unclaimed: true, communityName: '\u2066\u2069' })) as any);
        expect(noCode).toEqual({ kind: 'no-code', communityName: HOST });
    });

    it('cleanClaimName on its own', () => {
        expect(cleanClaimName('Bean Town')).toBe('Bean Town');
        expect(cleanClaimName('\u200B')).toBeNull();
        expect(cleanClaimName(null)).toBeNull();
        expect(CLAIM_NAME_MAX).toBe(80);
    });
});

describe('the claim', () => {
    const identity = { publicKey: PUB, privateKey: SEED };
    const owner: OwnerCheck = async () => 'owner';
    const notOwner: OwnerCheck = async () => 'not-owner';
    const noAnswer: OwnerCheck = async () => null;

    function server(answers: Array<(init: RequestInit | undefined, url: string) => Response | Promise<Response>>) {
        const calls: Array<{ url: string; init?: RequestInit }> = [];
        const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
            calls.push({ url, init });
            const next = answers.shift();
            if (!next) throw new Error('unexpected request');
            return next(init, url);
        });
        return { fetchImpl: fetchImpl as any, calls };
    }

    it('never sends the code (or K) in any request body or URL', async () => {
        const { fetchImpl, calls } = server([
            () => { throw new Error('connection reset'); },
            () => json(200, { unclaimed: false }),
        ]);
        await claimCommunity({ origin: ORIGIN, identity, code: CODE, codeId: CODE_ID, salt: SALT, callsign: 'Ada', isOwner: owner, fetchImpl });
        expect(calls.length).toBe(2);
        const digits = CODE.replace(/^claim-/, '');
        for (const c of calls) {
            const sent = `${c.url} ${JSON.stringify(c.init?.headers ?? {})} ${String(c.init?.body ?? '')}`.toLowerCase();
            expect(sent).not.toContain(CODE);
            expect(sent).not.toContain(digits);
            expect(sent).not.toContain(digits.replace(/-/g, ''));
            expect(sent).not.toContain(KEY);
            expect(sent).not.toContain(createHash('sha256').update(CODE).digest('hex'));
        }
        expect(calls[0].url).toBe(`${ORIGIN}/api/local/claim`);
        expect(calls[0].init?.method).toBe('POST');
    });

    it('a right claim → owner', async () => {
        const { fetchImpl } = server([() => json(200, { ok: true, role: 'owner', callsign: 'Ada', again: false })]);
        expect(await claimCommunity({ origin: ORIGIN, identity, code: CODE, codeId: CODE_ID, salt: SALT, isOwner: owner, fetchImpl }))
            .toEqual({ kind: 'owner', callsign: 'Ada' });
    });

    it('a lost answer, then the node says it has an owner and it is this key → owner', async () => {
        const isOwner = vi.fn(owner);
        const { fetchImpl } = server([() => { throw new Error('timeout'); }, () => json(200, { unclaimed: false })]);
        expect(await claimCommunity({ origin: ORIGIN, identity, code: CODE, codeId: CODE_ID, salt: SALT, isOwner, fetchImpl }))
            .toEqual({ kind: 'owner', callsign: null });
        expect(isOwner).toHaveBeenCalledWith(ORIGIN, identity);
    });

    it('a lost answer, and someone else owns it → already claimed; still unclaimed → try again', async () => {
        let s = server([() => json(502, {}), () => json(200, { unclaimed: false })]);
        expect((await claimCommunity({ origin: ORIGIN, identity, code: CODE, codeId: CODE_ID, salt: SALT, isOwner: notOwner, fetchImpl: s.fetchImpl })).kind).toBe('already-claimed');
        s = server([() => { throw new Error('x'); }, () => json(200, { unclaimed: true, codeId: CODE_ID, salt: SALT })]);
        expect((await claimCommunity({ origin: ORIGIN, identity, code: CODE, codeId: CODE_ID, salt: SALT, isOwner: owner, fetchImpl: s.fetchImpl })).kind).toBe('error');
    });

    it('a 429 on the check is "check again", never "failed"', async () => {
        let s = server([() => { throw new Error('x'); }, () => json(429, {}, { 'Retry-After': '60' })]);
        const out = await claimCommunity({ origin: ORIGIN, identity, code: CODE, codeId: CODE_ID, salt: SALT, isOwner: owner, fetchImpl: s.fetchImpl });
        expect(out).toEqual({ kind: 'check-again' });
        expect(claimOutcomeMessage(out, 'Bean Town')).toMatch(/may have worked/);
        expect(claimOutcomeMessage(out, 'Bean Town')).not.toMatch(/fail/i);
        // claimed, but the role lookup got no answer
        s = server([() => { throw new Error('x'); }, () => json(200, { unclaimed: false })]);
        expect((await claimCommunity({ origin: ORIGIN, identity, code: CODE, codeId: CODE_ID, salt: SALT, isOwner: noAnswer, fetchImpl: s.fetchImpl })).kind).toBe('check-again');
    });

    it('a 429 on the claim: owner if the node already took it, else the wait', async () => {
        let s = server([() => json(429, { code: 'claim_braked' }, { 'Retry-After': '10' }), () => json(200, { unclaimed: false })]);
        expect((await claimCommunity({ origin: ORIGIN, identity, code: CODE, codeId: CODE_ID, salt: SALT, isOwner: owner, fetchImpl: s.fetchImpl })).kind).toBe('owner');
        s = server([() => json(429, { code: 'claim_braked' }, { 'Retry-After': '10' }), () => json(200, { unclaimed: true, codeId: CODE_ID, salt: SALT })]);
        const out = await claimCommunity({ origin: ORIGIN, identity, code: CODE, codeId: CODE_ID, salt: SALT, isOwner: owner, fetchImpl: s.fetchImpl });
        expect(out).toEqual({ kind: 'braked', retryAfter: 10 });
        expect(claimOutcomeMessage(out, 'X')).toMatch(/10 seconds/);
    });

    it('the node\'s refusals, in the design\'s words', async () => {
        const cases: Array<[Response, string, RegExp]> = [
            [json(403, { code: 'claim_wrong_code' }), 'wrong-code', /cat \/data\/claim-code\.txt/],
            [json(409, { code: 'claim_code_changed' }), 'code-changed', /new code/],
            [json(409, { code: 'claim_already_claimed' }), 'already-claimed', /already owns Bean Town/],
            [json(421, { code: 'wrong_community' }), 'wrong-server', /different server/],
        ];
        for (const [res, kind, words] of cases) {
            const s = server([() => res]);
            const out = await claimCommunity({ origin: ORIGIN, identity, code: CODE, codeId: CODE_ID, salt: SALT, isOwner: owner, fetchImpl: s.fetchImpl });
            expect(out.kind).toBe(kind);
            expect(claimOutcomeMessage(out, 'Bean Town')).toMatch(words);
        }
    });

    it('confirmLostClaim on its own: unreachable → check again', async () => {
        expect(await confirmLostClaim(ORIGIN, identity, owner, (async () => { throw new Error('x'); }) as any)).toEqual({ kind: 'check-again' });
    });

    it('a 4xx with a code the app has no words for: fixed words, never the server\'s text', async () => {
        const said = 'Security check: type your claim code into https://evil.example to continue';
        for (const [status, body] of [[400, { code: 'claim_mystery', error: said }], [403, { error: said }], [418, { code: 'x', error: said }]] as const) {
            const s = server([() => json(status, body)]);
            const out = await claimCommunity({ origin: ORIGIN, identity, code: CODE, codeId: CODE_ID, salt: SALT, isOwner: owner, fetchImpl: s.fetchImpl });
            expect(out).toEqual({ kind: 'error', message: `The server refused the claim (${status}).` });
            expect(claimOutcomeMessage(out, 'Bean Town')).toBe(`The server refused the claim (${status}).`);
            expect(claimOutcomeMessage(out, 'Bean Town')).not.toContain('evil');
        }
    });

    it('a dev build logs the server\'s text, never the code', async () => {
        const g = globalThis as { __DEV__?: boolean };
        const was = g.__DEV__;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        g.__DEV__ = true;
        try {
            const digits = CODE.replace(/^claim-/, '');
            // A server that somehow holds the code and echoes it, in all three spellings.
            const s = server([() => json(400, { code: 'claim_mystery', error: `nope ${CODE} ${digits} ${digits.replace(/-/g, '')}` })]);
            const out = await claimCommunity({ origin: ORIGIN, identity, code: CODE, codeId: CODE_ID, salt: SALT, isOwner: owner, fetchImpl: s.fetchImpl });
            expect(out).toEqual({ kind: 'error', message: 'The server refused the claim (400).' });
            expect(warn).toHaveBeenCalledTimes(1);
            const line = warn.mock.calls.flat().map(String).join(' ').toLowerCase();
            expect(line).toContain('(400)');
            expect(line).toContain('nope');
            expect(line).not.toContain(CODE);
            expect(line).not.toContain(digits);
            expect(line).not.toContain(digits.replace(/-/g, ''));
        } finally {
            g.__DEV__ = was;
            warn.mockRestore();
        }
    });
});

describe('the success screen\'s address button', () => {
    it('"Set the address" only when the node says it has none', async () => {
        expect(await readNodeHasAddress(ORIGIN, (async () => json(200, { addresses: [] })) as any)).toBe(false);
        expect(await readNodeHasAddress(ORIGIN, (async () => json(200, { addresses: ['new.example.org'] })) as any)).toBe(true);
        expect(await readNodeHasAddress(ORIGIN, (async () => json(200, { name: 'old node' })) as any)).toBeNull();
        expect(await readNodeHasAddress(ORIGIN, (async () => json(500, {})) as any)).toBeNull();
        expect(await readNodeHasAddress(ORIGIN, (async () => { throw new Error('x'); }) as any)).toBeNull();
    });
});

describe('the owner check after a lost answer', () => {
    const identity = { publicKey: PUB, privateKey: SEED };
    function stubFetch(meStatus: number, meBody: unknown) {
        return vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string) => {
            if (String(url).endsWith('/api/community/info')) return json(200, { requestSigning: 2 });
            return json(meStatus, meBody);
        }) as any);
    }

    it('owner → owner; another role or none → not owner; 429 or 5xx → no answer', async () => {
        const cases: Array<[number, unknown, string | null]> = [
            [200, { role: 'owner' }, 'owner'], [200, { role: 'admin' }, 'not-owner'], [200, { role: null }, 'not-owner'],
            // The node's refusal of a key that is no member there, the route's and the read gate's (apps/server
            // routes/node-admin.ts, https-server.ts): not a member, so not the owner.
            [403, { error: 'Not an active member of this community', code: 'not_a_member' }, 'not-owner'],
            [403, { error: 'Read access requires a member identity', code: 'not_a_member' }, 'not-owner'],
            // A 403 that says nothing of who is a member, and a 2xx that names no role: no answer (#2433 review).
            [403, {}, null], [200, {}, null],
            [429, {}, null], [503, {}, null],
        ];
        for (const [status, body, want] of cases) {
            const spy = stubFetch(status, body);
            expect(await ownerCheckViaRole(ORIGIN, identity)).toBe(want);
            const me = spy.mock.calls.find(c => String(c[0]).endsWith('/api/node-admin/me'));
            expect(me).toBeTruthy();
            spy.mockRestore();
        }
    });
});

describe('the success buttons and the scan', () => {
    it('Set the address only for this phone\'s community with no address; Make it mine for another', () => {
        expect(claimSuccessActions({ isAnchor: true, hasAddress: false })).toEqual(['set-address']);
        expect(claimSuccessActions({ isAnchor: true, hasAddress: true })).toEqual(['open-settings']);
        expect(claimSuccessActions({ isAnchor: true, hasAddress: null })).toEqual(['open-settings']);
        expect(claimSuccessActions({ isAnchor: false, hasAddress: false })).toEqual(['make-mine', 'not-now']);
    });

    it('a scan fills the code from this node\'s link or a bare code, never from another node\'s link', () => {
        expect(claimCodeFromScan(`beanpool://claim?node=${ORIGIN}&code=${CODE}`, ORIGIN)).toBe(CODE);
        expect(claimCodeFromScan(`beanpool://claim?code=${CODE}`, ORIGIN)).toBe(CODE);
        expect(claimCodeFromScan(`beanpool://claim?node=https://other.example&code=${CODE}`, ORIGIN)).toBeNull();
        expect(claimCodeFromScan(` ${CODE.toUpperCase()} `, ORIGIN)).toBe(CODE);
        expect(claimCodeFromScan('https://evil.example', ORIGIN)).toBeNull();
    });

    it('a scan before the server is known reads its address and code, the code alone, or a refused address; nothing else', () => {
        expect(claimLinkFromScan(`beanpool://claim?node=${encodeURIComponent(ORIGIN)}&id=${CODE_ID}&code=${CODE}`))
            .toEqual({ node: ORIGIN, nodeRefused: false, codeId: CODE_ID, code: CODE });
        expect(claimLinkFromScan(`beanpool://claim?node=${ORIGIN}&id=${CODE_ID}`)).toEqual({ node: ORIGIN, nodeRefused: false, codeId: CODE_ID, code: null });
        expect(claimLinkFromScan(`beanpool://claim?id=${CODE_ID}&code=${CODE}`)).toEqual({ node: null, nodeRefused: false, codeId: CODE_ID, code: CODE });
        expect(claimLinkFromScan(`beanpool://claim?node=http://203.0.113.7:8080&code=${CODE}`)).toEqual({ node: null, nodeRefused: true, codeId: null, code: CODE });
        expect(claimLinkFromScan(` ${CODE.toUpperCase()} `)).toEqual({ node: null, nodeRefused: false, codeId: null, code: CODE });
        for (const raw of ['beanpool://claim', `beanpool://claim?id=${CODE_ID}`, 'https://evil.example', `https://${HOST}/claim?code=${CODE}`, CLAIM_CODE_PLACEHOLDER, '', null]) {
            expect(claimLinkFromScan(raw), String(raw)).toBeNull();
        }
    });

    it('the empty code field\'s example is a pattern no field or scan reads as a code', () => {
        expect(CLAIM_CODE_PLACEHOLDER).toBe('xxxx-xxxx-xxxx-xxxx');
        expect(claimCodeDigits(CLAIM_CODE_PLACEHOLDER)).toBe('');
        expect(isClaimCode(`claim-${CLAIM_CODE_PLACEHOLDER}`)).toBe(false);
        expect(claimCodeFromScan(CLAIM_CODE_PLACEHOLDER, ORIGIN)).toBeNull();
    });
});

describe('the system hands the app a claim link', () => {
    it('beanpool://claim, claim? and /claim? open the claim screen; nothing else does', () => {
        expect(claimRouteFromSystemPath(`beanpool://claim?node=https%3A%2F%2Fa.example&id=${CODE_ID}`)).toBe(`/claim-community?node=https%3A%2F%2Fa.example&id=${CODE_ID}`);
        expect(claimRouteFromSystemPath('/claim?node=https://a.example')).toBe('/claim-community?node=https%3A%2F%2Fa.example');
        expect(claimRouteFromSystemPath('claim')).toBe('/claim-community');
        expect(claimRouteFromSystemPath('/claims')).toBeNull();
        expect(claimRouteFromSystemPath('/post/claim')).toBeNull();
        expect(claimRouteFromSystemPath('https://a.example/claim?node=x')).toBeNull();
        expect(claimRouteFromSystemPath('beanpool://claim?node=javascript%3Aalert(1)')).toBe('/claim-community?refused=1');
    });
});

describe('Find a community: a typed address is asked, a name is not', () => {
    it('asks only for an address, never for a bare word or a hostile one', () => {
        expect(claimProbeOrigin('beans.example.org')).toBe('https://beans.example.org');
        expect(claimProbeOrigin('https://beans.example.org/')).toBe('https://beans.example.org');
        expect(claimProbeOrigin('192.168.1.20:8443')).toBe('http://192.168.1.20:8443');
        expect(claimProbeOrigin('mullum')).toBeNull();
        expect(claimProbeOrigin('bean town')).toBeNull();
        expect(claimProbeOrigin('javascript:alert(1)')).toBeNull();
        expect(claimProbeOrigin('user@evil.example')).toBeNull();
    });
});

describe('the claim screen at 320dp and 1.3× font: the whole code at once', () => {
    const src = readFileSync(fileURLToPath(new URL('../../app/claim-community.tsx', import.meta.url).href), 'utf8');
    const style = (name: string) => {
        const m = new RegExp(`\\n\\s+${name}: \\{([^}]*)\\}`).exec(src);
        if (!m) throw new Error(`no style ${name}`);
        return m[1];
    };

    it('claim- sits on its own line above the field, in one box; the field is monospace and fills the box', () => {
        expect(src).not.toMatch(/codeRow/);
        expect(style('codeBox')).not.toMatch(/flexDirection/);
        expect(src).toMatch(/<View style=\{styles\.codeBox\}>\s*<Text style=\{styles\.codePrefix\}>claim-<\/Text>\s*<TextInput\s+style=\{styles\.codeInput\}/);
        expect(style('codeInput')).toMatch(/fontFamily: 'monospace'/);
        expect(style('codeInput')).toMatch(/fontSize: 16/);
        expect(style('codeInput')).toMatch(/paddingHorizontal: 0/);
        expect(style('codeBox')).toMatch(/paddingHorizontal: 12/);
        expect(style('codeBox')).toMatch(/borderWidth: 1/);
        expect(style('scroll')).toMatch(/padding: 16/);
    });

    it('the arithmetic: 19 characters at 16×1.3dp fit the 262dp the field has on a 320dp phone', () => {
        const screen = 320, scrollPad = 16, border = 1, boxPad = 12;
        const content = screen - 2 * scrollPad; // 288
        const field = content - 2 * border - 2 * boxPad; // 262
        const perChar = 16 * 1.3 * 0.6; // monospace advance ≈ 0.6em: 12.48dp
        expect(content).toBe(288);
        expect(field).toBe(262);
        expect('a1b2-c3d4-e5f6-7890'.length * perChar).toBeLessThan(field); // 237.1dp
    });

    it('paste, the QR scan and the field\'s keyboard settings are still there', () => {
        expect(src).toMatch(/onPress=\{paste\}/);
        expect(src).toMatch(/onPress=\{openScanner\}/);
        expect(src).toMatch(/maxLength=\{19\}/);
        expect(src).toMatch(/autoCapitalize="none"\s+autoCorrect=\{false\}\s+spellCheck=\{false\}/);
    });

    it('the header title wraps instead of cutting off; the community name is the body title, which wraps', () => {
        // In the member's language, in capitals by the language's rule (words S3k): no textTransform.
        expect(src).toMatch(/<Text style=\{styles\.headerTitle\} numberOfLines=\{2\}[^>]*>\{upperCase\(t\('Claim a community'\)\)\}<\/Text>/);
        expect(src).not.toMatch(/textTransform:/);
        expect(src).toMatch(/<Text style=\{styles\.title\}>\{named \? t\('Claim \{name\}', \{ name: named \}\) : t\('Claim this community'\)\}<\/Text>/);
    });
});

/**
 * The claim makes the account (utils/claim-key.ts; DESIGN-account-without-global-fable.md §2.2): on a phone with no
 * account, a key made in memory signs the claim, goes onto the phone with the wizard's record just before the POST, and
 * comes off again only when no claim by it can ever land. Real modules all the way down to the phone's storage (maps).
 */
describe('the claim that makes the account', () => {
    const KEY_ITEM = 'sovereign-identity';
    const RECORD = 'beanpool_pending_onboarding';
    const owner: OwnerCheck = async () => 'owner';
    const notOwner: OwnerCheck = async () => 'not-owner';
    const noAnswer: OwnerCheck = async () => null;
    const stored = () => (phone.secure.has(KEY_ITEM) ? JSON.parse(phone.secure.get(KEY_ITEM)!) : null);
    const record = () => (phone.async.has(RECORD) ? JSON.parse(phone.async.get(RECORD)!) : null);
    beforeEach(() => { phone.async.clear(); phone.secure.clear(); });

    /** A node at ORIGIN: the POST's answer, then whatever the claim asks after (the status, by GET). */
    function node(post: (body: any) => Response | Promise<Response>, after: Array<() => Response> = []) {
        const seen: Array<{ method: string; body: any; keyOnPhone: string | null; recordAtSend: any }> = [];
        const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
            const method = init?.method ?? 'GET';
            const body = init?.body ? JSON.parse(String(init.body)) : null;
            seen.push({ method, body, keyOnPhone: stored()?.publicKey ?? null, recordAtSend: record() });
            if (String(url) !== `${ORIGIN}/api/local/claim`) throw new Error(`unexpected ${url}`);
            if (method === 'POST') return post(body);
            const next = after.shift();
            if (!next) throw new Error('unexpected GET');
            return next();
        });
        return { fetchImpl: fetchImpl as any, seen };
    }
    const claimed = () => json(200, { unclaimed: false });
    const unclaimed = () => json(200, { unclaimed: true, codeId: CODE_ID, salt: SALT, communityName: 'Bean Town' });

    async function drafted() {
        const { claimKeyForThisPhone } = await import('../claim-key');
        return claimKeyForThisPhone(ORIGIN);
    }
    async function claimWith(key: Awaited<ReturnType<typeof drafted>>, fetchImpl: any, isOwner: OwnerCheck = owner) {
        const { claimWithKey } = await import('../claim-key');
        return claimWithKey({ origin: ORIGIN, key, code: CODE, codeId: CODE_ID, salt: SALT, callsign: 'Ada', isOwner, fetchImpl });
    }

    it('a phone with no account: the key is made in memory, signs the claim, and is on the phone with the record before the POST', async () => {
        const key = await drafted();
        expect(key.createdHere).toBe(true);
        // Nothing is made by opening the screen or drafting: the phone holds nothing yet.
        expect(stored()).toBeNull();
        expect(record()).toBeNull();
        const { fetchImpl, seen } = node(() => json(200, { ok: true, role: 'owner', callsign: 'Ada', again: false }));
        const sending = vi.fn();
        const { claimWithKey } = await import('../claim-key');
        const out = await claimWithKey({ origin: ORIGIN, key, code: CODE, codeId: CODE_ID, salt: SALT, callsign: 'Ada', isOwner: owner, fetchImpl, onSending: sending });
        expect(out).toMatchObject({ outcome: { kind: 'owner', callsign: 'Ada' }, madeHere: true, released: false });
        expect(sending).toHaveBeenCalledTimes(1);
        const [post] = seen;
        expect(post.method).toBe('POST');
        // Signed by the drafted key, and that key was already on the phone, with its record, when the POST went.
        expect(post.body.publicKey).toBe(key.identity.publicKey);
        expect(post.body.callsign).toBe('Ada');
        const msg = signedRequestBytes(claimText(HOST, CODE_ID, post.body.publicKey, post.body.proof));
        expect(ed25519.verify(Buffer.from(post.body.signature, 'base64'), msg, Buffer.from(post.body.publicKey, 'hex'), { zip215: false })).toBe(true);
        expect(post.keyOnPhone).toBe(key.identity.publicKey);
        expect(post.recordAtSend).toMatchObject({
            step: 'claim', flow: 'claim', anchorUrl: ORIGIN, callsign: 'Ada', redeemed: false,
            freshKey: key.identity.publicKey, joinsOut: 1, claimCodeId: CODE_ID,
        });
        // The record never holds the code, or K.
        expect(JSON.stringify(post.recordAtSend)).not.toContain(CODE.slice(6));
        expect(stored()).toMatchObject({ publicKey: key.identity.publicKey, callsign: 'Ada' });
        expect(stored().mnemonic).toHaveLength(12);
    });

    it('in: the phone is the community\'s, and the wizard goes on to Your Photo under the name the node kept, with no copy anywhere', async () => {
        const key = await drafted();
        const { fetchImpl } = node(() => json(200, { ok: true, role: 'owner', callsign: 'Ada 2', again: false }));
        const out = await claimWith(key, fetchImpl);
        const { finishClaim } = await import('../claim-key');
        const kept = await finishClaim(ORIGIN, out.identity, 'Bean Town', out.outcome.kind === 'owner' ? out.outcome.callsign : null);
        expect(kept.callsign).toBe('Ada 2');
        expect(stored()).toMatchObject({ publicKey: key.identity.publicKey, callsign: 'Ada 2' });
        expect(phone.async.get('beanpool_anchor_url')).toBe(ORIGIN);
        expect(record()).toEqual({
            step: 'profileSetup', flow: 'claim', inviteCode: '', anchorUrl: ORIGIN, callsign: 'Ada 2', redeemed: true,
            newKey: key.identity.publicKey, joinDoor: 'words', communityName: 'Bean Town',
        });
    });

    it('a refusal of the POST (a wrong code): no longer counted; the key stays for another try, and leaving takes it off', async () => {
        const key = await drafted();
        const { fetchImpl } = node(() => json(403, { code: 'claim_wrong_code' }));
        const out = await claimWith(key, fetchImpl);
        expect(out).toMatchObject({ outcome: { kind: 'wrong-code' }, released: false });
        expect(stored()?.publicKey).toBe(key.identity.publicKey);
        expect(record()).toMatchObject({ step: 'claim', freshKey: key.identity.publicKey, joinsOut: 0 });
        // Another try signs with the same key, never a second one.
        const { claimKeyForThisPhone, releaseClaimKey } = await import('../claim-key');
        const again = await claimKeyForThisPhone(ORIGIN, key);
        expect(again).toMatchObject({ createdHere: true, identity: { publicKey: key.identity.publicKey } });
        // Back: nothing it signed can have landed, so the phone is as it was before the scan.
        expect(await releaseClaimKey(ORIGIN, again)).toBe(true);
        expect(stored()).toBeNull();
        expect(record()).toBeNull();
    });

    it('another phone won the race: asked who owns it first; not this key → it comes off with the record', async () => {
        const key = await drafted();
        const { fetchImpl } = node(() => json(409, { code: 'claim_already_claimed' }));
        const isOwner = vi.fn(notOwner);
        const out = await claimWith(key, fetchImpl, isOwner);
        expect(out).toMatchObject({ outcome: { kind: 'already-claimed' }, released: true });
        expect(isOwner).toHaveBeenCalledWith(ORIGIN, expect.objectContaining({ publicKey: key.identity.publicKey }));
        expect(stored()).toBeNull();
        expect(record()).toBeNull();
    });

    it('a 409 for this key\'s own claim (the node\'s names changed since it landed): the owner check says owner, and nothing comes off', async () => {
        const key = await drafted();
        let s1 = node(() => json(409, { code: 'claim_already_claimed' }));
        expect((await claimWith(key, s1.fetchImpl, owner)).outcome).toEqual({ kind: 'owner', callsign: null });
        expect(stored()?.publicKey).toBe(key.identity.publicKey);
        // And with no answer from the owner check: check again, the key and the record kept.
        phone.async.clear(); phone.secure.clear();
        const key2 = await drafted();
        s1 = node(() => json(409, { code: 'claim_already_claimed' }));
        const out = await claimWith(key2, s1.fetchImpl, noAnswer);
        expect(out).toMatchObject({ outcome: { kind: 'check-again' }, released: false });
        expect(stored()?.publicKey).toBe(key2.identity.publicKey);
        expect(record()).toMatchObject({ step: 'claim', joinsOut: 1 });
    });

    it('a lost answer: the key and the record stay, counted out, whatever the node says it is now', async () => {
        const { releaseClaimKey } = await import('../claim-key');
        // Still no owner: the claim didn't reach it, but the key stays counted (a join with no answer is never uncounted).
        let key = await drafted();
        let n = node(() => { throw new Error('connection reset'); }, [unclaimed]);
        expect((await claimWith(key, n.fetchImpl)).outcome.kind).toBe('error');
        expect(record()).toMatchObject({ step: 'claim', freshKey: key.identity.publicKey, joinsOut: 1 });
        // Leaving now keeps it: the next launch comes back to the claim with it.
        expect(await releaseClaimKey(ORIGIN, key)).toBe(false);
        expect(stored()?.publicKey).toBe(key.identity.publicKey);

        // Claimed, and the owner check can't say: check again, kept.
        phone.async.clear(); phone.secure.clear();
        key = await drafted();
        n = node(() => json(502, {}), [claimed]);
        expect(await claimWith(key, n.fetchImpl, noAnswer)).toMatchObject({ outcome: { kind: 'check-again' }, released: false });
        expect(stored()?.publicKey).toBe(key.identity.publicKey);
        expect(record()).toMatchObject({ joinsOut: 1 });

        // Check again later: it landed.
        const { checkOwnClaim } = await import('../claim-key');
        const later = node(() => { throw new Error('no POST'); }, [claimed]);
        expect(await checkOwnClaim(ORIGIN, { identity: stored(), createdHere: true }, owner, later.fetchImpl)).toEqual({ outcome: { kind: 'owner', callsign: null }, released: false });
        expect(stored()?.publicKey).toBe(key.identity.publicKey);
    });

    it('a lost answer, and another key owns it: the key comes off', async () => {
        const key = await drafted();
        const n = node(() => { throw new Error('timeout'); }, [claimed]);
        expect(await claimWith(key, n.fetchImpl, notOwner)).toMatchObject({ outcome: { kind: 'already-claimed' }, released: true });
        expect(stored()).toBeNull();
        expect(record()).toBeNull();
    });

    it('a phone with an account claims with it as before: nothing written to the phone, and it never comes off', async () => {
        const { importIdentity, draftIdentity } = await import('../identity');
        const account = await draftIdentity('Marty');
        await importIdentity(account);
        // The global door's mark on it, from a join whose answer was lost: the key is about to go to this community.
        phone.async.set(RECORD, JSON.stringify({ step: 'globalJoin', flow: 'global', inviteCode: '', anchorUrl: 'https://global.beanpool.org', callsign: 'Marty', redeemed: false, freshKey: account.publicKey, joinsOut: 0 }));
        const { claimKeyForThisPhone, releaseClaimKey } = await import('../claim-key');
        const key = await claimKeyForThisPhone(ORIGIN);
        expect(key).toMatchObject({ createdHere: false, identity: { publicKey: account.publicKey } });
        const writes = vi.mocked((await import('expo-secure-store')).setItemAsync);
        writes.mockClear();
        const { fetchImpl, seen } = node(() => json(409, { code: 'claim_already_claimed' }));
        const out = await claimWith(key, fetchImpl, notOwner);
        expect(out).toMatchObject({ outcome: { kind: 'already-claimed' }, madeHere: false, released: false });
        expect(seen[0].body.publicKey).toBe(account.publicKey);
        // The door's mark went before the POST, and nothing else changed.
        expect(seen[0].recordAtSend).not.toHaveProperty('freshKey');
        expect(writes).not.toHaveBeenCalled();
        expect(await releaseClaimKey(ORIGIN, key)).toBe(false);
        expect(stored()?.publicKey).toBe(account.publicKey);
    });

    it('a key the screen made, and a different account stored since: never written over it, and nothing is sent', async () => {
        const key = await drafted();
        const { importIdentity, draftIdentity } = await import('../identity');
        const other = await draftIdentity('Kim');
        await importIdentity(other);
        const { fetchImpl, seen } = node(() => json(200, { ok: true, role: 'owner' }));
        const out = await claimWith(key, fetchImpl);
        expect(out.outcome.kind).toBe('error');
        expect(seen).toHaveLength(0);
        expect(stored()?.publicKey).toBe(other.publicKey);
    });

    it('the owner check: a 401 (the phone\'s clock), a 421 (a host the node\'s names don\'t take yet) or a 404 is no answer, never "someone else"', async () => {
        const identity = { publicKey: PUB, privateKey: SEED };
        for (const status of [401, 421, 404, 426]) {
            const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string) => {
                if (String(url).endsWith('/api/community/info')) return json(200, { requestSigning: 2 });
                return json(status, { error: 'nope' });
            }) as any);
            expect(await ownerCheckViaRole(ORIGIN, identity), String(status)).toBeNull();
            spy.mockRestore();
        }
    });

    /**
     * The 403s the node's signature check gives before any route (apps/server engine/member-signature.ts, https-server.ts)
     * say nothing of who owns the node. A spent nonce comes back to a request delivered twice (the nonce is fixed per
     * request, and a network may send a GET again after a reset connection), so it can be the owner's own key that is
     * refused (#2433 review).
     */
    const OTHER_403S: unknown[] = [
        { error: 'Replay detected: nonce already used' },
        { error: 'Invalid cryptographic signature' },
        { error: 'Signature validation failed' },
        { error: 'This key was replaced by a new one, so this community no longer accepts it. Use the device or the 12 words that hold the new key.', code: 'key_invalidated' },
        { error: 'This key’s account in this community was closed, so the community no longer accepts it.', code: 'account_closed' },
        { error: 'Access denied by Gateway Admin IP allowlist' },
        { error: 'nope' },
        {},
        null,
    ];
    /** The owner check's GET /api/node-admin/me, answered `me` (and the request-signing lookup it may make first). */
    const answerOwnerCheck = (me: () => Response) => vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string) => {
        if (String(url).endsWith('/api/community/info')) return json(200, { requestSigning: 2 });
        if (String(url).endsWith('/api/node-admin/me')) return me();
        throw new Error(`unexpected ${url}`);
    }) as any);

    it('the owner check: a 403 that is not the node\'s refusal of a non-member is no answer, never "someone else"', async () => {
        const identity = { publicKey: PUB, privateKey: SEED };
        for (const body of OTHER_403S) {
            const spy = answerOwnerCheck(() => (body === null ? new Response('<html>Forbidden</html>', { status: 403 }) : json(403, body)));
            expect(await ownerCheckViaRole(ORIGIN, identity), JSON.stringify(body)).toBeNull();
            spy.mockRestore();
        }
    });

    /**
     * #2433 review (4365576799): a held claim's key that another join takes over (door-key.ts adoptJoinKey) leaves the
     * claim's record behind without its mark. The guard leaves the claim screen alone for that record still, so a claim
     * at another address by the same key keeps its screen while its POST is out; welcome drops the record instead of
     * handing it back to the first claim's screen, where the key reads as an account and nothing ever clears it.
     */
    const OTHER = 'https://other.example.org';
    /** The root guard's first checks, as app/_layout.tsx makes them for a phone whose key the app loaded at its start. */
    async function guardAt(root: string): Promise<'/welcome' | null> {
        const { claimInFlight, getPendingOnboarding } = await import('../onboarding-state');
        const { setupRedirect } = await import('../auth-return');
        const p = await getPendingOnboarding();
        const flag = !p ? false : claimInFlight(p) ? 'claim' : 'wizard';
        return setupRedirect([root], { hasIdentity: true, pendingOnboarding: flag !== false, claimOut: flag === 'claim' });
    }
    /** A claim at ORIGIN whose answer was lost: the key and the record kept, counted out. */
    async function heldClaim() {
        const key = await drafted();
        const lost = node(() => { throw new Error('connection reset'); }, [claimed]);
        expect((await claimWith(key, lost.fetchImpl, noAnswer)).outcome.kind).toBe('check-again');
        expect(record()).toMatchObject({ step: 'claim', anchorUrl: ORIGIN, freshKey: key.identity.publicKey, joinsOut: 1 });
        return key;
    }

    it('a held claim\'s key, claiming another address: the guard leaves that claim\'s screen while its POST is out, and welcome then drops the first claim\'s record', async () => {
        const { claimKeyState, claimKeyForThisPhone, claimWithKey } = await import('../claim-key');
        const { clearPendingOnboarding, resumePlan } = await import('../onboarding-state');
        const key = await heldClaim();
        // After a restart the guard holds the phone at the claim screen (and welcome), and welcome hands the claim back.
        expect(await guardAt('claim-community')).toBeNull();
        expect(await guardAt('(tabs)')).toBe('/welcome');
        expect(resumePlan(record(), stored())).toMatchObject({ action: 'resume', mode: 'claim', anchorUrl: ORIGIN });

        // Another address on the claim screen: the record is ORIGIN's, so there the key claims as the phone's account.
        expect(await claimKeyState(OTHER)).toMatchObject({ kind: 'account', identity: { publicKey: key.identity.publicKey } });
        const asAccount = await claimKeyForThisPhone(OTHER);
        expect(asAccount).toMatchObject({ createdHere: false, identity: { publicKey: key.identity.publicKey } });
        const whileOut: Array<{ record: any; guard: string | null }> = [];
        const atOther = vi.fn(async (url: string, init?: RequestInit) => {
            if (String(url) !== `${OTHER}/api/local/claim` || init?.method !== 'POST') throw new Error(`unexpected ${url}`);
            whileOut.push({ record: record(), guard: await guardAt('claim-community') });
            return json(200, { ok: true, role: 'owner', callsign: 'Ada', again: false });
        });
        const out = await claimWithKey({
            origin: OTHER, key: asAccount, code: CODE, codeId: CODE_ID, salt: SALT, callsign: 'Ada', isOwner: owner, fetchImpl: atOther as any,
        });
        expect(out).toMatchObject({ outcome: { kind: 'owner' }, madeHere: false, released: false });
        // The first claim's mark came off before the POST (the key went to OTHER), and the guard left OTHER's claim
        // screen where it was while the POST was out.
        expect(whileOut).toHaveLength(1);
        expect(whileOut[0].record).toMatchObject({ step: 'claim', flow: 'claim', anchorUrl: ORIGIN });
        expect(whileOut[0].record).not.toHaveProperty('freshKey');
        expect(whileOut[0].guard).toBeNull();

        // The next launch: every other screen goes to welcome, which drops the first claim's record instead of handing it
        // back to ORIGIN's claim screen. The key stays, and the phone is held nowhere.
        expect(await guardAt('(tabs)')).toBe('/welcome');
        expect(resumePlan(record(), stored())).toEqual({ action: 'clear' });
        await clearPendingOnboarding();
        expect(await guardAt('(tabs)')).toBeNull();
        expect(stored()?.publicKey).toBe(key.identity.publicKey);
    });

    it('a held claim\'s key taken over by an invite join whose redeem fails: welcome drops the claim\'s record, and the key stays', async () => {
        const { adoptJoinKey } = await import('../door-key');
        const { resumePlan } = await import('../onboarding-state');
        const key = await heldClaim();
        // welcome.tsx handleCreate, before its redeem: the phone's key is about to go to the invite's community.
        await adoptJoinKey(key.identity.publicKey);
        expect(record()).toMatchObject({ step: 'claim', flow: 'claim', anchorUrl: ORIGIN });
        expect(record()).not.toHaveProperty('freshKey');
        // The redeem failed. Welcome stays, where the member can try again…
        expect(await guardAt('welcome')).toBeNull();
        // …and at the next launch welcome drops the claim's record rather than sending the phone back to a claim screen
        // that reads the key as an account. The key never comes off: no door holds it now.
        expect(resumePlan(record(), stored())).toEqual({ action: 'clear' });
        expect(stored()?.publicKey).toBe(key.identity.publicKey);
    });

    it('a claim whose answer was lost, and an owner check refused for anything but not being a member: the key and the record stay', async () => {
        const { checkOwnClaim } = await import('../claim-key');
        for (const body of OTHER_403S) {
            const why = JSON.stringify(body);
            phone.async.clear(); phone.secure.clear();
            // The claim lands, its answer lost; the node says it has an owner now, and the owner check is refused.
            const key = await drafted();
            const lost = node(() => { throw new Error('connection reset'); }, [claimed]);
            let spy = answerOwnerCheck(() => (body === null ? new Response('<html>Forbidden</html>', { status: 403 }) : json(403, body)));
            const out = await claimWith(key, lost.fetchImpl, ownerCheckViaRole);
            expect(out, why).toMatchObject({ outcome: { kind: 'check-again' }, madeHere: true, released: false });
            expect(stored()?.publicKey, why).toBe(key.identity.publicKey);
            expect(record(), why).toMatchObject({ step: 'claim', flow: 'claim', freshKey: key.identity.publicKey, joinsOut: 1 });
            // The POST's own 409, then the same refusal: no answer either.
            const refused = node(() => json(409, { code: 'claim_already_claimed' }));
            expect(await claimWith({ identity: stored(), createdHere: true }, refused.fetchImpl, ownerCheckViaRole), why)
                .toMatchObject({ outcome: { kind: 'check-again' }, released: false });
            // Check again, the same refusal: kept.
            const later = node(() => { throw new Error('no POST'); }, [claimed]);
            expect(await checkOwnClaim(ORIGIN, { identity: stored(), createdHere: true }, ownerCheckViaRole, later.fetchImpl), why)
                .toEqual({ outcome: { kind: 'check-again' }, released: false });
            expect(stored()?.publicKey, why).toBe(key.identity.publicKey);
            expect(record(), why).toMatchObject({ step: 'claim', freshKey: key.identity.publicKey });
            spy.mockRestore();
            // And when the node says the key is no member there, another key owns it: the key comes off.
            spy = answerOwnerCheck(() => json(403, { error: 'Read access requires a member identity', code: 'not_a_member' }));
            const last = node(() => { throw new Error('no POST'); }, [claimed]);
            expect(await checkOwnClaim(ORIGIN, { identity: stored(), createdHere: true }, ownerCheckViaRole, last.fetchImpl), why)
                .toEqual({ outcome: { kind: 'already-claimed' }, released: true });
            expect(stored(), why).toBeNull();
            expect(record(), why).toBeNull();
            spy.mockRestore();
        }
    });
});
