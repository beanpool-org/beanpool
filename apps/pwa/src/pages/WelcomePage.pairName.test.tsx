/**
 * "Link with Mobile App (Scan QR)" from a phone whose copy of the account has no name (tester report, 22 Oct: a member
 * of years saw "Received incomplete identity payload" twice). Phones save an account with no name after some joins and
 * restores, and the app still shows their name from the community's member record, so nothing looks wrong until this.
 * Phones already installed send what they hold, so this browser takes the key and asks the community for the name, the
 * way a 12-words restore does; with no name there, it goes on with none. The key and the private key stay required.
 *
 * The node is a stubbed fetch; the phone's side is the real encryption (core pairing-crypto). Assertions compare keys
 * as booleans, so a failure never prints key material.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('qrcode.react', () => ({ QRCodeSVG: () => null }));

import { encryptPairingPayload } from '@beanpool/core';
import { WelcomePage } from './WelcomePage';
import { generateIdentity, loadIdentity, type BeanPoolIdentity } from '../lib/identity';
import { resetCapturedAuthReturn } from '../lib/web-join';
import { memoryIndexedDB } from '../lib/memory-indexeddb';

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const LOCAL = { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local', features: {} };
const GLOBAL_OPEN = { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'global', features: { openJoin: true } };
const INCOMPLETE = 'Received incomplete identity payload';

let account: BeanPoolIdentity;

/**
 * The relay, with the phone having sent `payload` (sealed to the page's own session key from /api/pair/init) and the
 * digits typed: the first poll brings it. `membership` is the community's answer for this key.
 */
function stubPairedPhone(payload: Record<string, unknown>, membership: () => Response, info: unknown = LOCAL) {
    const asked: string[] = [];
    let session: { sessionId: string; desktopPubHex: string } | null = null;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input).replace(/^https?:\/\/[^/]+/, '');
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        if (path === '/api/community/info') return json(200, info);
        if (path === '/api/pair/init') {
            session = body;
            return json(200, { success: true, expiresAt: Date.now() + 120_000 });
        }
        if (path.startsWith('/api/pair/poll')) {
            if (!session) return json(200, { status: 'waiting' });
            return json(200, { status: 'transferred', payload: encryptPairingPayload(payload, session.desktopPubHex, session.sessionId) });
        }
        if (path.startsWith('/api/community/membership/')) {
            asked.push(path);
            return membership();
        }
        return json(200, {});
    }));
    return asked;
}

/** What the phone sends (pair-device.tsx), with its name as given. */
function phonePayload(callsign: string | undefined): Record<string, unknown> {
    const p: Record<string, unknown> = {
        publicKey: account.publicKey,
        privateKey: account.privateKey,
        mnemonic: account.mnemonic,
        createdAt: account.createdAt,
        version: 1,
    };
    if (callsign !== undefined) p.callsign = callsign;
    return p;
}

const memberAlice = () => json(200, { isMember: true, callsign: 'Alice' });

/** "Already have an account" → the phone. The open door (WebJoin) names the button its own way, and enables it once it knows this browser can hold a key. */
async function linkFromPhone(button: RegExp = /Link with Mobile App/) {
    const onComplete = vi.fn();
    render(<WelcomePage onComplete={onComplete} start="restore" />);
    const link = (await screen.findAllByRole('button', { name: button }, { timeout: 4_000 }))[0] as HTMLButtonElement;
    await waitFor(() => expect(link.disabled).toBe(false));
    fireEvent.click(link);
    return onComplete;
}

/** The account this browser now holds is the phone's: same key pair. Booleans only, never the keys themselves. */
async function savedIsTheAccount(): Promise<{ sameKeys: boolean; callsign: string | undefined }> {
    const saved = await loadIdentity();
    return { sameKeys: saved?.publicKey === account.publicKey && saved?.privateKey === account.privateKey, callsign: saved?.callsign };
}

beforeEach(async () => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetCapturedAuthReturn();
    window.history.replaceState(null, '', '/app');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    account = await generateIdentity('');
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetCapturedAuthReturn();
});

describe('linking with the phone: a phone whose account has no name', () => {
    for (const [what, callsign] of [['an empty name', ''], ['no name at all', undefined]] as const) {
        it(`${what}: the account comes in, named as the community's member record names it`, async () => {
            const asked = stubPairedPhone(phonePayload(callsign), memberAlice);
            const onComplete = await linkFromPhone();
            await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1), { timeout: 5_000 });
            expect(screen.queryByText(INCOMPLETE)).toBeNull();
            const handed = onComplete.mock.calls[0][0] as BeanPoolIdentity;
            expect(handed.publicKey === account.publicKey && handed.privateKey === account.privateKey).toBe(true);
            expect(handed.callsign).toBe('Alice');
            expect(await savedIsTheAccount()).toEqual({ sameKeys: true, callsign: 'Alice' });
            // The same question the 12 words ask: the community's member record for this key.
            expect(asked).toEqual([`/api/community/membership/${account.publicKey}`]);
        });
    }

    it('the community has no name for the key: the account still comes in, with no name, and none is made up', async () => {
        stubPairedPhone(phonePayload(''), () => json(200, { isMember: false, callsign: null }));
        const onComplete = await linkFromPhone();
        await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1), { timeout: 5_000 });
        expect(screen.queryByText(INCOMPLETE)).toBeNull();
        expect((onComplete.mock.calls[0][0] as BeanPoolIdentity).callsign).toBe('');
        expect(await savedIsTheAccount()).toEqual({ sameKeys: true, callsign: '' });
    });

    it('the community can\'t be asked: the account still comes in, its name to come on the next open', async () => {
        stubPairedPhone(phonePayload(''), () => json(503, { error: 'down' }));
        const onComplete = await linkFromPhone();
        await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1), { timeout: 5_000 });
        expect(screen.queryByText(INCOMPLETE)).toBeNull();
        expect(await savedIsTheAccount()).toEqual({ sameKeys: true, callsign: '' });
    });

    it('a phone that sends its name: that name, as before', async () => {
        stubPairedPhone(phonePayload('Al'), memberAlice);
        const onComplete = await linkFromPhone();
        await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1), { timeout: 5_000 });
        expect((onComplete.mock.calls[0][0] as BeanPoolIdentity).callsign).toBe('Al');
        expect(await savedIsTheAccount()).toEqual({ sameKeys: true, callsign: 'Al' });
    });

    it('on the global community\'s open door: the member comes in, named by the member record', async () => {
        stubPairedPhone(phonePayload(''), memberAlice, GLOBAL_OPEN);
        const onComplete = await linkFromPhone(/Link with my phone/);
        await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1), { timeout: 5_000 });
        expect(screen.queryByText(INCOMPLETE)).toBeNull();
        expect((onComplete.mock.calls[0][0] as BeanPoolIdentity).callsign).toBe('Alice');
        expect(await savedIsTheAccount()).toEqual({ sameKeys: true, callsign: 'Alice' });
    });

    for (const missing of ['privateKey', 'publicKey'] as const) {
        it(`no ${missing}: still refused as incomplete, and nothing is saved`, async () => {
            const payload = phonePayload('Alice');
            delete payload[missing];
            stubPairedPhone(payload, memberAlice);
            const onComplete = await linkFromPhone();
            expect(await screen.findByText(INCOMPLETE, {}, { timeout: 5_000 })).toBeTruthy();
            expect(onComplete).not.toHaveBeenCalled();
            expect(await loadIdentity()).toBeNull();
        });
    }
});
