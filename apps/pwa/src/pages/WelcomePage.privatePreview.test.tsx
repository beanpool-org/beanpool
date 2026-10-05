/**
 * A node in a private preview (apps/server config/private-preview.ts, `features.privatePreview`): a visitor gets the
 * welcome page with the invite form and the node's sentence, never the visitor lobby or the open door, and every
 * refusal the node gives (a join, a 12-words start, a redeem, a visitor read) is shown in the node's own words.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { WelcomePage } from './WelcomePage';
import { doorOutcome, doorRefusalMessage, resetCapturedAuthReturn, wordsWorkRefusal, PRIVATE_PREVIEW_MESSAGE } from '../lib/web-join';
import { privatePreviewOn, visitorsSeeListings } from '../lib/visitor-lobby';
import { getMembers, redeemInvite, type CommunityInfo } from '../lib/api';
import { memoryIndexedDB } from '../lib/memory-indexeddb';

const SENTENCE = 'This community is in a private preview. Ask its owner for an invite.';
const REFUSAL = { error: SENTENCE, code: 'private_preview' };

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** What global answers in a preview; the door switches left on, as an operator may, to show the flag alone decides. */
const PREVIEW: CommunityInfo = {
    memberCount: 2, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'global',
    features: { openJoin: true, wordsDoor: true, guestListingsOnly: true, beans: false, privatePreview: true },
};

function stubNode(info: unknown) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === '/api/community/info') return json(200, info);
        return json(403, REFUSAL);
    }));
}

beforeEach(() => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetCapturedAuthReturn();
    window.history.replaceState(null, '', '/app');
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    resetCapturedAuthReturn();
});

describe('private preview', () => {
    it('reads the flag; a node that says nothing is not in one, and its lobby is as before', () => {
        expect(privatePreviewOn(PREVIEW)).toBe(true);
        expect(visitorsSeeListings(PREVIEW)).toBe(false);
        const off = { ...PREVIEW, features: { openJoin: true, guestListingsOnly: true } };
        expect(privatePreviewOn(off)).toBe(false);
        expect(visitorsSeeListings(off)).toBe(true);
        expect(privatePreviewOn(null)).toBe(false);
    });

    it('a visitor gets the invite form and the node\'s sentence, never the open door', async () => {
        stubNode(PREVIEW);
        render(<WelcomePage onComplete={vi.fn()} />);
        expect((await screen.findByTestId('welcome-private-preview')).textContent).toBe(SENTENCE);
        expect(screen.getByText(/Join with Invite Code/)).toBeTruthy();
        expect(screen.queryByTestId('join-screen-lobby')).toBeNull();
    });

    it('the lobby\'s info handed in says the same', async () => {
        stubNode(PREVIEW);
        render(<WelcomePage onComplete={vi.fn()} initialInfo={PREVIEW} />);
        expect((await screen.findByTestId('welcome-private-preview')).textContent).toBe(SENTENCE);
        expect(screen.queryByTestId('join-screen-lobby')).toBeNull();
    });

    it('no sentence on a node that is not in a preview', async () => {
        stubNode({ ...PREVIEW, profile: 'local', features: { openJoin: false } });
        render(<WelcomePage onComplete={vi.fn()} />);
        await screen.findByText(/Join with Invite Code/);
        expect(screen.queryByTestId('welcome-private-preview')).toBeNull();
    });

    it('a refused join, nonce or 12-words start shows the node\'s sentence as-is', () => {
        const answer = { status: 403, body: REFUSAL };
        expect(doorOutcome(answer, 'google')).toEqual({ kind: 'door_closed', message: SENTENCE });
        expect(doorOutcome(answer, null)).toEqual({ kind: 'door_closed', message: SENTENCE });
        expect(doorRefusalMessage(answer)).toBe(SENTENCE);
        expect(wordsWorkRefusal(answer)).toEqual({ kind: 'closed', message: SENTENCE });
        // A node that gives the code without words: the same sentence, never a blank.
        expect(doorOutcome({ status: 403, body: { code: 'private_preview' } }, null)).toEqual({ kind: 'door_closed', message: PRIVATE_PREVIEW_MESSAGE });
        expect(PRIVATE_PREVIEW_MESSAGE).toBe(SENTENCE);
    });

    it('a refused redeem and a refused visitor read carry the node\'s sentence and its code', async () => {
        stubNode(PREVIEW);
        const redeem = await redeemInvite('ABC123', 'ab'.repeat(32), 'Alice').catch((e) => e);
        expect(redeem).toBeInstanceOf(Error);
        expect(redeem.message).toBe(SENTENCE);
        expect(redeem.code).toBe('private_preview');
        const read = await getMembers().catch((e) => e);
        expect(read.message).toBe(SENTENCE);
        expect(read.status).toBe(403);
    });
});
