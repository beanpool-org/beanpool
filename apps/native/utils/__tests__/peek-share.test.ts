/**
 * Share outside the community, on the phone (front doors S6): which posts offer it (components/SharePost.tsx
 * shareableOutside, the node's engine/peek-tickets.ts visitorsPost in the end), and what the member is told when the
 * community answers without its own words (utils/peek.ts makePeekLink, stopPeekShare), and a link made but never handed
 * over (confirmShareOutside). The real modules; the signed request, storage and React Native stubbed at the boundary.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const signedRequestWithMethod = vi.fn();
vi.mock('react-native', () => ({
    View: 'View', Text: 'Text', Pressable: 'Pressable', StyleSheet: { create: (s: unknown) => s },
    Share: { share: vi.fn(), sharedAction: 'sharedAction', dismissedAction: 'dismissedAction' }, Alert: { alert: vi.fn() }, Platform: { OS: 'android' },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => 'https://castlemaine.beanpool.org'), setItem: vi.fn(), removeItem: vi.fn() } }));
vi.mock('../../app/ThemeContext', () => ({ useStyles: (f: (t: unknown) => unknown) => f({ colors: {} }) }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => null }));
vi.mock('../node-profile', () => ({ shareOutsideOn: () => true }));
vi.mock('../db', () => ({ signedRequestWithMethod: (...a: unknown[]) => signedRequestWithMethod(...a), signedGet: vi.fn() }));

import { Alert, Share } from 'react-native';
import { confirmShareOutside, shareableOutside, type UnsentPeekLink } from '../../components/SharePost';
import { makePeekLink, stopPeekShare } from '../peek';

const NOW = Date.parse('2026-10-29T00:00:00Z');
const PAST = '2026-10-28T00:00:00Z';
const SOON = '2026-11-01T00:00:00Z';

describe('which posts offer Share outside the community', () => {
    it('an event that has ended or was cancelled offers none: it stays active until the scrub, and the node refuses it', () => {
        const event = { type: 'event', status: 'active', active: 1, audience_scope: 'public' };
        expect(shareableOutside({ ...event, event_end_at: SOON }, NOW)).toBe(true);
        expect(shareableOutside({ ...event, eventEndAt: SOON }, NOW)).toBe(true);
        expect(shareableOutside({ ...event, event_end_at: PAST }, NOW)).toBe(false);
        expect(shareableOutside({ ...event, eventEndAt: PAST }, NOW)).toBe(false);
        expect(shareableOutside({ ...event, event_end_at: SOON, event_state: 'cancelled' }, NOW)).toBe(false);
        expect(shareableOutside({ ...event, eventEndAt: SOON, eventState: 'cancelled' }, NOW)).toBe(false);
        // An event with no end is the node's to judge, as a listing is.
        expect(shareableOutside({ ...event, event_end_at: null }, NOW)).toBe(true);
    });

    it('a listing as before: one everyone here sees, on the board', () => {
        expect(shareableOutside({ type: 'offer', status: 'active', active: 1, audience_scope: 'public', event_end_at: PAST }, NOW)).toBe(true);
        expect(shareableOutside({ type: 'offer', status: 'active', audience_scope: 'group' }, NOW)).toBe(false);
        expect(shareableOutside({ type: 'offer', status: 'paused', audienceScope: 'public' }, NOW)).toBe(false);
    });
});

describe('an answer without the community\'s words', () => {
    beforeEach(() => signedRequestWithMethod.mockReset());
    const unsaid = () => Object.assign(new Error('Request failed: 502'), { status: 502, unsaid: true });

    it('a proxy\'s 502 to Share outside is said in words, never "Request failed: 502", with its status kept', async () => {
        signedRequestWithMethod.mockRejectedValueOnce(unsaid());
        const e = await makePeekLink('p-ladder').catch(x => x);
        expect(e.message).toBe("Your community couldn't be reached. Try again.");
        expect(e.status).toBe(502);
        expect(e.unsaid).toBe(true);
    });

    it('the same for Stop sharing', async () => {
        signedRequestWithMethod.mockRejectedValueOnce(unsaid());
        const e = await stopPeekShare('r1').catch(x => x);
        expect(e.message).toBe("Your community couldn't be reached. Try again.");
        expect(e.status).toBe(502);
    });

    it('a refusal keeps the node\'s own words and code', async () => {
        signedRequestWithMethod.mockRejectedValueOnce(Object.assign(new Error('This community has turned sharing outside off.'), { status: 403, code: 'share_outside_off' }));
        const e = await makePeekLink('p-ladder').catch(x => x);
        expect(e.message).toBe('This community has turned sharing outside off.');
        expect(e.code).toBe('share_outside_off');
    });

    it('a link made: the community\'s own address, the post and the ticket', async () => {
        signedRequestWithMethod.mockResolvedValueOnce({ ticket: 'AbCdEfGhIjKlMnOpQrSt_-', postId: 'p-ladder', expiresAt: SOON });
        expect(await makePeekLink('p-ladder')).toEqual({ link: 'https://castlemaine.beanpool.org/?post=p-ladder&peek=AbCdEfGhIjKlMnOpQrSt_-', expiresAt: SOON });
        expect(signedRequestWithMethod).toHaveBeenCalledWith('POST', '/api/peek', { postId: 'p-ladder' }, { withStatus: true });
    });
});

describe('a link made but not handed over', () => {
    const TICKETS = ['AbCdEfGhIjKlMnOpQrSt_-', 'ZyXwVuTsRqPoNmLkJiHg_-', 'QqQqQqQqQqQqQqQqQqQq_-'];
    const linkFor = (ticket: string) => `https://castlemaine.beanpool.org/?post=p-ladder&peek=${ticket}`;
    const POST = { id: 'p-ladder', title: 'Ladder to lend' };
    const share = Share.share as unknown as ReturnType<typeof vi.fn>;
    const alert = Alert.alert as unknown as ReturnType<typeof vi.fn>;
    const made = () => signedRequestWithMethod.mock.calls.filter(([m, p]) => m === 'POST' && p === '/api/peek').length;
    const sharedLinks = () => share.mock.calls.map(([c]) => (c as { message: string }).message.split('\n')[1]);

    /** Share outside, and the member taps Share on the question; done once the sheet has answered. */
    async function tapShare(unsent: { current: UnsentPeekLink | null }): Promise<void> {
        alert.mockClear();
        confirmShareOutside(POST, undefined, unsent);
        const buttons = alert.mock.calls[0][2] as { text: string; onPress?: () => Promise<void> }[];
        await buttons.find(b => b.text === 'Share')!.onPress!();
    }

    beforeEach(() => {
        signedRequestWithMethod.mockReset();
        let n = 0;
        signedRequestWithMethod.mockImplementation(async (_m: string, path: string) =>
            path === '/api/peek' ? { ticket: TICKETS[n++], id: `r${n}`, postId: 'p-ladder', expiresAt: SOON } : {});
        share.mockReset();
        alert.mockReset();
    });

    it('a sheet the member closed (iOS) keeps the link: the next Share hands that one over, never a second', async () => {
        const unsent = { current: null as UnsentPeekLink | null };
        share.mockResolvedValue({ action: Share.dismissedAction });
        await tapShare(unsent);
        await tapShare(unsent);
        expect(made()).toBe(1);
        expect(sharedLinks()).toEqual([linkFor(TICKETS[0]), linkFor(TICKETS[0])]);

        share.mockResolvedValue({ action: Share.sharedAction });
        await tapShare(unsent);
        expect(made()).toBe(1);
        expect(sharedLinks()[2]).toBe(linkFor(TICKETS[0]));
        expect(unsent.current).toBeNull();

        // Handed over: the next Share is a new one.
        await tapShare(unsent);
        expect(made()).toBe(2);
        expect(sharedLinks()[3]).toBe(linkFor(TICKETS[1]));
    });

    it('a sheet that failed keeps it too, and says so', async () => {
        const unsent = { current: null as UnsentPeekLink | null };
        share.mockRejectedValueOnce(new Error('No activity'));
        await tapShare(unsent);
        expect(alert).toHaveBeenLastCalledWith('Not shared', 'No activity');
        share.mockResolvedValue({ action: Share.sharedAction });
        await tapShare(unsent);
        expect(made()).toBe(1);
        expect(sharedLinks()).toEqual([linkFor(TICKETS[0]), linkFor(TICKETS[0])]);
    });

    it('a kept link is never handed over after a Stop sharing (the post screen stays open under Shared outside)', async () => {
        const unsent = { current: null as UnsentPeekLink | null };
        share.mockResolvedValue({ action: Share.dismissedAction });
        await tapShare(unsent);
        await stopPeekShare('r1');
        share.mockResolvedValue({ action: Share.sharedAction });
        await tapShare(unsent);
        expect(made()).toBe(2);
        expect(sharedLinks()).toEqual([linkFor(TICKETS[0]), linkFor(TICKETS[1])]);
    });

    it('a stop with no answer counts too: the node may have stopped it', async () => {
        const unsent = { current: null as UnsentPeekLink | null };
        share.mockResolvedValue({ action: Share.dismissedAction });
        await tapShare(unsent);
        signedRequestWithMethod.mockRejectedValueOnce(Object.assign(new Error('Request failed: 502'), { status: 502, unsaid: true }));
        await stopPeekShare('r1').catch(() => {});
        await tapShare(unsent);
        expect(made()).toBe(2);
    });

    it('kept for its own post only', async () => {
        const unsent = { current: null as UnsentPeekLink | null };
        share.mockResolvedValue({ action: Share.dismissedAction });
        await tapShare(unsent);
        alert.mockClear();
        confirmShareOutside({ id: 'p-other', title: 'Other' }, undefined, unsent);
        await (alert.mock.calls[0][2] as { text: string; onPress?: () => Promise<void> }[]).find(b => b.text === 'Share')!.onPress!();
        expect(signedRequestWithMethod).toHaveBeenLastCalledWith('POST', '/api/peek', { postId: 'p-other' }, { withStatus: true });
    });
});
