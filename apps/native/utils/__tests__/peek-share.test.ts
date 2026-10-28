/**
 * Share outside the community, on the phone (front doors S6): which posts offer it (components/SharePost.tsx
 * shareableOutside, the node's engine/peek-tickets.ts visitorsPost in the end). The real modules; the signed
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
