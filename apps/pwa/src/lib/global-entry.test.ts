/**
 * The global community from the web app (lib/global-entry.ts, DESIGN-global-entry-fable.md §B.3, §D, slice W1): which
 * browser is a phone's, where the app's link may be offered and in what order, the "on your phone later" lines, and the
 * Settings link to the global community the node names. Pure: no node is asked.
 */
import { describe, expect, it } from 'vitest';
import {
    APP_GLOBAL_HOST, APP_GLOBAL_LINK, PHONE_BROWSER_QUERY, globalCommunityLink, isAppsGlobal, isPhoneBrowser, lobbyJoinWays,
    phoneLaterLines,
} from './global-entry';

/** A browser whose matchMedia answers `matches` for the phone query (and records what it was asked). */
function browser(answer: (query: string) => boolean) {
    const asked: string[] = [];
    return {
        asked,
        win: { matchMedia: (query: string) => { asked.push(query); return { matches: answer(query), media: query } as MediaQueryList; } },
    };
}

describe('isPhoneBrowser: a touch screen as the main pointer, narrower than the sidebar', () => {
    it('asks for a coarse pointer and a width under 768 px in one query', () => {
        expect(PHONE_BROWSER_QUERY).toBe('(pointer: coarse) and (max-width: 767px)');
        const b = browser(() => true);
        expect(isPhoneBrowser(b.win)).toBe(true);
        expect(b.asked).toEqual([PHONE_BROWSER_QUERY]);
    });

    it('a computer (or a tablet, or a phone at 768 px and wider) is not one', () => {
        expect(isPhoneBrowser(browser(() => false).win)).toBe(false);
    });

    it('a browser that cannot say is not one, so it keeps the browser join', () => {
        expect(isPhoneBrowser(undefined)).toBe(false);
        expect(isPhoneBrowser({})).toBe(false);
        expect(isPhoneBrowser({ matchMedia: () => { throw new Error('no media queries'); } })).toBe(false);
        expect(isPhoneBrowser({ matchMedia: () => undefined as unknown as MediaQueryList })).toBe(false);
    });
});

describe('isAppsGlobal: this page is the community the BeanPool app\'s link opens', () => {
    it('the link and its community are the app\'s own (apps/native GLOBAL_NODE_URL)', () => {
        expect(APP_GLOBAL_LINK).toBe('https://beanpool.org/global');
        expect(APP_GLOBAL_HOST).toBe('global.beanpool.org');
    });

    it('opened at global.beanpool.org, or at another name of a node that publishes it', () => {
        expect(isAppsGlobal(null, 'global.beanpool.org')).toBe(true);
        expect(isAppsGlobal({ addresses: ['global.beanpool.org'] }, 'localhost')).toBe(true);
        expect(isAppsGlobal({ addresses: [], primaryAddress: 'global.beanpool.org' }, '203.0.113.7')).toBe(true);
    });

    it("a self-hoster's global community, a local one, or a node that says nothing: no", () => {
        expect(isAppsGlobal({ addresses: ['global.example.org'], primaryAddress: 'global.example.org' }, 'global.example.org')).toBe(false);
        expect(isAppsGlobal({ addresses: ['mullum.beanpool.org'] }, 'mullum.beanpool.org')).toBe(false);
        expect(isAppsGlobal(undefined, null)).toBe(false);
        // A name that merely ends in ours is someone else's.
        expect(isAppsGlobal({ addresses: ['notglobal.beanpool.org.example.org'] }, 'xglobal.beanpool.org')).toBe(false);
    });
});

describe("lobbyJoinWays: the Join card's ways in, in order", () => {
    it('a phone at the app\'s global with its door open: the app, then the browser, then "Already have BeanPool?"', () => {
        expect(lobbyJoinWays({ phone: true, appsGlobal: true, doorOpen: true })).toEqual(['app', 'browser', 'have-account']);
    });

    it('anything else: the browser join, then "Already have BeanPool?", as before', () => {
        for (const phone of [true, false]) for (const appsGlobal of [true, false]) for (const doorOpen of [true, false]) {
            if (phone && appsGlobal && doorOpen) continue;
            expect(lobbyJoinWays({ phone, appsGlobal, doorOpen })).toEqual(['browser', 'have-account']);
        }
    });
});

describe('phoneLaterLines: how to put this same account on a phone (§D)', () => {
    it('Safety Backup at the app\'s global: Already a member, Global community, these 12 words', () => {
        expect(phoneLaterLines({ where: 'backup', appsGlobal: true, host: 'global.beanpool.org', signIns: null })).toEqual([
            'To use BeanPool on your phone later: install the app, tap **Already a member**, choose **Global community** and type these 12 words.',
        ]);
    });

    it('the sign-in line only when a sign-in brings the account back', () => {
        expect(phoneLaterLines({ where: 'backup', appsGlobal: true, host: 'global.beanpool.org', signIns: 'Google' })).toEqual([
            'To use BeanPool on your phone later: install the app, tap **Already a member**, choose **Global community** and type these 12 words.',
            'If you joined with Google, **Recover with Social** works too.',
        ]);
        expect(phoneLaterLines({ where: 'settings', appsGlobal: true, host: null, signIns: '' }).join(' ')).not.toMatch(/Recover with Social/);
    });

    it('Settings, where the words are not on screen: "your 12 words"', () => {
        expect(phoneLaterLines({ where: 'settings', appsGlobal: true, host: 'global.beanpool.org', signIns: 'Google and Apple' })).toEqual([
            'To use BeanPool on your phone later: install the app, tap **Already a member**, choose **Global community** and type your 12 words.',
            'If you joined with Google and Apple, **Recover with Social** works too.',
        ]);
    });

    it('any other community: its address, typed with the words; never "Global community", which would restore elsewhere', () => {
        const backup = phoneLaterLines({ where: 'backup', appsGlobal: false, host: 'mullum.beanpool.org', signIns: null });
        expect(backup).toEqual([
            "To use BeanPool on your phone later: install the app, tap **Already a member** and type these 12 words and this community's address, mullum.beanpool.org.",
        ]);
        expect(phoneLaterLines({ where: 'settings', appsGlobal: false, host: 'global.example.org', signIns: null })).toEqual([
            "To use BeanPool on your phone later: install the app, tap **Already a member** and type your 12 words and this community's address, global.example.org.",
        ]);
        expect(phoneLaterLines({ where: 'backup', appsGlobal: false, host: null, signIns: null })).toEqual([]);
    });

    it('a browser without its 12 words is never told to type them: the sign-in line alone, or nothing', () => {
        expect(phoneLaterLines({ where: 'settings', appsGlobal: true, host: 'global.beanpool.org', hasWords: false, signIns: 'Google' })).toEqual([
            'If you joined with Google, **Recover with Social** works too.',
        ]);
        expect(phoneLaterLines({ where: 'settings', appsGlobal: false, host: 'mullum.beanpool.org', hasWords: false, signIns: null })).toEqual([]);
    });

    it("never tells anyone to start again as new", () => {
        const all = [true, false].flatMap((appsGlobal) => (['backup', 'settings'] as const).flatMap((where) =>
            phoneLaterLines({ where, appsGlobal, host: 'mullum.beanpool.org', signIns: 'Google' })));
        expect(all.join(' ')).not.toMatch(/I'm new|new account/i);
    });
});

describe("globalCommunityLink: Settings' Global community row (§B.3)", () => {
    const local = { profile: 'local' as const, addresses: ['mullum.beanpool.org'] };

    it('on a local community, the global community its node names, by host', () => {
        expect(globalCommunityLink({ ...local, globalCommunityUrl: 'https://global.beanpool.org' }, 'mullum.beanpool.org'))
            .toEqual({ href: 'https://global.beanpool.org/', host: 'global.beanpool.org' });
        // A self-hoster's own global community: theirs, never ours.
        expect(globalCommunityLink({ ...local, globalCommunityUrl: 'https://Global.Example.org/welcome?x=1' }, 'mullum.beanpool.org'))
            .toEqual({ href: 'https://global.example.org/', host: 'global.example.org' });
        // A node older than the field is a local one too.
        expect(globalCommunityLink({ addresses: [], globalCommunityUrl: 'https://global.beanpool.org' }, '192.168.1.20'))
            .toEqual({ href: 'https://global.beanpool.org/', host: 'global.beanpool.org' });
    });

    it('none named (switched off, or a node from before the field): no row, never a guess at ours', () => {
        expect(globalCommunityLink(local, 'mullum.beanpool.org')).toBeNull();
        expect(globalCommunityLink(null, 'mullum.beanpool.org')).toBeNull();
        expect(globalCommunityLink(undefined, null)).toBeNull();
    });

    it('on a global community, which is it: no row', () => {
        expect(globalCommunityLink({ profile: 'global', addresses: ['global.example.org'], globalCommunityUrl: 'https://global.beanpool.org' }, 'global.example.org')).toBeNull();
    });

    it('a node that names itself, or anything but an https address: no row', () => {
        expect(globalCommunityLink({ ...local, globalCommunityUrl: 'https://mullum.beanpool.org' }, 'mullum.beanpool.org')).toBeNull();
        expect(globalCommunityLink({ ...local, globalCommunityUrl: 'https://mullum.beanpool.org' }, 'localhost')).toBeNull();
        for (const bad of ['http://global.example.org', 'javascript:alert(1)', 'global.example.org', 'https://user:pw@global.example.org', '', 42]) {
            expect(globalCommunityLink({ ...local, globalCommunityUrl: bad as string }, 'mullum.beanpool.org')).toBeNull();
        }
    });
});
