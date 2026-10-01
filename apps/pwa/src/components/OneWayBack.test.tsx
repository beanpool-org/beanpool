/**
 * "Your account has one way back" (two-doors design §2.5, slice S5): shown only when the node says the member came in
 * with 12 words and has added no sign-in (`/api/community/me` `probation.rules === 'words'`); on the landing screen it can
 * be put away, comes back once after a post that stays up and once when the first week is over, then lives in Settings
 * only; in Settings it stays until a sign-in is added. "Add a sign-in" asks the node which sign-ins it offers for this
 * member and leaves for the one chosen. Never a gate: nothing here blocks anything. The node is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as api from '../lib/api';
import { generateIdentity, type BeanPoolIdentity } from '../lib/identity';
import { loadPendingLink } from '../lib/link-signin';
import { OneWayBackCard, ONE_WAY_BACK } from './OneWayBack';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
    return { ...actual, getCommunityMe: vi.fn() };
});

const DAY = 24 * 3600_000;

function standing(rules: 'words' | 'ordinary' | undefined, keptPosts = 0, weekOver = false) {
    return {
        publicKey: 'x',
        probation: {
            onProbation: true, exemptBecause: null, keptPosts, keptPostsNeeded: 3,
            ageEndsAt: new Date(Date.now() + (weekOver ? -DAY : 6 * DAY)).toISOString(),
            limits: {} as never, ...(rules ? { rules } : {}),
        },
        mute: { muted: false, until: null },
    } as unknown as api.CommunityStanding;
}

let identity: BeanPoolIdentity;
beforeEach(async () => {
    localStorage.clear();
    identity = await generateIdentity('Bea');
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.mocked(api.getCommunityMe).mockReset();
});

describe('who it is for: the node says so', () => {
    it('a member who joined with 12 words and has no sign-in: the card, in the design\'s words', async () => {
        vi.mocked(api.getCommunityMe).mockResolvedValue(standing('words'));
        render(<OneWayBackCard identity={identity} placement="landing" onSeeWords={() => {}} />);
        expect(await screen.findByTestId('one-way-back-text')).toHaveTextContent(ONE_WAY_BACK);
        expect(ONE_WAY_BACK).toBe('Your account has one way back: your 12 words. Check you still have them, or add a sign-in.');
    });

    it('anyone else, a node that does not say, or no answer: nothing', async () => {
        const answers = [async () => standing('ordinary'), async () => standing(undefined), async () => { throw new Error('offline'); }];
        for (const answer of answers) {
            vi.mocked(api.getCommunityMe).mockImplementation(answer);
            render(<OneWayBackCard identity={identity} placement="settings" onSeeWords={() => {}} />);
            await waitFor(() => expect(api.getCommunityMe).toHaveBeenCalled());
            await new Promise((r) => setTimeout(r, 20));
            expect(screen.queryByTestId('one-way-back-settings')).toBeNull();
            cleanup();
            vi.mocked(api.getCommunityMe).mockClear();
        }
    });
});

describe('on the landing screen: put away, it comes back twice, then lives in Settings only', () => {
    async function shown(s: api.CommunityStanding): Promise<boolean> {
        cleanup();
        vi.mocked(api.getCommunityMe).mockResolvedValue(s);
        render(<OneWayBackCard identity={identity} placement="landing" onSeeWords={() => {}} />);
        await waitFor(() => expect(api.getCommunityMe).toHaveBeenCalled());
        await new Promise((r) => setTimeout(r, 20));
        return !!screen.queryByTestId('one-way-back-landing');
    }
    const hide = () => fireEvent.click(screen.getByRole('button', { name: 'Hide this for now' }));

    it('after their next post that stays up, and when the first week is over', async () => {
        expect(await shown(standing('words', 0))).toBe(true);
        hide();
        expect(screen.queryByTestId('one-way-back-landing')).toBeNull();
        expect(await shown(standing('words', 0))).toBe(false);
        // A post that stayed up: once more.
        expect(await shown(standing('words', 1))).toBe(true);
        hide();
        expect(await shown(standing('words', 2))).toBe(false);
        // The first week over: once more.
        expect(await shown(standing('words', 2, true))).toBe(true);
        hide();
        expect(await shown(standing('words', 5, true))).toBe(false);
        // Settings keeps it.
        cleanup();
        render(<OneWayBackCard identity={identity} placement="settings" onSeeWords={() => {}} />);
        expect(await screen.findByTestId('one-way-back-settings')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Hide this for now' })).toBeNull();
    });

    it('"See my 12 words" opens them, and the landing card is done', async () => {
        const onSeeWords = vi.fn();
        vi.mocked(api.getCommunityMe).mockResolvedValue(standing('words'));
        render(<OneWayBackCard identity={identity} placement="landing" onSeeWords={onSeeWords} />);
        fireEvent.click(await screen.findByTestId('one-way-back-words'));
        expect(onSeeWords).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId('one-way-back-landing')).toBeNull();
        expect(await shown(standing('words', 3, true))).toBe(false);
    });
});

describe('adding a sign-in from the card', () => {
    it("asks the node for this member's link nonce, offers its sign-ins, and leaves for the one chosen", async () => {
        vi.mocked(api.getCommunityMe).mockResolvedValue(standing('words'));
        const calls: Array<{ path: string; headers: Record<string, string> }> = [];
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
            calls.push({ path: String(input), headers: (init.headers ?? {}) as Record<string, string> });
            return new Response(JSON.stringify({
                nonce: 'link-n', expiresInSeconds: 600, providers: ['google', 'apple', 'facebook'],
                clientIds: { google: 'web-client', apple: 'org.beanpool.web', facebook: null }, vault: null,
            }), { status: 200 });
        }));
        const navigate = vi.fn();
        render(<OneWayBackCard identity={identity} placement="settings" onSeeWords={() => {}} navigate={navigate} origin="https://global.beanpool.org" />);
        fireEvent.click(await screen.findByTestId('add-sign-in-start'));
        fireEvent.click(await screen.findByTestId('add-sign-in-google'));
        expect(screen.queryByTestId('add-sign-in-facebook')).toBeNull();
        expect(calls[0].path).toBe('/api/join/link/sso-nonce');
        expect(calls[0].headers['X-Public-Key']).toBe(identity.publicKey);
        const url = new URL(navigate.mock.calls[0][0]);
        expect(url.searchParams.get('state')).toBe('link-n');
        expect(loadPendingLink()).toMatchObject({ publicKey: identity.publicKey, provider: 'google', nonce: 'link-n' });
    });

    it("a refusal is a sentence beside the button; the result of one that came back is said", async () => {
        vi.mocked(api.getCommunityMe).mockResolvedValue(standing('words'));
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'This account already has a sign-in.', code: 'already_linked' }), { status: 409 })));
        render(<OneWayBackCard identity={identity} placement="settings" onSeeWords={() => {}}
            result={{ kind: 'failed', provider: 'google', message: "This Google account already has another BeanPool account here, so it can't be added to this one. Choose another sign-in." }} />);
        expect(screen.getByTestId('link-result')).toHaveTextContent('This Google account already has another BeanPool account here');
        fireEvent.click(await screen.findByTestId('add-sign-in-start'));
        expect(await screen.findByTestId('add-sign-in-problem')).toHaveTextContent('This account already has a sign-in.');
    });
});
