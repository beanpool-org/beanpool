/**
 * A place circle on the phone (Lounge L2, §3.3): the card's rows at 320 dp with the text at 1.3×, in both themes; its words
 * fit by the same model as home-layout-320.test.ts (nothing draws a frame); a count below 3 is never said; a node's answer
 * reads to the floor; and "Join when it starts" sends exactly one knock, from this phone, to the community.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (k: string) => store.get(k) ?? null,
        setItem: async (k: string, v: string) => { store.set(k, v); },
        removeItem: async (k: string) => { store.delete(k); },
    },
}));
vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
    View: 'View', Text: 'Text', Pressable: 'Pressable', Modal: 'Modal', ScrollView: 'ScrollView', Switch: 'Switch',
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: 'Icon' }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
const sendKnock = vi.fn();
const rememberKnock = vi.fn(async () => {});
vi.mock('../knock', () => ({ sendKnock: (...a: unknown[]) => sendKnock(...a), rememberKnock: (...a: unknown[]) => (rememberKnock as any)(...a) }));
vi.mock('../crypto', () => ({ buildSignedHeaders: async () => ({}) }));
vi.mock('../node-post', () => ({ signedPost: async () => new Response('{}'), signedDelete: async () => new Response('{}') }));

import { lightColors, darkColors } from '../../constants/colors';
import { homeStyles } from '../../components/home/HomeParts';
import { PLACE_CIRCLE_WORDS, circleDemandLine, circlePeopleLine, circleStartedLine, circleWaitingLine, groupDescriptionShown, groupNameShown, t } from '@beanpool/core';
import { circleIntents, knockForCircle, setCircleIntent } from '../circle-intent';
import { readCircleCard, readGlobalHome } from '../community-directory';

const SCREEN = 320;
const FONT_SCALE = 1.3;
const num = (v: unknown) => (typeof v === 'number' ? v : 0);
const widest = (text: string, fontSize: number) => Math.max(...text.split(/\s+/).map(w => [...w].length * 0.62 * fontSize * FONT_SCALE));

describe.each([['light', lightColors], ['dark', darkColors]])('the card in the %s theme at 320 dp × 1.3', (_name, colors) => {
    const s = homeStyles(colors as typeof lightColors) as unknown as Record<string, Record<string, unknown>>;
    const inner = SCREEN - 2 * num(s.card.marginHorizontal) - 2 * num(s.card.paddingHorizontal) - 2 * num(s.card.borderWidth);

    it('no word of a row is wider than the card, so every line wraps', () => {
        const rows = [
            t(PLACE_CIRCLE_WORDS.knockLater), t(PLACE_CIRCLE_WORDS.knockRefused), t(PLACE_CIRCLE_WORDS.closed),
            t(PLACE_CIRCLE_WORDS.help), t(PLACE_CIRCLE_WORDS.starting), t(PLACE_CIRCLE_WORDS.notStarting), t(PLACE_CIRCLE_WORDS.joinWhenStarts), t(PLACE_CIRCLE_WORDS.joinWhenStartsOn),
            t(PLACE_CIRCLE_WORDS.someoneStarting), t(PLACE_CIRCLE_WORDS.done), t(PLACE_CIRCLE_WORDS.helpDone), circleDemandLine({ waiting: 12, helping: 12 })!, circleWaitingLine({ waiting: 12, helping: null })!, circlePeopleLine(12)!,
        ];
        for (const row of rows) expect(widest(row, 16)).toBeLessThan(inner);
    });

    it('a button is a 48 dp target that wraps its row of buttons, and text and fill differ in this theme', () => {
        expect(num(s.button.minHeight)).toBeGreaterThanOrEqual(48);
        expect(s.buttonRow.flexWrap).toBe('wrap');
        expect((s.rowLine as { color?: string }).color).toBeTruthy();
        expect((s.rowLine as { color?: string }).color).not.toBe((s.card as { backgroundColor?: string }).backgroundColor);
    });
});

describe('what may be said', () => {
    it('no count below 3, in any line', () => {
        for (const n of [0, 1, 2]) {
            expect(circlePeopleLine(n)).toBeNull();
            expect(circleDemandLine({ waiting: n, helping: n })).toBeNull();
            expect(circleWaitingLine({ waiting: n, helping: n })).toBeNull();
        }
    });

    it('a node that sends a count below 3 is read as none', () => {
        const home = readGlobalHome({ communities: [], demand: { waiting: 2, helping: 1 }, circle: { id: 'c1', people: 2, starting: null, doneAt: null, community: null } });
        expect(home?.demand).toEqual({ waiting: null, helping: null });
        expect(home?.circle?.people).toBeNull();
    });

    it('those who would help lead, then those waiting', () => {
        expect(circleDemandLine({ waiting: 9, helping: 4 })).toBe('4 people near you would help start a community.');
        expect(circleDemandLine({ waiting: 9, helping: null })).toBe('9 people near you are waiting for a community too.');
    });

    it("a circle reads in the member's language by its kind; any other group as its members wrote it", () => {
        expect(groupNameShown({ name: 'Anything stored', kind: 'circle' })).toBe(t(PLACE_CIRCLE_WORDS.name));
        expect(groupNameShown({ name: 'Our garden' })).toBe('Our garden');
        expect(groupDescriptionShown({ description: 'stored', kind: 'circle' })).toBe(t(PLACE_CIRCLE_WORDS.purpose));
    });

    it('a retired circle with its community gone from the directory still reads honestly', () => {
        expect(circleStartedLine(null)).toBe('A community has started near you.');
        expect(circleStartedLine(readCircleCard({ community: { key: 'k', name: 'Thrissur Commons' } })?.community)).toBe('A community has started near you: Thrissur Commons.');
    });
});

describe('the knock when a community starts', () => {
    const me = { publicKey: 'a'.repeat(64), privateKey: '00', callsign: 'Ana' } as never;
    const retired = { id: 'c1', people: 3, starting: null, doneAt: '2026-11-01T00:00:00.000Z', community: { key: 'k', name: 'Thrissur Commons', url: 'https://thrissur.beanpool.org', acceptingKnocks: true } };
    beforeEach(() => { store.clear(); sendKnock.mockReset(); rememberKnock.mockClear(); });
    afterEach(() => { store.clear(); });

    it('goes once, however often Home is read, and two reads at once send one', async () => {
        sendKnock.mockResolvedValue({ kind: 'waiting', message: '' });
        await setCircleIntent('a'.repeat(64), 'c1', true);
        const both = await Promise.all([knockForCircle(me, retired), knockForCircle(me, retired)]);
        expect(both.filter(r => r.sent).length).toBe(1);
        expect(await knockForCircle(me, retired)).toEqual({ sent: false, trouble: null });
        expect(sendKnock).toHaveBeenCalledTimes(1);
        expect(sendKnock.mock.calls[0][0]).toBe('https://thrissur.beanpool.org');
        expect(rememberKnock).toHaveBeenCalledTimes(1);
    });

    it('goes for nobody who did not ask, nor to a community that takes no requests', async () => {
        expect(await knockForCircle(me, retired)).toEqual({ sent: false, trouble: null });
        await setCircleIntent('a'.repeat(64), 'c1', true);
        expect(await knockForCircle(me, { ...retired, community: { ...retired.community, acceptingKnocks: false } })).toEqual({ sent: false, trouble: null });
        expect(sendKnock).not.toHaveBeenCalled();
        expect(await circleIntents('a'.repeat(64))).toEqual(['c1']);
    });

    it('is kept for the next read when the community could not be reached', async () => {
        sendKnock.mockResolvedValue({ kind: 'unreachable', message: '' });
        await setCircleIntent('a'.repeat(64), 'c1', true);
        expect(await knockForCircle(me, retired)).toEqual({ sent: false, trouble: 'later' });
        expect(await circleIntents('a'.repeat(64))).toEqual(['c1']);
    });

    it.each([502, 503, 429])('a %i says nothing about this person: the wish is kept, and the next read sends it', async status => {
        sendKnock.mockResolvedValueOnce({ kind: 'refused', status, code: null, message: '' }).mockResolvedValue({ kind: 'waiting', message: '' });
        await setCircleIntent('a'.repeat(64), 'c1', true);
        expect(await knockForCircle(me, retired)).toEqual({ sent: false, trouble: 'later' });
        expect(await circleIntents('a'.repeat(64))).toEqual(['c1']);
        expect(await knockForCircle(me, retired)).toEqual({ sent: true, trouble: null });
        expect(await circleIntents('a'.repeat(64))).toEqual([]);
    });

    it('a refusal ends the wish, sends nothing more, and every later read still says so', async () => {
        sendKnock.mockResolvedValue({ kind: 'refused', status: 403, code: 'account_closed', message: '' });
        await setCircleIntent('a'.repeat(64), 'c1', true);
        expect(await knockForCircle(me, retired)).toEqual({ sent: false, trouble: 'refused' });
        expect(await circleIntents('a'.repeat(64))).toEqual([]);
        expect(await knockForCircle(me, retired)).toEqual({ sent: false, trouble: 'refused' });
        expect(sendKnock).toHaveBeenCalledTimes(1);
    });
});

describe('where the card is drawn', () => {
    const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf-8');

    it('Home and the group sheet draw the one card, and the permission is asked only at the tap', () => {
        const find = read('components/home/FindCommunityBody.tsx');
        expect(find).toContain('<PlaceCircleCard');
        expect(read('components/GroupDetailModal.tsx')).toContain('<PlaceCircleCard');
        // "I'd help" goes where "Tell me" goes: with no place known, to the find screen, which asks at its own tap.
        expect(find).not.toMatch(/requestForegroundPermissionsAsync/);
    });

    it('the group sheet closes before Start a community opens: a Modal stays above any screen pushed under it', () => {
        expect(read('components/GroupDetailModal.tsx')).toMatch(/<PlaceCircleCard[^>]*onLeave=\{onClose\}/);
    });
});
