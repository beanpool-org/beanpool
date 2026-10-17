/**
 * Google Play's install referrer on the first screen (utils/install-referrer.ts, app/welcome.tsx; DESIGN-global-entry-fable.md
 * §A row 5, slice P4). The website's global link sends a phone without the app to Google Play with `referrer=global%3D1`
 * (apps/website/global.html); the invite trampoline sends `invite=…&server=…`. The app reads it once ever, on its first
 * start: an invite fills the join form, `global=1` opens the global community's door, and an invite in the same referrer
 * wins. Before P4 `global=1` was read and dropped: the member landed on the first screen with no door open.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));

import { INSTALL_REFERRER_CHECKED_KEY, readInstallReferrer, takeInstallReferrer, type InstallReferrerDeps } from '../install-referrer';

const MULLUM = 'https://mullum.beanpool.org';

/** What Google hands the app: the store link's `referrer` value, URL-decoded once. */
function fromStoreLink(storeLink: string): string {
    return new URL(storeLink).searchParams.get('referrer') ?? '';
}

describe('readInstallReferrer: what the referrer asks for', () => {
    it('the website\'s global link: global=1 opens the door (the link exactly as apps/website/global.html writes it)', () => {
        const html = readFileSync(resolve(__dirname, '../../../website/global.html'), 'utf8');
        const play = /id="play" href="([^"]+)"/.exec(html)![1].replace(/&amp;/g, '&');
        expect(fromStoreLink(play)).toBe('global=1');
        expect(readInstallReferrer(fromStoreLink(play))).toEqual({ kind: 'global' });
    });

    it('an invite (the trampoline\'s, its values encoded once more): the code and the server', () => {
        const referrer = `invite=${encodeURIComponent('INV-ABCD-EFGH')}&server=${encodeURIComponent(MULLUM)}`;
        expect(readInstallReferrer(referrer)).toEqual({ kind: 'invite', invite: 'INV-ABCD-EFGH', server: MULLUM });
    });

    it('an invite beats global=1 in the same referrer, in either order', () => {
        const invite = `invite=INV-ABCD-EFGH&server=${encodeURIComponent(MULLUM)}`;
        expect(readInstallReferrer(`global=1&${invite}`)).toEqual({ kind: 'invite', invite: 'INV-ABCD-EFGH', server: MULLUM });
        expect(readInstallReferrer(`${invite}&global=1`)).toEqual({ kind: 'invite', invite: 'INV-ABCD-EFGH', server: MULLUM });
    });

    it('an invite\'s server only when it is safe (never cleartext to a public host): the invite is still used without it', () => {
        expect(readInstallReferrer(`invite=INV-ABCD-EFGH&server=${encodeURIComponent('http://8.8.8.8')}`))
            .toEqual({ kind: 'invite', invite: 'INV-ABCD-EFGH', server: null });
        expect(readInstallReferrer('invite=INV-ABCD-EFGH')).toEqual({ kind: 'invite', invite: 'INV-ABCD-EFGH', server: null });
    });

    it('nothing else opens anything: Google\'s own referrer, a global that isn\'t 1, an empty or unreadable invite', () => {
        for (const other of [
            'utm_source=google-play&utm_medium=organic', 'global=0', 'global=10', 'global=1x', 'xglobal=1', 'global', 'invite=',
            'invite=%E0%A4%A', '', undefined, null, 42,
        ]) {
            expect(readInstallReferrer(other), String(other)).toBeNull();
        }
        // An unreadable invite with global=1 beside it: the global door, not nothing.
        expect(readInstallReferrer('invite=%E0%A4%A&global=1')).toEqual({ kind: 'global' });
    });
});

describe('takeInstallReferrer: read once ever', () => {
    function phone(referrer: string | (() => never), os = 'android') {
        const store = new Map<string, string>();
        const getReferrer = vi.fn(async () => (typeof referrer === 'function' ? referrer() : referrer));
        const deps: InstallReferrerDeps = {
            os,
            storage: { getItem: async (k) => store.get(k) ?? null, setItem: async (k, v) => { store.set(k, v); } },
            getReferrer,
        };
        return { deps, store, getReferrer };
    }

    it('the first start acts on it and marks it read; every later start never asks again', async () => {
        const p = phone('global=1');
        expect(await takeInstallReferrer(p.deps)).toEqual({ kind: 'global' });
        expect(p.store.get(INSTALL_REFERRER_CHECKED_KEY)).toBe('true');
        expect(await takeInstallReferrer(p.deps)).toBeNull();
        expect(await takeInstallReferrer(p.deps)).toBeNull();
        expect(p.getReferrer).toHaveBeenCalledTimes(1);
    });

    it('a referrer with nothing in it is still read once: it never opens a door later', async () => {
        const p = phone('utm_source=google-play');
        expect(await takeInstallReferrer(p.deps)).toBeNull();
        expect(p.store.get(INSTALL_REFERRER_CHECKED_KEY)).toBe('true');
    });

    it('a phone that already read it before this app (the same key as before P4) never reads it again', async () => {
        const p = phone('global=1');
        p.store.set('beanpool_install_referrer_checked', 'true');
        expect(await takeInstallReferrer(p.deps)).toBeNull();
        expect(p.getReferrer).not.toHaveBeenCalled();
    });

    it('no Play Services (an emulator, a de-Googled phone): nothing, and left unmarked to try again next visit', async () => {
        const p = phone(() => { throw new Error('Play Store not available'); });
        expect(await takeInstallReferrer(p.deps)).toBeNull();
        expect(p.store.has(INSTALL_REFERRER_CHECKED_KEY)).toBe(false);
    });

    it('iOS has no install referrer: nothing is asked', async () => {
        const p = phone('global=1', 'ios');
        expect(await takeInstallReferrer(p.deps)).toBeNull();
        expect(p.getReferrer).not.toHaveBeenCalled();
    });
});
