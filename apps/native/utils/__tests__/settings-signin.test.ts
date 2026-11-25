import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('expo-local-authentication', () => ({
    SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
    getEnrolledLevelAsync: vi.fn(),
    authenticateAsync: vi.fn(),
}));

// The phone's prompt opens through LocalAuth.ts (phoneLockPrompt), whose module reads these.
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => undefined) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined) },
}));

vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (n: number) => new Uint8Array(randomBytes(n)) };
});
// The app's own signer, watched: the member key signs through @noble/ed25519's sign (utils/crypto.ts signData).
vi.mock('@noble/ed25519', async (orig) => {
    const real = await orig<typeof import('@noble/ed25519')>();
    return { ...real, sign: vi.fn(real.sign) };
});

import * as LocalAuthentication from 'expo-local-authentication';
import { sign as memberKeySign } from '@noble/ed25519';
import { ed25519 } from '@noble/curves/ed25519.js';
import { assistantConsentText, buildSettingsSigninQr, settingsSigninText, signedRequestBytes, utf8Bytes } from '@beanpool/core';
import {
    readSigninScan, scanProblemMessage, lookupPairing, buildSigninRequest,
    approveComputerSignin, declineComputerSignin, formatShortCode,
    SIGNIN_QUESTION, SIGNIN_WARNING, computerLines, formatTimeLeft, confirmDigitsLine,
    AGENT_QUESTION, AGENT_WARNING, agentLines, asksLines, formatDigits, OTHER_NETWORK_WARNING,
    DIGITS_PRIVATE, DIGITS_SHOWN_MS, digitsDone,
} from '../settings-signin';
import type { CommunityRecord } from '../community-index';

// The phone's since-boot clock (modules/boot-clock), as every phone build has it: a door acts only on a pass it can time
// (LocalAuth.timeDoorPrompt, doors-held-pass.test.ts), so with no clock it would act on none.
(globalThis as { expo?: unknown }).expo = { modules: { BeanPoolBootClock: { elapsedMs: () => performance.now() } } };

const SEED = new Uint8Array(32).fill(9);
const identity = { publicKey: Buffer.from(ed25519.getPublicKey(SEED)).toString('hex'), privateKey: Buffer.from(SEED).toString('hex'), callsign: 'me', createdAt: '' };
const signedBy = (sigB64: string, bytes: Uint8Array) =>
    ed25519.verify(Buffer.from(sigB64, 'base64'), bytes, Buffer.from(identity.publicKey, 'hex'));
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
        for (const junk of [undefined, null, 42, '', 'hello', 'https://mullum.beanpool.org/?invite=ABC', '{"sessionId":"x"}']) {
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

    it("the web app's Link with Mobile App code is Link a device's, readable or not: the scanner says so and names it (Marty, 24 Nov)", () => {
        // Before: "Not a sign-in code", and nothing said where the code belongs.
        const web = `beanpool://pair?session=${'ab'.repeat(16)}&pub=${'cd'.repeat(32)}&node=${encodeURIComponent('https://riverside.example')}`;
        for (const code of [web, `  ${web}  `, 'beanpool://pair?x=1', 'BEANPOOL://PAIR?session=1']) {
            expect(readSigninScan(code, APP_NODE).kind, code).toBe('device-link');
            expect(readSigninScan(code, null).kind, `${code}, no node`).toBe('device-link');
        }
        const m = scanProblemMessage({ kind: 'device-link' });
        expect(m.title).toBe('A code to link a device');
        expect(m.message).toContain('Settings → Link a device');
        // A sign-in code is still a sign-in code, and anything else still isn't one.
        expect(readSigninScan(qrText(), APP_NODE).kind).toBe('ok');
        expect(readSigninScan('https://riverside.example/pair?session=1', APP_NODE).kind).toBe('not-signin');
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
        expect(await lookupPairing(qr)).toEqual({
            kind: 'ok', browser: 'Firefox on Windows', expiresAt: 5,
            expiresInSeconds: null, askedSecondsAgo: null, fromAddress: null, sameNetwork: false, otherNetwork: false, agent: null,
        });
        expect(calls[0].url).toBe(`https://mullum.beanpool.org/api/local/admin/auth/pairing/${ID}`);
    });

    it('returns where and when the computer asked, as the node saw it, and the time left', async () => {
        mockFetch([{ status: 200, body: {
            shortCode: 'K7F3QX', browser: 'Chrome on macOS', expiresAt: 5,
            expiresInSeconds: 95, askedSecondsAgo: 25, fromAddress: '203.0.113.9', sameNetwork: true,
        } }]);
        expect(await lookupPairing(qr)).toEqual({
            kind: 'ok', browser: 'Chrome on macOS', expiresAt: 5,
            expiresInSeconds: 95, askedSecondsAgo: 25, fromAddress: '203.0.113.9', sameNetwork: true, otherNetwork: false, agent: null,
        });
    });

    it("reads an AI assistant's consent: its own name and the host its answers go to; a host that isn't one is dropped", async () => {
        mockFetch([{ status: 200, body: { shortCode: 'K7F3QX', browser: 'Chrome on macOS', expiresAt: 5, agent: { name: 'Claude\u202E', sendsTo: 'Claude.AI' } } }]);
        const look = await lookupPairing(qr);
        expect(look.kind === 'ok' && look.agent).toEqual({ name: 'Claude', sendsTo: 'claude.ai', asks: { canPost: false, canModerate: false } });
        mockFetch([{ status: 200, body: { shortCode: 'K7F3QX', browser: 'Chrome on macOS', expiresAt: 5, agent: { name: 'Claude', sendsTo: 'evil.example/claude.ai path' } } }]);
        const bad = await lookupPairing(qr);
        expect(bad.kind === 'ok' && bad.agent).toBeNull();
    });

    it('signs the lookup as the app signs a GET, so the node may show this admin where the computer asked from', async () => {
        const calls = mockFetch([{ status: 200, body: { shortCode: 'K7F3QX', browser: 'Chrome on macOS', expiresAt: 5 } }]);
        expect((await lookupPairing(qr, identity)).kind).toBe('ok');
        const headers = calls[0].init?.headers as Record<string, string>;
        expect(calls[0].url).toBe(`https://mullum.beanpool.org/api/local/admin/auth/pairing/${ID}`);
        expect(headers['X-Public-Key']).toBe(identity.publicKey);
        expect(headers['X-Signature']).toEqual(expect.any(String));
        expect(headers['X-Nonce']).toEqual(expect.any(String));
        expect(headers.Accept).toBe('application/json');
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

    it('signs 0xFF ‖ beanpool-settings-signin/2 for the host it is sent to, and says which host (signedFor)', async () => {
        const { url, init } = await buildSigninRequest('approve', qr, identity);
        expect(url).toBe(`https://mullum.beanpool.org/api/local/admin/auth/pairing/${ID}/approve`);
        expect(init.method).toBe('POST');
        expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
        const body = JSON.parse(init.body as string);
        expect(body).toEqual({ memberPubkey: identity.publicKey, signature: expect.any(String), signedFor: 'mullum.beanpool.org', confirm: 'six-digits' });
        expect(signedBy(body.signature, signedRequestBytes(settingsSigninText('mullum.beanpool.org', 'approve', ID, 'K7F3QX')))).toBe(true);
        // Not the old unbound text (before request binding), which any community could relay: no build signs it now.
        expect(signedBy(body.signature, utf8Bytes(`beanpool-settings-signin:v1:approve:${ID}:K7F3QX`))).toBe(false);
    });

    it('carries the 2FA code on an approval only, trimmed', async () => {
        const a = await buildSigninRequest('approve', qr, identity, ' 123456 ');
        expect(JSON.parse(a.init.body as string).totpCode).toBe('123456');
        const d = await buildSigninRequest('decline', qr, identity, '123456');
        const declined = JSON.parse(d.init.body as string);
        expect(declined).toEqual({ memberPubkey: identity.publicKey, signature: expect.any(String), signedFor: 'mullum.beanpool.org' });
        expect(d.url.endsWith('/decline')).toBe(true);
        expect(signedBy(declined.signature, signedRequestBytes(settingsSigninText('mullum.beanpool.org', 'decline', ID, 'K7F3QX')))).toBe(true);
    });

    it("says the screen showed an AI assistant (agentShown) on an approval only when it did, never on a decline", async () => {
        const shown = JSON.parse((await buildSigninRequest('approve', qr, identity, undefined, true)).init.body as string);
        expect(shown).toEqual({ memberPubkey: identity.publicKey, signature: expect.any(String), signedFor: 'mullum.beanpool.org', confirm: 'six-digits', agentShown: true });
        expect(JSON.parse((await buildSigninRequest('approve', qr, identity)).init.body as string).agentShown).toBeUndefined();
        expect(JSON.parse((await buildSigninRequest('decline', qr, identity, undefined, true)).init.body as string).agentShown).toBeUndefined();
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
        expect(memberKeySign).not.toHaveBeenCalled();
    });

    it('fails closed on a phone with no screen lock', async () => {
        vi.mocked(LocalAuthentication.getEnrolledLevelAsync).mockResolvedValue(0 as any);
        const calls = mockFetch([{ status: 200, body: { success: true } }]);
        expect(await approveComputerSignin(opts)).toEqual({ kind: 'no-device-lock' });
        expect(calls).toHaveLength(0);
    });

    it('a node that asks for number matching hands back six digits for the computer (risk 2: six, one try)', async () => {
        mockFetch([{ status: 200, body: { success: true, role: 'owner', confirmCode: '047193', confirmExpiresAt: 9 } }]);
        expect(await approveComputerSignin(opts)).toEqual({ kind: 'approved', confirmCode: '047193' });
        for (const odd of ['4x7193', '47', '0471930']) {
            mockFetch([{ status: 200, body: { success: true, role: 'owner', confirmCode: odd } }]);
            expect(await approveComputerSignin(opts)).toEqual({ kind: 'approved' });
        }
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

describe('what the approval screen says', () => {
    it('asks the question that names the trick, and says what to do if someone sent the code', () => {
        expect(SIGNIN_QUESTION).toBe('Did you just open Settings on a computer?');
        expect(SIGNIN_WARNING).toBe('If someone sent you this code, tap No.');
    });

    it('counts down the time left', () => {
        expect(formatTimeLeft(95)).toBe('1:35 left');
        expect(formatTimeLeft(5)).toBe('0:05 left');
        expect(formatTimeLeft(-3)).toBe('0:00 left');
    });

    it('says how long ago the computer asked, from which address, and "same network" only when it is', () => {
        const base = { kind: 'ok' as const, browser: 'Firefox on Windows', expiresAt: 0, expiresInSeconds: 100, agent: null, otherNetwork: false };
        expect(computerLines({ ...base, askedSecondsAgo: 40, fromAddress: '203.0.113.9', sameNetwork: true }, 0)).toEqual([
            'Computer: Firefox on Windows',
            'Asked 40 seconds ago',
            'From 203.0.113.9 (same network as this phone)',
        ]);
        expect(computerLines({ ...base, askedSecondsAgo: 1, fromAddress: '198.51.100.4', sameNetwork: false }, 0)).toEqual([
            'Computer: Firefox on Windows',
            'Asked 1 second ago',
            'From 198.51.100.4',
        ]);
        // The seconds the sheet has been open count on.
        expect(computerLines({ ...base, askedSecondsAgo: 40, fromAddress: '203.0.113.9', sameNetwork: false }, 65)[1]).toBe('Asked 1 min 45 s ago');
        // An older node tells none of it: only the browser.
        expect(computerLines({ ...base, askedSecondsAgo: null, fromAddress: null, sameNetwork: false, expiresInSeconds: null }, 0)).toEqual(['Computer: Firefox on Windows']);
    });

    it('tells the owner which six digits to type on the computer, in two groups', () => {
        expect(confirmDigitsLine(formatDigits('047193'))).toBe('On the computer, type 047 193');
        expect(formatDigits('047193')).toBe('047 193');
    });

    it('reads "other network" from the node only when both addresses could be compared and differ (the loud line)', async () => {
        const qr = { nodeUrl: 'https://riverside.example', pairingId: ID, shortCode: 'K7F3QX' };
        const reply = (over: Record<string, unknown>) => mockFetch([{ status: 200, body: { shortCode: 'K7F3QX', browser: 'Chrome on macOS', expiresAt: 5, ...over } }]);
        reply({ fromAddress: '198.51.100.4', sameNetwork: false, otherNetwork: true });
        expect(await lookupPairing(qr)).toMatchObject({ kind: 'ok', otherNetwork: true });
        reply({ fromAddress: '198.51.100.4', sameNetwork: false });
        expect(await lookupPairing(qr)).toMatchObject({ otherNetwork: false });
        reply({ fromAddress: '198.51.100.4', sameNetwork: true, otherNetwork: true });
        expect(await lookupPairing(qr)).toMatchObject({ otherNetwork: false });
        expect(OTHER_NETWORK_WARNING).toMatch(/different network/);
        expect(OTHER_NETWORK_WARNING).toMatch(/tap No\.$/);
    });

    it('says never to read the digits to anyone: only type them yourself, on the computer you just opened (4171995285)', () => {
        expect(DIGITS_PRIVATE).toMatch(/never read them out or send them to anyone/i);
        expect(DIGITS_PRIVATE).toMatch(/type them yourself/i);
    });

    it("keeps the digits up until the computer's 30 seconds have run out: Done waits, and says how long", () => {
        expect(DIGITS_SHOWN_MS).toBe(30_000);
        expect(digitsDone(DIGITS_SHOWN_MS)).toEqual({ enabled: false, label: 'Done (0:30)' });
        expect(digitsDone(12_400)).toEqual({ enabled: false, label: 'Done (0:13)' });
        expect(digitsDone(1)).toEqual({ enabled: false, label: 'Done (0:01)' });
        expect(digitsDone(0)).toEqual({ enabled: true, label: 'Done' });
        expect(digitsDone(-5_000)).toEqual({ enabled: true, label: 'Done' });
    });
});

describe("an AI assistant's consent (admin MCP S2)", () => {
    it("never shows the assistant's name without the host its answers go to, and asks the assistant question", () => {
        const lines = agentLines({ name: 'Claude', sendsTo: 'claude.ai', asks: { canPost: false, canModerate: false } });
        expect(lines[0]).toBe('Assistant: “Claude” (the name it gave itself)');
        expect(lines[1]).toBe('Sends what it reads to: claude.ai');
        expect(agentLines({ name: '', sendsTo: 'chatgpt.com', asks: { canPost: false, canModerate: false } })).toContain('Sends what it reads to: chatgpt.com');
        expect(AGENT_QUESTION).toBe('Did you just add this community to an AI assistant?');
        expect(AGENT_WARNING).toMatch(/sent you this code/);
    });

    it("tells an owner who approves that their assistant posts at once, with no approval (MCP-OWNER-POSTS), never that it can only suggest", () => {
        const line = agentLines({ name: 'Claude', sendsTo: 'claude.ai', asks: { canPost: false, canModerate: false } })[2];
        expect(line).toMatch(/If you are an owner, it can also take a backup and post Offers, Needs, events and polls for you, at once, with no approval\./);
        expect(line).toMatch(/Anything else it can only suggest, and nothing changes until you approve\.$/);
        expect(line).not.toMatch(/can only suggest changes/);
    });

    it('the Connect press sends agentShown after the unlock', async () => {
        const qr = { nodeUrl: 'https://mullum.beanpool.org', pairingId: ID, shortCode: 'K7F3QX' };
        const calls = mockFetch([{ status: 200, body: { success: true, role: 'admin', confirmCode: '420042' } }]);
        const out = await approveComputerSignin({ qr, identity, communityName: 'Mullum', agentShown: true });
        expect(out).toEqual({ kind: 'approved', confirmCode: '420042' });
        expect(JSON.parse(calls[0].init?.body as string).agentShown).toBe(true);
    });

    it('shows what the computer ticked, and says when nothing is (risk 3)', () => {
        const a = { name: 'Claude', sendsTo: 'api.example.com' };
        expect(agentLines({ ...a, asks: { canPost: false, canModerate: false } }).slice(3)).toEqual(['Nothing ticked on the computer: it posts nothing and takes nothing down.']);
        expect(asksLines({ canPost: true, canModerate: true })).toEqual([
            "Ticked on the computer: May post for me. An owner's assistant posts Offers, Needs, events and polls as you, at once.",
            'Ticked on the computer: May take down posts for me, at once.',
        ]);
    });

    it('the Connect press signs the ticks it showed and sends them; the node grants only those (risk 3)', async () => {
        const qr = { nodeUrl: 'https://riverside.example', pairingId: ID, shortCode: 'K7F3QX' };
        const ticks = { canPost: true, canModerate: false };
        const calls = mockFetch([{ status: 200, body: { success: true, role: 'owner', confirmCode: '123456' } }]);
        expect(await approveComputerSignin({ qr, identity, communityName: 'Riverside', agentShown: true, ticks })).toEqual({ kind: 'approved', confirmCode: '123456' });
        const body = JSON.parse(calls[0].init?.body as string);
        expect(body).toMatchObject({ confirm: 'six-digits', agentShown: true, ticks, signedFor: 'riverside.example' });
        expect(signedBy(body.signature, signedRequestBytes(assistantConsentText('riverside.example', ID, 'K7F3QX', ticks)))).toBe(true);
        // Not the Settings sign-in text, and not other ticks: the node checks the signature over exactly what it was shown.
        expect(signedBy(body.signature, signedRequestBytes(settingsSigninText('riverside.example', 'approve', ID, 'K7F3QX')))).toBe(false);
        expect(signedBy(body.signature, signedRequestBytes(assistantConsentText('riverside.example', ID, 'K7F3QX', { canPost: true, canModerate: true })))).toBe(false);
    });

    it("an older node's 426 (or an owner-or-admin refusal) is shown as the node words it", async () => {
        const qr = { nodeUrl: 'https://mullum.beanpool.org', pairingId: ID, shortCode: 'K7F3QX' };
        mockFetch([{ status: 426, body: { error: 'Update the BeanPool app to connect an AI assistant', code: 'agent_app_too_old' } }]);
        expect(await approveComputerSignin({ qr, identity, communityName: 'Mullum' })).toEqual({ kind: 'refused', message: 'Update the BeanPool app to connect an AI assistant' });
    });
});

describe('S5: a sign-in code at another address of the community this app is on (addresses §3.6)', () => {
    const USING = 'https://riverside.example';
    const list = (peerId: string, addresses: string[]) => ({ list: { v: 1, peerId, communityId: 'c1', epoch: 2, seq: 3, main: addresses[0], addresses, spares: [] }, sig: 'x' }) as unknown as CommunityRecord['list'];
    const here: CommunityRecord = { v: 1, id: USING, using: USING, peerId: 'peer-r', epoch: 2, proved: {}, refused: {}, list: list('peer-r', ['riverside.example', 'coop.example.org']) };
    const elsewhere: CommunityRecord = { v: 1, id: 'https://hilltop.example', using: 'https://hilltop.example', peerId: 'peer-h', epoch: 1, proved: {}, refused: {}, list: list('peer-h', ['hilltop.example', 'hill.example.org']) };
    const recordOf = (address: string) => [here, elsewhere].find((r) => r.id === address.replace(/\/$/, '').toLowerCase()) ?? null;

    it('another address its own list names: accepted, sent to the list\'s spelling of it, with the key to prove at the scan', () => {
        expect(readSigninScan(qrText('https://coop.example.org'), USING, recordOf)).toEqual({
            kind: 'ok', qr: { nodeUrl: 'https://coop.example.org', pairingId: ID, shortCode: 'K7F3QX' }, prove: { peerId: 'peer-r', epoch: 2 },
        });
    });

    it('its own address with the key known: accepted as before, and proved at the scan too', () => {
        expect(readSigninScan(qrText(USING), USING, recordOf)).toEqual({
            kind: 'ok', qr: { nodeUrl: USING, pairingId: ID, shortCode: 'K7F3QX' }, prove: { peerId: 'peer-r', epoch: 2 },
        });
    });

    it('an address another community lists, or none lists: a different community, as before (sign-in is the app\'s community only)', () => {
        expect(readSigninScan(qrText('https://hill.example.org'), USING, recordOf).kind).toBe('wrong-node');
        expect(readSigninScan(qrText('https://stranger.example'), USING, recordOf).kind).toBe('wrong-node');
        // A community whose server can't say who it is (no key): today's rule, its own address only.
        const keyless = (): CommunityRecord => ({ ...here, peerId: undefined, list: undefined });
        expect(readSigninScan(qrText('https://coop.example.org'), USING, keyless).kind).toBe('wrong-node');
        expect(readSigninScan(qrText(USING), USING, keyless)).toEqual({ kind: 'ok', qr: { nodeUrl: USING, pairingId: ID, shortCode: 'K7F3QX' } });
    });
});
