import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, scryptSync } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { CLAIM_SCRYPT, claimText, signedRequestBytes } from '@beanpool/core';

vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});

import {
    APP_CLAIM_SCRYPT, buildClaimBody, claimCodeDigits, claimCodeFromDigits, claimCommunity, claimNodeOrigin, claimOutcomeMessage,
    claimRouteFor, claimScryptIsTheApps, confirmLostClaim, isClaimCode, parseClaimLink, readClaimStatus, readNodeHasAddress, ownerCheckViaRole, claimSuccessActions, claimCodeFromScan, claimRouteFromSystemPath, claimProbeOrigin, type OwnerCheck,
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
            [200, { role: 'owner' }, 'owner'], [200, { role: 'admin' }, 'not-owner'], [403, {}, 'not-owner'],
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
