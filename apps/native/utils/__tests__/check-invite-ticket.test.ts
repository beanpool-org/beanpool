import { describe, it, expect, vi, beforeEach } from 'vitest';

// db.ts pulls in device modules at import time; stub them at the boundary (same set as redeem-invite.test.ts).
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? 'https://test.beanpool.org' : null)),
        setItem: vi.fn(async () => {}),
        removeItem: vi.fn(async () => {}),
        getAllKeys: vi.fn(async () => []),
    },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid' }));
vi.mock('expo-file-system/legacy', () => ({ cacheDirectory: '/tmp/cache/' }));
vi.mock('../identity', () => ({
    loadIdentity: vi.fn(async () => ({ publicKey: 'me-pub', privateKey: 'me-priv', callsign: 'Me' })),
}));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn(), addSavedNode: vi.fn() }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(), saveCanonicalProfile: vi.fn() }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async () => ({})),
}));

import { checkInvite, redeemInvite } from '../db';

/**
 * An offline ticket (`BP-` and the ticket, made on a phone with no connection at app/(tabs)/people.tsx) and what the
 * join's pre-flight sends for it. The node's check (engine/members.ts checkInvite) reads a code as a ticket only by its
 * `BP-`; anything else is looked up as an invite code. checkInvite used to cut the `BP-` off, so every ticket was
 * answered "invalid" and the member was told it wasn't recognised, with no redeem sent (#1218's deciding pass,
 * 4112846555). The redeem is different: there `ticketB64` is the ticket itself, without the prefix.
 */

const NODE = 'https://test.beanpool.org';
/** A ticket as people.tsx makes one: base64 of { p: the payload in base64, s: its signature in base64 }. */
const TICKET = Buffer.from(JSON.stringify({
    p: Buffer.from(JSON.stringify({ i: 'ab'.repeat(32), t: 1790000000000 })).toString('base64'),
    s: `${'c2lnbmF0dXJl'.repeat(7)}AA==`,
})).toString('base64');

const fetchMock = vi.fn();

function reply(status: number, body: any) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
}

beforeEach(() => {
    fetchMock.mockReset();
    (globalThis as any).fetch = fetchMock;
});

/** The code the one request asked the node about, as the node reads it off the query. */
function codeAskedAbout(): string | null {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(`${url.origin}${url.pathname}`).toBe(`${NODE}/api/invite/check`);
    return url.searchParams.get('code');
}

describe('checkInvite asks the node about the code the member has', () => {
    it('an offline ticket keeps its BP-, the only thing the node reads a ticket by', async () => {
        expect(TICKET.length).toBeGreaterThan(20);
        expect(TICKET).toMatch(/=$/);
        fetchMock.mockResolvedValueOnce(reply(200, { valid: true, inviterCallsign: 'Ana', communityName: 'Mullum' }));

        expect(await checkInvite(`BP-${TICKET}`, NODE)).toEqual({ valid: true, inviterCallsign: 'Ana', communityName: 'Mullum' });
        expect(fetchMock.mock.calls[0][0]).toBe(`${NODE}/api/invite/check?code=${encodeURIComponent(`BP-${TICKET}`)}`);
        expect(codeAskedAbout()).toBe(`BP-${TICKET}`);
    });

    it('a ticket this build makes (format 2, naming this community) also goes whole, BP- and all', async () => {
        const { makeOfflineTicket } = await import('../member-statements');
        const seed = new Uint8Array(32).fill(5);
        const { ed25519 } = await import('@noble/curves/ed25519.js');
        const pub = Buffer.from(ed25519.getPublicKey(seed)).toString('hex');
        const code = await makeOfflineTicket(NODE, pub, Buffer.from(seed).toString('hex'), { intendedFor: 'Robin' });
        expect(code.startsWith('BP-')).toBe(true);
        expect(JSON.parse(Buffer.from(code.slice(3), 'base64').toString('utf8')).p).toMatch(/^beanpool-invite-ticket\/2\ntest\.beanpool\.org\n/);
        fetchMock.mockResolvedValueOnce(reply(200, { valid: true, inviterCallsign: 'Ana', communityName: 'Mullum' }));

        expect(await checkInvite(code, NODE)).toEqual({ valid: true, inviterCallsign: 'Ana', communityName: 'Mullum' });
        expect(codeAskedAbout()).toBe(code);
    });

    it('an invite code goes as it is', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { valid: false, reason: 'used' }));

        expect(await checkInvite('INV-ABCD-EFGH', NODE)).toEqual({ valid: false, reason: 'used' });
        expect(fetchMock.mock.calls[0][0]).toBe(`${NODE}/api/invite/check?code=INV-ABCD-EFGH`);
        expect(codeAskedAbout()).toBe('INV-ABCD-EFGH');
    });
});

describe('the redeem still sends a ticket as the ticket alone', () => {
    it('an offline ticket goes to redeem-offline as ticketB64, without its BP-', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { success: true }));

        await redeemInvite(`BP-${TICKET}`, 'Me');
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(`${NODE}/api/invite/redeem-offline`);
        expect(JSON.parse(init.body)).toEqual({ ticketB64: TICKET, publicKey: 'me-pub', callsign: 'Me' });
    });

    it('an invite code goes to redeem as code', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { success: true }));

        await redeemInvite('INV-ABCD-EFGH', 'Me');
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(`${NODE}/api/invite/redeem`);
        expect(JSON.parse(init.body)).toEqual({ code: 'INV-ABCD-EFGH', publicKey: 'me-pub', callsign: 'Me' });
    });
});
