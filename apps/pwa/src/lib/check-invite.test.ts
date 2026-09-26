import { describe, it, expect, vi, beforeEach } from 'vitest';

// No identity: what is checked is the code each call sends, not the signature `request` adds when there is one.
vi.mock('./identity', () => ({ loadIdentity: vi.fn(async () => null) }));

import { checkInvite, redeemOfflineTicket } from './api';

/**
 * An offline ticket (`BP-` and the ticket, made at pages/InvitePage.tsx with no connection) and what the join's
 * pre-flight sends for it. The node's check (engine/members.ts checkInvite) reads a code as a ticket only by its `BP-`;
 * anything else is looked up as an invite code. checkInvite used to cut the `BP-` off, so every ticket was answered
 * "invalid" and the join stopped at "That invite wasn't recognised" (#1218's deciding pass, 4112846555). The redeem is
 * different: there `ticketB64` is the ticket itself, without the prefix (WelcomePage handleCreate cuts it).
 */

/** A ticket as InvitePage makes one: URL-safe base64 of { p: the payload, s: its signature }, no padding. */
const TICKET = btoa(JSON.stringify({ p: JSON.stringify({ i: 'ab'.repeat(32), t: 1790000000000 }), s: `${'c2lnbmF0dXJl'.repeat(7)}AA==` }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fetchMock = vi.fn();

function reply(status: number, body: any) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

/** The code the one request asked the node about, as the node reads it off the query. */
function codeAskedAbout(): string | null {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('GET');
    const url = new URL(path, 'https://node.example');
    expect(url.pathname).toBe('/api/invite/check');
    return url.searchParams.get('code');
}

describe('checkInvite asks the node about the code the member has', () => {
    it('an offline ticket keeps its BP-, the only thing the node reads a ticket by', async () => {
        expect(TICKET.length).toBeGreaterThan(20);
        fetchMock.mockResolvedValueOnce(reply(200, { valid: true, inviterCallsign: 'Ana', communityName: 'Mullum' }));

        expect(await checkInvite(`BP-${TICKET}`)).toEqual({ valid: true, inviterCallsign: 'Ana', communityName: 'Mullum' });
        expect(fetchMock.mock.calls[0][0]).toBe(`/api/invite/check?code=${encodeURIComponent(`BP-${TICKET}`)}`);
        expect(codeAskedAbout()).toBe(`BP-${TICKET}`);
    });

    it('an invite code goes as it is', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { valid: false, reason: 'used' }));

        expect(await checkInvite('INV-ABCD-EFGH')).toEqual({ valid: false, reason: 'used' });
        expect(fetchMock.mock.calls[0][0]).toBe('/api/invite/check?code=INV-ABCD-EFGH');
        expect(codeAskedAbout()).toBe('INV-ABCD-EFGH');
    });
});

describe('the redeem still sends a ticket as the ticket alone', () => {
    it('redeemOfflineTicket posts what it is given as ticketB64', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { success: true }));

        await redeemOfflineTicket(TICKET, 'pk-rowan', 'Rowan');
        const [path, init] = fetchMock.mock.calls[0];
        expect(path).toBe('/api/invite/redeem-offline');
        expect(JSON.parse(init.body)).toEqual({ ticketB64: TICKET, publicKey: 'pk-rowan', callsign: 'Rowan' });
    });
});
