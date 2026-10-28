/**
 * Look before you join (utils/look-around.ts, slice S12): which screens a phone with no account may stay on, which nodes
 * give it a look, and when the root guard reads the phone as looking around. Every dependency is injected: no storage, no
 * network.
 */
import { describe, expect, it } from 'vitest';
import { LOOK_DOOR, LOOK_LANDING, forgetTheLook, isLookRoute, lookingAroundHere, showsVisitorsView, type LookingDeps } from '../look-around';

const GLOBAL = 'https://global.beanpool.org';
const VISITORS = { profile: 'global', features: { guestListingsOnly: true, openJoin: true } } as const;

function deps(over: Partial<{ anchor: string | null; guests: string[]; profile: unknown; throws: boolean }> = {}): LookingDeps {
    const { anchor = GLOBAL, guests = [GLOBAL], profile = VISITORS, throws = false } = over;
    return {
        anchor: async () => { if (throws) throw new Error('storage'); return anchor; },
        isGuestNode: async (url) => guests.includes(url),
        cachedProfile: async () => profile as never,
    };
}

describe('the look', () => {
    it('is Home, the Market, the Map (and the example Ledger and Commons), a listing, the guide, the BeanPool sheet and Start a community', () => {
        for (const s of [['(tabs)'], ['(tabs)', 'index'], ['(tabs)', 'market'], ['(tabs)', 'map'], ['(tabs)', 'ledger'], ['(tabs)', 'projects'],
            ['post', '[id]'], ['guide', '[slug]'], ['beanpool'], ['start-community']]) {
            expect(isLookRoute(s), s.join('/')).toBe(true);
        }
    });

    it('is never Talk, People, Pulse, Settings, a chat, a profile or the bare root', () => {
        for (const s of [['(tabs)', 'chats'], ['(tabs)', 'people'], ['(tabs)', 'pulse'], ['(tabs)', 'settings'], ['chat', '[id]'],
            ['new-message'], ['profile-setup'], ['public-profile'], ['find-community'], ['shop', '[id]'], []]) {
            expect(isLookRoute(s), s.join('/') || '(empty)').toBe(false);
        }
    });

    it('lands on the Market, and its door is welcome\'s door opened from the look', () => {
        expect(LOOK_LANDING).toBe('/(tabs)/market');
        expect(LOOK_DOOR).toEqual({ pathname: '/welcome', params: { join: 'look' } });
    });
});

describe('showsVisitorsView', () => {
    it('only the global community\'s profile with the visitors\' view on and no private preview', () => {
        expect(showsVisitorsView(VISITORS as never)).toBe(true);
        expect(showsVisitorsView({ profile: 'global', features: { guestListingsOnly: false } } as never)).toBe(false);
        expect(showsVisitorsView({ profile: 'global', features: {} } as never)).toBe(false);
        expect(showsVisitorsView({ profile: 'global', features: { guestListingsOnly: true, privatePreview: true } } as never)).toBe(false);
        // A local community never gives a visitor with no key a look: its listings are its members'.
        expect(showsVisitorsView({ profile: 'local', features: { guestListingsOnly: true } } as never)).toBe(false);
        expect(showsVisitorsView(null)).toBe(false);
    });
});

describe('lookingAroundHere', () => {
    it('the community in use is a chosen guest visit of a node that shows visitors its view: looking around', async () => {
        expect(await lookingAroundHere(deps())).toBe(true);
    });

    it('anything else is not: no community, not a chosen visit, a node without the visitors\' view, no copy of its profile, storage failing', async () => {
        expect(await lookingAroundHere(deps({ anchor: null }))).toBe(false);
        expect(await lookingAroundHere(deps({ guests: [] }))).toBe(false);
        expect(await lookingAroundHere(deps({ profile: { profile: 'global', features: {} } }))).toBe(false);
        expect(await lookingAroundHere(deps({ profile: null }))).toBe(false);
        expect(await lookingAroundHere(deps({ throws: true }))).toBe(false);
    });
});

describe('forgetTheLook (an account arriving on a phone that held none: a restore, a re-key code)', () => {
    const marks = (key: unknown) => {
        const done: string[] = [];
        return {
            done,
            deps: {
                storedKey: async () => { if (key instanceof Error) throw key; return key; },
                clearGuestNodes: async () => { done.push('cleared'); },
            },
        };
    };

    it('no key on the phone: the look\'s guest marks go', async () => {
        const { done, deps } = marks(null);
        await forgetTheLook(deps);
        expect(done).toEqual(['cleared']);
    });

    it('a key on the phone, or one it can\'t read: its marks are its own, and stay', async () => {
        for (const key of [{ publicKey: 'a'.repeat(64) }, new Error('unreadable')]) {
            const { done, deps } = marks(key);
            await forgetTheLook(deps);
            expect(done).toEqual([]);
        }
    });

    it('never throws, whatever storage does', async () => {
        await expect(forgetTheLook({ storedKey: async () => null, clearGuestNodes: async () => { throw new Error('disk'); } })).resolves.toBeUndefined();
    });
});
