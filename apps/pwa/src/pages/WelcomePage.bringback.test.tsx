/**
 * WelcomePage and a bring-back code (vault rethink VR3): "An admin gave me a re-key code" takes a `BB-` code; the number
 * shows, says the SAME key comes back, and the `released` answer saves the member's own key (and 12 words) as this
 * browser's account, never over another, with the key the ask was made with let go. The node is a stubbed fetch over the
 * real identity store (an in-memory IndexedDB); the copy and the release are real (@beanpool/core), made as the
 * community's server makes them. Test keys only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { communityCopyForRelease, communityHalfForRelease, sealReleaseToDevice, sealSeedToCopyKey } from '@beanpool/core';
import { WelcomePage } from './WelcomePage';
import { generateIdentity, importIdentity, loadIdentity, loadPendingJoin } from '../lib/identity';
import { resetCapturedAuthReturn } from '../lib/web-join';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { WEB_REKEY_POLL_MS } from '../lib/web-rekey';

const WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
const MEMBER_SEED = sha256(sha256(utf8ToBytes(WORDS.join(' '))));
const MEMBER_KEY = bytesToHex(ed25519.getPublicKey(MEMBER_SEED));
const CODE = 'BB-AB12-CD34';
const LOCAL = { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local', features: {} };

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The node: the ask waits; the poll answers the release, sealed to the key that asked. */
function stubNode() {
    let asker = '';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input).replace(/^https?:\/\/[^/]+/, '');
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        if (path === '/api/community/info') return json(200, LOCAL);
        if (path.startsWith('/api/member/re-enroll/status')) {
            const made = sealSeedToCopyKey(MEMBER_SEED, { words: WORDS });
            return json(200, {
                state: 'released', callsign: 'MiaMember', communityName: 'Mullum', memberKey: MEMBER_KEY,
                release: sealReleaseToDevice(communityCopyForRelease(made), asker, { collectionId: CODE, holderType: 'community' }),
            });
        }
        if (path === '/api/member/re-enroll') {
            asker = body.newPublicKey;
            return json(200, { state: 'waiting', match: '47', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
        }
        return json(200, {});
    }));
}

beforeEach(() => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetCapturedAuthReturn();
    window.history.replaceState(null, '', '/app');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetCapturedAuthReturn();
});

describe('a bring-back code for a copy half kept at the key vault (vault rethink VR4)', () => {
    it('this browser can\'t reach the vault: it says to use the phone app, opens nothing, saves nothing, and lets its key go', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        let asker = '';
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
            const path = String(input).replace(/^https?:\/\/[^/]+/, '');
            const body = init.body ? JSON.parse(String(init.body)) : undefined;
            if (path === '/api/community/info') return json(200, LOCAL);
            if (path.startsWith('/api/member/re-enroll/status')) {
                return json(200, {
                    state: 'released', callsign: 'MiaMember', communityName: 'Mullum', memberKey: MEMBER_KEY, voucher: 'a-voucher',
                    release: sealReleaseToDevice(communityHalfForRelease({ half: Buffer.alloc(32, 7).toString('base64'), copy: 'A'.repeat(43) }), asker, { collectionId: CODE, holderType: 'community-half' }),
                });
            }
            if (path === '/api/member/re-enroll') {
                asker = body.newPublicKey;
                return json(200, { state: 'waiting', match: '47', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
            }
            return json(200, {});
        }));
        window.history.replaceState(null, '', `/app?rekey=${CODE.toLowerCase()}`);
        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
        await screen.findByTestId('web-rekey-number');
        await act(async () => { await vi.advanceTimersByTimeAsync(WEB_REKEY_POLL_MS + 50); });
        expect(await screen.findByText(/which only the phone app can reach\. Ask the admin for a new code, and use it in the phone app\./)).toBeTruthy();
        expect(screen.queryByTestId('web-rekey-brought-back')).toBeNull();
        expect(await loadIdentity()).toBeNull();
        expect(await loadPendingJoin()).toBeNull();
        expect(onComplete).not.toHaveBeenCalled();
    });
});

describe('a bring-back code in the web app', () => {
    it('the number says the same key comes back; the release saves the member\'s own key and words, and lets the asking key go', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        stubNode();
        window.history.replaceState(null, '', `/app?rekey=${CODE.toLowerCase()}`);
        const onComplete = vi.fn();
        render(<WelcomePage onComplete={onComplete} />);
        expect(screen.getByLabelText('The code')).toHaveValue(CODE);
        fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
        expect((await screen.findByTestId('web-rekey-number')).textContent).toBe('47');
        expect(screen.getByText(/Your account comes back on this device, the same key\./)).toBeTruthy();
        expect(screen.queryByText(/Your old phone stops working for good/)).toBeNull();

        await act(async () => { await vi.advanceTimersByTimeAsync(WEB_REKEY_POLL_MS + 50); });
        expect(await screen.findByTestId('web-rekey-brought-back')).toBeTruthy();
        expect(screen.getByText(/Your 12 words came back with it/)).toBeTruthy();
        const saved = (await loadIdentity())!;
        expect(saved.publicKey).toBe(MEMBER_KEY);
        expect(saved.callsign).toBe('MiaMember');
        expect(saved.mnemonic).toEqual(WORDS);
        expect(await loadPendingJoin()).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
        expect(onComplete).toHaveBeenCalledTimes(1);
        expect(onComplete.mock.calls[0][0]).toMatchObject({ publicKey: MEMBER_KEY });
    });

    it('a browser holding another account is never written over: it says so, and keeps its account', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const mine = await generateIdentity('Ada');
        await importIdentity(mine);
        stubNode();
        window.history.replaceState(null, '', `/app?rekey=${CODE}`);
        render(<WelcomePage onComplete={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
        await screen.findByTestId('web-rekey-number');
        await act(async () => { await vi.advanceTimersByTimeAsync(WEB_REKEY_POLL_MS + 50); });
        expect(await screen.findByText(/This browser holds another BeanPool account, so this one wasn’t saved here\./)).toBeTruthy();
        expect((await loadIdentity())!.publicKey).toBe(mine.publicKey);
        expect(screen.queryByTestId('web-rekey-brought-back')).toBeNull();
    });
});
