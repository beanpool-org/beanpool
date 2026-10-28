/**
 * A post shared outside its community opens the peek screen (front doors S6): the link a member shares,
 * `https://<community>/?post=<id>&peek=<ticket>`, which the app claims on every *.beanpool.org host, and
 * `beanpool://peek?node=…&post=…&peek=…`, the node's share page's "Open in the BeanPool app". The router is the real
 * app/+native-intent.ts; the guards are the real utils/auth-return.ts and the invite reader's input; the install referrer
 * is the real utils/install-referrer.ts.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' }, DeviceEventEmitter: { emit: vi.fn() } }));
vi.mock('expo-web-browser', () => ({ dismissBrowser: vi.fn(async () => undefined), maybeCompleteAuthSession: vi.fn() }));

import { redirectSystemPath } from '../../app/+native-intent';
import { isPeekPath, peekRoute, peekRouteFromSystemPath, readPeekParams, PEEK_ROUTE } from '../peek-link';
import { setupRedirect } from '../auth-return';
import { readInstallReferrer } from '../install-referrer';

const T = 'AbCdEfGhIjKlMnOpQrSt_-';
const POST = '3f0c8a8e-1b2c-4d5e-8f90-123456789abc';
const route = (origin: string) => `${PEEK_ROUTE}?node=${encodeURIComponent(origin)}&post=${POST}&peek=${T}`;

describe('a link shared outside the community', () => {
    it('opens the peek screen on that community\'s post, cold or warm, either order of its query', () => {
        for (const initial of [true, false]) {
            expect(redirectSystemPath({ path: `https://castlemaine.beanpool.org/?post=${POST}&peek=${T}`, initial })).toBe(route('https://castlemaine.beanpool.org'));
            expect(redirectSystemPath({ path: `https://Castlemaine.BeanPool.org/?peek=${T}&post=${POST}`, initial })).toBe(route('https://castlemaine.beanpool.org'));
        }
    });

    it('opens from the share page\'s "Open in the BeanPool app", a self-hosted community included', () => {
        const app = `beanpool://peek?node=${encodeURIComponent('https://commons.example.net')}&post=${POST}&peek=${T}`;
        expect(redirectSystemPath({ path: app, initial: false })).toBe(route('https://commons.example.net'));
        expect(peekRouteFromSystemPath(app)).toBe(peekRoute('https://commons.example.net', POST, T));
    });

    it('never for the website, the global community, http, a login, a private address or a path', () => {
        for (const origin of ['https://beanpool.org', 'https://www.beanpool.org', 'https://global.beanpool.org', 'http://castlemaine.beanpool.org',
            'https://user@castlemaine.beanpool.org', 'https://10.0.0.5', 'https://localhost']) {
            expect(peekRouteFromSystemPath(`${origin}/?post=${POST}&peek=${T}`)).toBeNull();
            expect(peekRouteFromSystemPath(`beanpool://peek?node=${encodeURIComponent(origin)}&post=${POST}&peek=${T}`)).toBeNull();
        }
        expect(peekRouteFromSystemPath(`https://castlemaine.beanpool.org/settings?post=${POST}&peek=${T}`)).toBeNull();
    });

    it('a malformed ticket, or two nodes, is no peek: the https link falls back to the shared post as before', () => {
        expect(peekRouteFromSystemPath(`https://castlemaine.beanpool.org/?post=${POST}&peek=short`)).toBeNull();
        expect(redirectSystemPath({ path: `https://castlemaine.beanpool.org/?post=${POST}&peek=short`, initial: false })).toBe(`/post/${POST}`);
        const two = `beanpool://peek?node=${encodeURIComponent('https://a.example.org')}&node=${encodeURIComponent('https://b.example.org')}&post=${POST}&peek=${T}`;
        expect(peekRouteFromSystemPath(two)).toBeNull();
        // A beanpool://peek that names nothing this phone may read opens as from the icon (cold) or stays (warm).
        expect(redirectSystemPath({ path: two, initial: true })).toBe('/');
        expect(redirectSystemPath({ path: two, initial: false })).toBeNull();
    });

    it('is no invite, and a shared post without a ticket is not a peek', () => {
        expect(isPeekPath(`https://castlemaine.beanpool.org/?post=${POST}&peek=${T}`)).toBe(true);
        expect(isPeekPath(`beanpool://peek?node=x`)).toBe(true);
        expect(isPeekPath(`https://castlemaine.beanpool.org/?post=${POST}`)).toBe(false);
        expect(isPeekPath('https://castlemaine.beanpool.org/?invite=BP-AAAA-BBBB')).toBe(false);
    });

    it('the screen checks its own params again: a route can be pushed with anything', () => {
        expect(readPeekParams({ node: 'https://castlemaine.beanpool.org', post: POST, peek: T })).toEqual({ origin: 'https://castlemaine.beanpool.org', postId: POST, ticket: T });
        expect(readPeekParams({ node: 'https://global.beanpool.org', post: POST, peek: T })).toBeNull();
        expect(readPeekParams({ node: 'https://castlemaine.beanpool.org', post: 'a/b', peek: T })).toBeNull();
        expect(readPeekParams({ node: 'https://castlemaine.beanpool.org', post: POST, peek: [T, T] })).toBeNull();
    });

    it('the peek screen stays for a phone with no account: a stranger is who it is for', () => {
        expect(setupRedirect(['peek'], { hasIdentity: false, pendingOnboarding: false })).toBeNull();
        expect(setupRedirect(['shared-outside'], { hasIdentity: false, pendingOnboarding: false })).toBe('/welcome');
    });
});

describe('Get the app on the share page: the install referrer carries the peek', () => {
    it('opens the peek after the install', () => {
        expect(readInstallReferrer(`peek=${T}&post=${POST}&server=https://castlemaine.beanpool.org`))
            .toEqual({ kind: 'peek', origin: 'https://castlemaine.beanpool.org', postId: POST, ticket: T });
    });

    it('an invite wins over a peek, a peek over global=1, and a bad peek is none', () => {
        expect(readInstallReferrer(`invite=BP-AAAA&peek=${T}&post=${POST}&server=https://castlemaine.beanpool.org`)?.kind).toBe('invite');
        expect(readInstallReferrer(`global=1&peek=${T}&post=${POST}&server=https://castlemaine.beanpool.org`)?.kind).toBe('peek');
        expect(readInstallReferrer(`peek=${T}&post=${POST}&server=http://castlemaine.beanpool.org`)).toBeNull();
        expect(readInstallReferrer(`peek=short&post=${POST}&server=https://castlemaine.beanpool.org`)).toBeNull();
        expect(readInstallReferrer(`peek=${T}&post=${POST}&server=https://global.beanpool.org&global=1`)).toEqual({ kind: 'global' });
    });
});
