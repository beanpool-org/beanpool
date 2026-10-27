/**
 * A community's bare address opens its public card in the app, member or not (front doors S15): `https://<community>/`,
 * which the app claims on every *.beanpool.org host, and `beanpool://community-card?node=…`, the card's own Ask to join on
 * an Android phone's browser. Before, the bare address opened the member's own Home whichever community it named.
 * The router is the real app/+native-intent.ts; the guards are the real utils/auth-return.ts and invite reader's input.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' }, DeviceEventEmitter: { emit: vi.fn() } }));
vi.mock('expo-web-browser', () => ({ dismissBrowser: vi.fn(async () => undefined), maybeCompleteAuthSession: vi.fn() }));

import { redirectSystemPath } from '../../app/+native-intent';
import { cardRouteFromSystemPath, isCommunityCardPath, COMMUNITY_CARD_ROUTE } from '../community-card-link';
import { setupRedirect } from '../auth-return';
import { extractInviteToken } from '../invite-parser';

const card = (origin: string) => `${COMMUNITY_CARD_ROUTE}?node=${encodeURIComponent(origin)}`;

describe("a community's bare address", () => {
    it('opens that community\'s card, cold or warm', () => {
        for (const initial of [true, false]) {
            expect(redirectSystemPath({ path: 'https://castlemaine.beanpool.org/', initial })).toBe(card('https://castlemaine.beanpool.org'));
            expect(redirectSystemPath({ path: 'https://Castlemaine.BeanPool.org', initial })).toBe(card('https://castlemaine.beanpool.org'));
            expect(redirectSystemPath({ path: 'https://castlemaine.beanpool.org/?lang=es', initial })).toBe(card('https://castlemaine.beanpool.org'));
        }
    });

    it('a root that carries something else keeps its own landing: a shared post, an invite', () => {
        expect(redirectSystemPath({ path: 'https://castlemaine.beanpool.org/?post=p1', initial: false })).toBe('/post/p1');
        expect(isCommunityCardPath('https://castlemaine.beanpool.org/?invite=BP-AAAA-BBBB')).toBe(false);
        expect(isCommunityCardPath('https://castlemaine.beanpool.org/settings')).toBe(false);
        expect(isCommunityCardPath('https://castlemaine.beanpool.org/#x')).toBe(false);
    });

    it('never the website, the global community, http, a login or a private address', () => {
        for (const path of ['https://beanpool.org/', 'https://www.beanpool.org/', 'https://global.beanpool.org/', 'http://castlemaine.beanpool.org/',
            'https://user@castlemaine.beanpool.org/', 'https://10.0.0.5/', 'https://localhost/']) {
            expect(cardRouteFromSystemPath(path)).toBeNull();
        }
        // The global community's bare address goes on as before (its own door is /global).
        expect(redirectSystemPath({ path: 'https://global.beanpool.org/', initial: false })).toBe('https://global.beanpool.org/');
    });
});

describe('beanpool://community-card?node=…', () => {
    it('opens the card for the community it names, in the spellings a system hands over', () => {
        const node = encodeURIComponent('https://castlemaine.beanpool.org');
        for (const path of [`beanpool://community-card?node=${node}`, `beanpool:///community-card?node=${node}`, `/community-card?node=${node}`, `community-card/?node=${node}`]) {
            expect(redirectSystemPath({ path, initial: false })).toBe(card('https://castlemaine.beanpool.org'));
        }
    });

    it('one that names no community the phone may read opens nothing new: home cold, stay warm', () => {
        for (const bad of ['', 'node=http%3A%2F%2Fx.example', `node=${encodeURIComponent('https://global.beanpool.org')}`, `node=${encodeURIComponent('https://10.0.0.5')}`, `node=${encodeURIComponent('https://user@x.example')}`]) {
            expect(redirectSystemPath({ path: `beanpool://community-card?${bad}`, initial: true })).toBe('/');
            expect(redirectSystemPath({ path: `beanpool://community-card?${bad}`, initial: false })).toBeNull();
        }
    });

    it("is no invite: the invite reader would read the route's name as one, so the root layout skips it", () => {
        const link = `beanpool://community-card?node=${encodeURIComponent('https://castlemaine.beanpool.org')}`;
        expect(extractInviteToken(link)).toBe('community-card');
        expect(isCommunityCardPath(link)).toBe(true);
        expect(isCommunityCardPath('https://castlemaine.beanpool.org/')).toBe(true);
    });
});

describe('the card with no account on the phone', () => {
    it('stays: a stranger is who it is for (the guard sends every other screen to welcome)', () => {
        expect(setupRedirect(['community-card'], { hasIdentity: false, pendingOnboarding: false })).toBeNull();
        expect(setupRedirect(['find-community'], { hasIdentity: false, pendingOnboarding: false })).toBe('/welcome');
    });
});
