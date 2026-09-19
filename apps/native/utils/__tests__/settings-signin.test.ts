import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('expo-local-authentication', () => ({
    SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
    getEnrolledLevelAsync: vi.fn(),
    authenticateAsync: vi.fn(),
}));

vi.mock('../crypto', () => ({
    buildSignedHeaders: vi.fn(),
    signData: vi.fn(async () => new Uint8Array([1, 2, 3])),
    encodeUtf8: (s: string) => new TextEncoder().encode(s),
    hexToBytes: () => new Uint8Array(32),
    encodeBase64: () => 'AQID',
}));

import * as LocalAuthentication from 'expo-local-authentication';
import { buildSettingsSigninQr } from '@beanpool/core';
import { signData } from '../crypto';
import {
    readSigninScan, scanProblemMessage, lookupPairing, buildSigninRequest, signinMessage,
    approveComputerSignin, declineComputerSignin, formatShortCode,
} from '../settings-signin';

const identity = { publicKey: 'ab'.repeat(32), privateKey: 'cd'.repeat(32), callsign: 'me', createdAt: '' };
const ID = '0123456789abcdef'.repeat(4);
const APP_NODE = 'https://mullum.beanpool.org/';
const qrText = (node = 'https://mullum.beanpool.org', pairingId = ID, shortCode = 'K7F3QX') => buildSettingsSigninQr({ nodeUrl: node, pairingId, shortCode });

type Reply = { status: number; body: unknown };
function mockFetch(replies: Reply[]) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const q = [...replies];
    (globalThis as any).fetch = vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        const r = q.length > 1 ? q.shift()! : q[0];
        if (!r) throw new Error(`unexpected fetch ${url}`);
        return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as Response;
    });
    return calls;
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(LocalAuthentication.getEnrolledLevelAsync).mockResolvedValue(3 as any);
    vi.mocked(LocalAuthentication.authenticateAsync).mockResolvedValue({ success: true } as any);
});

describe('reading the scanned code', () => {
    it('accepts a sign-in code for this app\'s node, however the node URL is written', () => {
        for (const appNode of [APP_NODE, 'https://mullum.beanpool.org', 'HTTPS://Mullum.BeanPool.org:443/']) {
            const r = readSigninScan(qrText(), appNode);
            expect(r).toEqual({ kind: 'ok', qr: { nodeUrl: 'https://mullum.beanpool.org', pairingId: ID, shortCode: 'K7F3QX' } });
        }
    });

    it('refuses a code from a different node, naming both', () => {
        const r = readSigninScan(qrText('https://castlemaine.beanpool.org'), APP_NODE);
        expect(r).toEqual({ kind: 'wrong-node', scannedHost: 'castlemaine.beanpool.org', appHost: 'mullum.beanpool.org' });
        const msg = scanProblemMessage(r as any);
        expect(msg.message).toContain('castlemaine.beanpool.org');
        expect(msg.message).toContain('mullum.beanpool.org');
    });

    it('a look-alike host, another port or plain http is a different node', () => {
        for (const other of ['https://mullum.beanpool.org.evil.example', 'https://mullum.beanpool.org:8443', 'http://mullum.beanpool.org', 'https://evil.example/mullum.beanpool.org']) {
            expect(readSigninScan(qrText(other), APP_NODE).kind).toBe('wrong-node');
        }
    });

    it('garbage, other QR codes and damaged sign-in codes are refused', () => {
        for (const junk of [undefined, null, 42, '', 'hello', 'https://mullum.beanpool.org/?invite=ABC', 'beanpool://pair?x=1', '{"sessionId":"x"}']) {
            expect(readSigninScan(junk, APP_NODE).kind).toBe('not-signin');
        }
        const damaged = [
            'beanpool-settings-signin:v1?node=https%3A%2F%2Fmullum.beanpool.org&p=' + ID + '&c=K7F',       // short code cut
            'beanpool-settings-signin:v1?node=https%3A%2F%2Fmullum.beanpool.org&p=' + ID.slice(2) + '&c=K7F3QX', // id cut
            'beanpool-settings-signin:v1?node=javascript%3Aalert(1)&p=' + ID + '&c=K7F3QX',                 // not http(s)
            'beanpool-settings-signin:v1?p=' + ID + '&c=K7F3QX',                                             // no node
            'beanpool-settings-signin:v1?node=https%3A%2F%2Fmullum.beanpool.org&p=' + ID + '&c=K7F3Q0',     // 0 is not in the alphabet
            'beanpool-settings-signin:v1?' + 'x'.repeat(500),
        ];
        for (const d of damaged) expect(readSigninScan(d, APP_NODE).kind).toBe('malformed');
    });

    it('with no node set up, says so rather than approving anywhere', () => {
        expect(readSigninScan(qrText(), null).kind).toBe('no-node');
    });

    it('shows the short code in two groups, as the computer does', () => {
        expect(formatShortCode('K7F3QX')).toBe('K7F 3QX');
    });
});

describe('asking the node about the pairing', () => {
    const qr = { nodeUrl: 'https://mullum.beanpool.org', pairingId: ID, shortCode: 'K7F3QX' };

    it('returns which browser asked when the short code matches', async () => {
        const calls = mockFetch([{ status: 200, body: { shortCode: 'K7F3QX', browser: 'Firefox on Windows', expiresAt: 5 } }]);
        expect(await lookupPairing(qr)).toEqual({ kind: 'ok', browser: 'Firefox on Windows', expiresAt: 5 });
        expect(calls[0].url).toBe(`https://mullum.beanpool.org/api/local/admin/auth/pairing/${ID}`);
    });

    it('refuses a QR whose short code the node does not recognise (a doctored code)', async () => {
        mockFetch([{ status: 200, body: { shortCode: 'M4P9WZ', browser: 'Chrome on macOS', expiresAt: 5 } }]);
        expect((await lookupPairing(qr)).kind).toBe('gone');
    });

    it('an expired or unknown pairing is "gone"; a 5xx or no network is an error', async () => {
        mockFetch([{ status: 410, body: { error: 'That code has expired.' } }]);
        expect(await lookupPairing(qr)).toEqual({ kind: 'gone', message: 'That code has expired.' });
        mockFetch([{ status: 502, body: {} }]);
        expect((await lookupPairing(qr)).kind).toBe('error');
        (globalThis as any).fetch = vi.fn(async () => { throw new Error('offline'); });
        expect(await lookupPairing(qr)).toEqual({ kind: 'error', message: 'offline' });
    });
});

describe('the approval request', () => {
    const qr = { nodeUrl: 'https://mullum.beanpool.org', pairingId: ID, shortCode: 'K7F3QX' };

    it('signs exactly beanpool-settings-signin:v1:approve:<id>:<code> with the member key', async () => {
        const { url, init } = await buildSigninRequest('approve', qr, identity);
        expect(url).toBe(`https://mullum.beanpool.org/api/local/admin/auth/pairing/${ID}/approve`);
        expect(init.method).toBe('POST');
        expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
        expect(JSON.parse(init.body as string)).toEqual({ memberPubkey: identity.publicKey, signature: 'AQID' });
        const signed = new TextDecoder().decode(vi.mocked(signData).mock.calls[0][0] as Uint8Array);
        expect(signed).toBe(`beanpool-settings-signin:v1:approve:${ID}:K7F3QX`);
        expect(signed).toBe(signinMessage('approve', qr));
    });

    it('carries the 2FA code on an approval only, trimmed', async () => {
        const a = await buildSigninRequest('approve', qr, identity, ' 123456 ');
        expect(JSON.parse(a.init.body as string).totpCode).toBe('123456');
        const d = await buildSigninRequest('decline', qr, identity, '123456');
        expect(JSON.parse(d.init.body as string)).toEqual({ memberPubkey: identity.publicKey, signature: 'AQID' });
        expect(d.url.endsWith('/decline')).toBe(true);
        expect(new TextDecoder().decode(vi.mocked(signData).mock.calls[1][0] as Uint8Array)).toBe(`beanpool-settings-signin:v1:decline:${ID}:K7F3QX`);
    });

    it('never sends a private key', async () => {
        const { init } = await buildSigninRequest('approve', qr, identity);
        expect(init.body as string).not.toContain(identity.privateKey);
    });
});

describe('the "Sign in" press', () => {
    const qr = { nodeUrl: 'https://mullum.beanpool.org', pairingId: ID, shortCode: 'K7F3QX' };
    const opts = { qr, identity, communityName: 'Mullum' };

    it('asks for the phone\'s unlock before signing or sending anything', async () => {
        vi.mocked(LocalAuthentication.authenticateAsync).mockResolvedValue({ success: false } as any);
        const calls = mockFetch([{ status: 200, body: { success: true } }]);
        expect(await approveComputerSignin(opts)).toEqual({ kind: 'unlock-failed' });
        expect(calls).toHaveLength(0);
        expect(signData).not.toHaveBeenCalled();
    });

    it('fails closed on a phone with no screen lock', async () => {
        vi.mocked(LocalAuthentication.getEnrolledLevelAsync).mockResolvedValue(0 as any);
        const calls = mockFetch([{ status: 200, body: { success: true } }]);
        expect(await approveComputerSignin(opts)).toEqual({ kind: 'no-device-lock' });
        expect(calls).toHaveLength(0);
    });

    it('approves after the unlock', async () => {
        const calls = mockFetch([{ status: 200, body: { success: true, role: 'owner' } }]);
        expect(await approveComputerSignin(opts)).toEqual({ kind: 'approved' });
        expect(calls).toHaveLength(1);
        expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
    });

    it('asks for the node\'s 2FA code and continues without a second unlock', async () => {
        mockFetch([{ status: 401, body: { totpRequired: true } }, { status: 200, body: { success: true } }]);
        const first = await approveComputerSignin(opts);
        expect(first.kind).toBe('totp-required');
        if (first.kind !== 'totp-required') return;
        expect(first.wrongCode).toBe(false);
        expect(await first.continueWith('123456')).toEqual({ kind: 'approved' });
        expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
    });

    it('says plainly when the member holds no role here, or the code is gone', async () => {
        mockFetch([{ status: 403, body: { error: 'x', reason: 'not-admin' } }]);
        const r = await approveComputerSignin(opts);
        expect(r).toEqual({ kind: 'refused', message: "You are not an owner, admin or moderator of Mullum, so you can't open its Settings." });
        mockFetch([{ status: 410, body: { error: 'That code has expired. Get a new code on the computer.' } }]);
        expect(await approveComputerSignin(opts)).toEqual({ kind: 'refused', message: 'That code has expired. Get a new code on the computer.' });
    });

    it('decline is best effort and never throws', async () => {
        (globalThis as any).fetch = vi.fn(async () => { throw new Error('offline'); });
        await expect(declineComputerSignin(qr, identity)).resolves.toBeUndefined();
    });
});
