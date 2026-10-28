/**
 * Share outside the community, on the phone (front doors S6): which posts offer it (components/SharePost.tsx
 * shareableOutside, the node's engine/peek-tickets.ts visitorsPost in the end), and what the member is told when the
 * community answers without its own words (utils/peek.ts makePeekLink, stopPeekShare). The real modules; the signed
 * request, storage and React Native stubbed at the boundary.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const signedRequestWithMethod = vi.fn();
vi.mock('react-native', () => ({
    View: 'View', Text: 'Text', Pressable: 'Pressable', StyleSheet: { create: (s: unknown) => s },
    Share: { share: vi.fn() }, Alert: { alert: vi.fn() }, Platform: { OS: 'android' },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => 'https://castlemaine.beanpool.org'), setItem: vi.fn(), removeItem: vi.fn() } }));
vi.mock('../../app/ThemeContext', () => ({ useStyles: (f: (t: unknown) => unknown) => f({ colors: {} }) }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => null }));
vi.mock('../node-profile', () => ({ shareOutsideOn: () => true }));
vi.mock('../db', () => ({ signedRequestWithMethod: (...a: unknown[]) => signedRequestWithMethod(...a), signedGet: vi.fn() }));

import { shareableOutside } from '../../components/SharePost';
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
