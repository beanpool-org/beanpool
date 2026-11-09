/**
 * The waiting page's "Tell me when they answer" (DESIGN-web-notifications-fable.md §2.3, slice W1): shown while the request
 * waits, never asking the browser before the tap; a click's forged notice opens nothing and is named once.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../lib/api', () => ({ getCommunityCard: vi.fn(async () => null), signedFetchAt: vi.fn() }));
vi.mock('../lib/knock', () => ({
    KNOCK_MESSAGES: { cancelled: 'cancelled', none: 'none' },
    cancelKnock: vi.fn(),
    cancelledKnocks: vi.fn(async () => ({})),
    readKnockStatus: vi.fn(async () => ({ ok: true, value: { status: 'pending' } })),
    rememberedKnocks: vi.fn(async () => []),
}));
vi.mock('../lib/knock-key', () => ({ forgetKnockKey: vi.fn(async () => true) }));
vi.mock('../components/AskHere', () => ({
    // Ask again's form, sent at once with the key the page holds.
    AskHere: ({ held, onAsked }: any) => <button type="button" data-testid="ask-here-send" onClick={() => onAsked(held)}>send</button>,
    thisCommunityOrigin: () => window.location.origin,
}));
vi.mock('../components/LanguageSwitch', () => ({ LanguageSwitch: () => null }));

import { KnockWaitingPage } from './KnockWaitingPage';
import { cancelKnock, readKnockStatus } from '../lib/knock';
import { readWebPushPin } from '../lib/web-push';

const identity = { publicKey: 'ab'.repeat(32), privateKey: '00'.repeat(48) } as any;
const page = () => render(<KnockWaitingPage identity={identity} onJoin={vi.fn()} onInvite={vi.fn()} onSignIn={vi.fn()} onForgotten={vi.fn()} />);

describe('KnockWaitingPage: Tell me when they answer', () => {
    let register: ReturnType<typeof vi.fn>;
    let requestPermission: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        localStorage.clear();
        window.history.replaceState(null, '', '/app?door=ask');
        register = vi.fn();
        requestPermission = vi.fn(async () => 'granted');
        Object.defineProperty(navigator, 'serviceWorker', { value: { register }, configurable: true });
        (globalThis as any).Notification = { permission: 'default', requestPermission };
    });

    it('while waiting: the card with its reason and Tell me, and nothing asked of the browser before the tap', async () => {
        page();
        expect(await screen.findByTestId('tell-me')).toBeTruthy();
        expect(screen.getByText('Tell me when they answer')).toBeTruthy();
        expect(screen.getByText(/answers, even with this page closed\. Nothing else\.$/)).toBeTruthy();
        expect(register).not.toHaveBeenCalled();
        expect(requestPermission).not.toHaveBeenCalled();
    });

    it("tapped where push can't work (this test browser has no PushManager): the plain words, no prompt, no worker", async () => {
        page();
        fireEvent.click(await screen.findByTestId('tell-me'));
        await waitFor(() => expect(screen.getByTestId('tell-me-off')).toBeTruthy());
        expect(screen.getByText(/^Notifications can't reach this browser\. Come back to this page/)).toBeTruthy();
        expect(requestPermission).not.toHaveBeenCalled();
        expect(register).not.toHaveBeenCalled();
    });

    /** This browser was told it would hear (an earlier Tell me): its pin, and the permission still granted. */
    const pinned = () => {
        localStorage.setItem('beanpool_web_push', JSON.stringify([{ origin: window.location.origin, publicKey: identity.publicKey, subId: 'sub-1', pushKey: 'cd'.repeat(32), vapidKey: 'BAAA' }]));
        (globalThis as any).Notification.permission = 'granted';
    };

    it('the request lapsed: the community deleted the subscription, so Ask again with this key shows Tell me, not the old ✓', async () => {
        pinned();
        vi.mocked(readKnockStatus).mockResolvedValueOnce({ ok: true, value: { status: 'none' } } as any);
        page();
        fireEvent.click(await screen.findByTestId('knock-waiting-ask-again-button'));
        fireEvent.click(await screen.findByTestId('ask-here-send'));
        // The new request waits (the default status read): the card offers Tell me again, and nothing is kept from before.
        expect(await screen.findByTestId('tell-me')).toBeTruthy();
        expect(screen.queryByTestId('tell-me-on')).toBeNull();
        expect(readWebPushPin(window.location.origin, identity.publicKey)).toBeNull();
    });

    it('cancelled: the pin goes with the request, so a later Ask again with this key shows Tell me', async () => {
        pinned();
        vi.mocked(cancelKnock).mockResolvedValueOnce({ ok: true });
        page();
        expect(await screen.findByTestId('tell-me-on')).toBeTruthy();
        fireEvent.click(screen.getByTestId('knock-waiting-cancel'));
        fireEvent.click(await screen.findByTestId('knock-waiting-cancel-yes'));
        await waitFor(() => expect(screen.queryByTestId('tell-me-card')).toBeNull());
        expect(readWebPushPin(window.location.origin, identity.publicKey)).toBeNull();
    });

    it('still waiting (a no still blocked reads so too): the ✓ stays, and the pin is kept', async () => {
        pinned();
        page();
        expect(await screen.findByTestId('tell-me-on')).toBeTruthy();
        expect(readWebPushPin(window.location.origin, identity.publicKey)?.subId).toBe('sub-1');
    });

    it('a click that brought a notice nobody signed for this key: the warning once, and the fragment goes', async () => {
        window.history.replaceState(null, '', `/app?door=ask#notice=${encodeURIComponent(JSON.stringify({ bp: 1, k: 'join.answered', i: 'ab'.repeat(16), t: 1, c: '00'.repeat(8), s: '00'.repeat(64) }))}`);
        page();
        expect(await screen.findByText(/^That notification didn't come from your community\./)).toBeTruthy();
        expect(window.location.hash).toBe('');
        expect(window.location.search).toBe('?door=ask');
    });
});
