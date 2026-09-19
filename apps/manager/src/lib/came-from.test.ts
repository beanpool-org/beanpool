import { describe, it, expect, vi } from 'vitest';
import { readCameFrom, backLink, profileLink, APP_RETURN_URL } from './came-from';
import { startKeySession } from './key-session';

function memoryStorage() {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } as unknown as Storage;
}
const throwingStorage = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('SecurityError'); },
} as unknown as Storage;

function win(hash: string, sessionStorage: Storage) {
    return { location: { hash } as Location, sessionStorage };
}

const KEY = 'ab'.repeat(32);

describe('where the member came from', () => {
    it('reads from=app / from=pwa from the fragment, and keeps it for a reload in the same visit', () => {
        const store = memoryStorage();
        expect(readCameFrom(win(`#handoff=${'a'.repeat(64)}&section=disputes&from=app`, store))).toBe('app');
        expect(readCameFrom(win('', store))).toBe('app'); // the reload: fragment gone, sessionStorage remembers

        const other = memoryStorage();
        expect(readCameFrom(win('#from=pwa', other))).toBe('pwa');
        expect(readCameFrom(win('', other))).toBe('pwa');
    });

    it('is "unknown" with no fragment and nothing stored, or anything else in `from`', () => {
        expect(readCameFrom(win('', memoryStorage()))).toBe('unknown');
        expect(readCameFrom(win('#from=evil', memoryStorage()))).toBe('unknown');
        expect(readCameFrom(win('#from=APP', memoryStorage()))).toBe('unknown');
    });

    it('falls back to "unknown" when sessionStorage fails and the fragment is gone', () => {
        expect(readCameFrom(win('', throwingStorage))).toBe('unknown');
    });

    it('still uses a fragment it can read when sessionStorage fails to save it', () => {
        expect(readCameFrom(win('#from=app', throwingStorage))).toBe('app');
    });
});

describe('the way back, labelled by origin', () => {
    it('from the app: back to the app through its own no-op route', () => {
        expect(backLink('app')).toMatchObject({ label: 'Back to the BeanPool app', href: 'beanpool://foreground' });
        expect(APP_RETURN_URL).toBe('beanpool://foreground');
    });
    it('from the web app: back to the web app on this node', () => {
        expect(backLink('pwa')).toMatchObject({ label: 'Back to BeanPool', href: '/app' });
    });
    it('from nowhere known: offers the web app, without claiming to go "back"', () => {
        expect(backLink('unknown')).toMatchObject({ label: 'Open the BeanPool web app', href: '/app' });
        expect(backLink('unknown').label).not.toMatch(/back/i);
    });
});

describe('View my profile', () => {
    it('opens the member in the same destination', () => {
        expect(profileLink('app', KEY)).toMatchObject({ label: 'View my profile', href: `beanpool://public-profile?publicKey=${KEY}` });
        expect(profileLink('pwa', KEY)?.href).toBe(`/app#profile=${KEY}`);
    });
    it('is hidden when the origin is unknown: an older app build, whose member has no web identity', () => {
        expect(profileLink('unknown', KEY)).toBeNull();
    });
    it('is hidden under password sign-in (no member), and for anything that is not a public key', () => {
        expect(profileLink('app', null)).toBeNull();
        expect(profileLink('pwa', undefined)).toBeNull();
        expect(profileLink('app', 'x&evil=1')).toBeNull();
    });
});

describe('the fragment leaves the address bar with the hand-off token', () => {
    it.each([
        ['#from=pwa'],
        [`#handoff=${'a'.repeat(64)}&from=app`],
        [`#handoff=${'a'.repeat(64)}&section=moderation&from=app`],
    ])('%s is stripped', async (hash) => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }) as Response));
        const replaceState = vi.fn();
        await startKeySession({ location: { hash, pathname: '/settings', search: '' } as Location, history: { replaceState } as unknown as History });
        expect(replaceState).toHaveBeenCalledWith(null, '', '/settings');
        vi.unstubAllGlobals();
    });
});
