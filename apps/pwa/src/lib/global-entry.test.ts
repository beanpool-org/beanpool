/**
 * The global community from the web app (lib/global-entry.ts, DESIGN-global-entry-fable.md §B.3, §D, slice W1): which
 * browser is a phone's, where the app's link may be offered and in what order, the "on your phone later" lines, and the
 * Settings link to the global community the node names. Pure: no node is asked.
 */
import { describe, expect, it } from 'vitest';
import {
    APP_GLOBAL_HOST, APP_GLOBAL_LINK, IOS_GLOBAL_DOOR_FROM, IOS_OPEN_DOOR_FROM, PHONE_BROWSER_QUERY, globalCommunityLink, isAppsGlobal, isIOS, isPhoneBrowser,
    lobbyJoinWays, openDoorAppDoors, phoneLaterLines,
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

describe('isIOS: iPhone, iPad, iPod detection', () => {
    it('detects iPhone, iPad, iPod from user agent', () => {
        expect(isIOS({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15' })).toBe(true);
        expect(isIOS({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15' })).toBe(true);
        expect(isIOS({ userAgent: 'Mozilla/5.0 (iPod touch; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15' })).toBe(true);
    });

    it('detects iPadOS Safari desktop user agent with touch support', () => {
        const originalTouch = 'ontouchend' in document;
        try {
            (document as any).ontouchend = () => {};
            expect(isIOS({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' })).toBe(true);
        } finally {
            if (!originalTouch) delete (document as any).ontouchend;
        }
    });

    it('does not falsely detect desktop Chrome/Chromium on macOS with touch emulation as iOS', () => {
        const originalTouch = 'ontouchend' in document;
        try {
            (document as any).ontouchend = () => {};
            expect(isIOS({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' })).toBe(false);
            expect(isIOS({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chromium/120.0.0.0 Safari/537.36' })).toBe(false);
        } finally {
            if (!originalTouch) delete (document as any).ontouchend;
        }
    });

    it('returns false for Android and desktop platforms', () => {
        expect(isIOS({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' })).toBe(false);
        expect(isIOS({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' })).toBe(false);
        expect(isIOS(undefined)).toBe(false);
    });
});

describe('isAppsGlobal: this page is the community the BeanPool app\'s link opens', () => {
    it('the link and its community are the app\'s own (apps/native GLOBAL_NODE_URL)', () => {
        expect(APP_GLOBAL_LINK).toBe('https://beanpool.org/global');
        expect(APP_GLOBAL_HOST).toBe('global.beanpool.org');
        expect(IOS_GLOBAL_DOOR_FROM).toBe('1.2.56');
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

    describe('iOS gate (S14): App Store build before 1.2.56 has no global door', () => {
        it('an iOS phone browser at the app\'s global with appVersions.ios "1.2.31" gets no "app"', () => {
            expect(lobbyJoinWays({ phone: true, appsGlobal: true, doorOpen: true, platform: 'ios', appVersions: { ios: '1.2.31' } }))
                .toEqual(['browser', 'have-account']);
        });

        it('an iOS phone browser at the app\'s global with appVersions.ios "1.2.56" gets "app" first', () => {
            expect(lobbyJoinWays({ phone: true, appsGlobal: true, doorOpen: true, platform: 'ios', appVersions: { ios: '1.2.56' } }))
                .toEqual(['app', 'browser', 'have-account']);
        });

        it('an iOS phone browser at the app\'s global with appVersions.ios "1.3.0" gets "app" first', () => {
            expect(lobbyJoinWays({ phone: true, appsGlobal: true, doorOpen: true, platform: 'ios', appVersions: { ios: '1.3.0' } }))
                .toEqual(['app', 'browser', 'have-account']);
        });

        it('an iOS phone browser with appVersions missing or unreadable gets no "app"', () => {
            expect(lobbyJoinWays({ phone: true, appsGlobal: true, doorOpen: true, platform: 'ios', appVersions: undefined }))
                .toEqual(['browser', 'have-account']);
            expect(lobbyJoinWays({ phone: true, appsGlobal: true, doorOpen: true, platform: 'ios', appVersions: null }))
                .toEqual(['browser', 'have-account']);
            expect(lobbyJoinWays({ phone: true, appsGlobal: true, doorOpen: true, platform: 'ios', appVersions: { ios: null } }))
                .toEqual(['browser', 'have-account']);
            expect(lobbyJoinWays({ phone: true, appsGlobal: true, doorOpen: true, platform: 'ios', appVersions: { ios: 'invalid' } }))
                .toEqual(['browser', 'have-account']);
        });

        it('an Android phone browser is unchanged (gets "app" first)', () => {
            expect(lobbyJoinWays({ phone: true, appsGlobal: true, doorOpen: true, platform: 'android', appVersions: { ios: '1.2.31' } }))
                .toEqual(['app', 'browser', 'have-account']);
            expect(lobbyJoinWays({ phone: true, appsGlobal: true, doorOpen: true, platform: 'android', appVersions: undefined }))
                .toEqual(['app', 'browser', 'have-account']);
        });
    });
});

describe("lobbyJoinWays at a self-hoster's open community (issue #2563): the app at its own address", () => {
    it('a phone with a link for this community, its door open: the app first', () => {
        expect(lobbyJoinWays({ phone: true, appsGlobal: false, doorOpen: true, ownDoorLink: true })).toEqual(['app', 'browser', 'have-account']);
    });

    it('no link for this phone, a computer, or a door that turns strangers away: the browser join, as before', () => {
        expect(lobbyJoinWays({ phone: true, appsGlobal: false, doorOpen: true, ownDoorLink: false })).toEqual(['browser', 'have-account']);
        expect(lobbyJoinWays({ phone: false, appsGlobal: false, doorOpen: true, ownDoorLink: true })).toEqual(['browser', 'have-account']);
        expect(lobbyJoinWays({ phone: true, appsGlobal: false, doorOpen: false, ownDoorLink: true })).toEqual(['browser', 'have-account']);
    });

    it("an iPhone browser: only once the App Store build has the account-less door (S2), read on its own gate, not the global door's", () => {
        // The global door's version has the global door but not S2: its gate would let it through; this community's must not.
        expect(IOS_OPEN_DOOR_FROM).not.toBe(IOS_GLOBAL_DOOR_FROM);
        expect(lobbyJoinWays({ phone: true, appsGlobal: false, doorOpen: true, ownDoorLink: true, platform: 'ios', appVersions: { ios: IOS_GLOBAL_DOOR_FROM } }))
            .toEqual(['browser', 'have-account']);
        expect(lobbyJoinWays({ phone: true, appsGlobal: false, doorOpen: true, ownDoorLink: true, platform: 'ios', appVersions: { ios: IOS_OPEN_DOOR_FROM } }))
            .toEqual(['app', 'browser', 'have-account']);
        expect(lobbyJoinWays({ phone: true, appsGlobal: false, doorOpen: true, ownDoorLink: true, platform: 'ios', appVersions: undefined }))
            .toEqual(['browser', 'have-account']);
        // Android has no gate, as at the global.
        expect(lobbyJoinWays({ phone: true, appsGlobal: false, doorOpen: true, ownDoorLink: true, platform: 'android', appVersions: { ios: '1.0.0' } }))
            .toEqual(['app', 'browser', 'have-account']);
    });

    it("the app's global keeps its own gate when a link for its own address exists too", () => {
        expect(lobbyJoinWays({ phone: true, appsGlobal: true, doorOpen: true, ownDoorLink: true, platform: 'ios', appVersions: { ios: IOS_GLOBAL_DOOR_FROM } }))
            .toEqual(['app', 'browser', 'have-account']);
    });
});

describe("openDoorAppDoors: the app's door link for the page's own address, carrying nothing signed or of ours", () => {
    const ANDROID = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
    const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
    const PLAY = 'https://play.google.com/store/apps/details?id=org.beanpool.pillar';

    it('an iPhone: beanpool://join-open-door?node=<the address>, and the App Store beside it', () => {
        expect(openDoorAppDoors('https://hall.example.org', IPHONE)).toEqual({
            app: 'beanpool://join-open-door?node=https%3A%2F%2Fhall.example.org',
            store: 'https://apps.apple.com/app/id6761870086',
            platform: 'ios',
        });
    });

    it('Android: the same link by intent, with Google Play as its own fallback (no referrer, nothing carried)', () => {
        const doors = openDoorAppDoors('https://hall.example.org', ANDROID)!;
        expect(doors.platform).toBe('android');
        expect(doors.store).toBe(PLAY);
        expect(doors.app).toBe(
            'intent://join-open-door?node=https%3A%2F%2Fhall.example.org#Intent;scheme=beanpool;package=org.beanpool.pillar;'
            + `S.browser_fallback_url=${encodeURIComponent(PLAY)};end`);
        expect(doors.app).not.toMatch(/referrer/);
    });

    it("names the page's own address only: a port is kept, and nothing of beanpool.org is in either link", () => {
        for (const ua of [ANDROID, IPHONE]) {
            const doors = openDoorAppDoors('https://hall.example.org:8443', ua)!;
            expect(doors.app).toContain(encodeURIComponent('https://hall.example.org:8443'));
            expect(decodeURIComponent(doors.app)).not.toMatch(/beanpool\.org/);
            // The only address besides the community's is the store's own listing.
            expect(doors.store).toMatch(/^https:\/\/(play\.google\.com|apps\.apple\.com)\//);
        }
    });

    it("a LAN address over plain http, as a lights-out node serves it: allowed (the phone's cleartext rule); a public one over http: no link", () => {
        expect(openDoorAppDoors('http://192.168.1.20', IPHONE)?.app).toBe('beanpool://join-open-door?node=http%3A%2F%2F192.168.1.20');
        expect(openDoorAppDoors('http://hall.example.org', IPHONE)).toBeNull();
        expect(openDoorAppDoors('http://203.0.113.9', ANDROID)).toBeNull();
    });

    it('anything that is not a plain address, a computer, or no address: no link, so the browser join stays', () => {
        for (const origin of [null, undefined, '', 'not a url', 'ftp://hall.example.org', 'https://u:p@hall.example.org', 'https://hall.example.org/app', 'https://hall.example.org/?x=1', 'https://hall.example.org/#top']) {
            expect(openDoorAppDoors(origin, IPHONE), String(origin)).toBeNull();
        }
        expect(openDoorAppDoors('https://hall.example.org', 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/120.0')).toBeNull();
        expect(openDoorAppDoors('https://hall.example.org', '')).toBeNull();
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
        expect(phoneLaterLines({ where: 'settings', appsGlobal: false, host: 'mullum.beanpool.org', hasWords: false, signIns: null })).toEqual([]);
    });

    it('without the words line, the sign-in line stands alone: the app, Already a member, Recover with Social (review 4302869392)', () => {
        // The app's global: the phone fills it in after the sign-in, so no address.
        expect(phoneLaterLines({ where: 'settings', appsGlobal: true, host: 'global.beanpool.org', hasWords: false, signIns: 'Google' })).toEqual([
            'To use BeanPool on your phone later: install the app, tap **Already a member**, then **Recover with Social** and sign in with Google.',
        ]);
        // Any other community: its address, which the phone asks for after the sign-in.
        expect(phoneLaterLines({ where: 'settings', appsGlobal: false, host: 'mullum.beanpool.org', hasWords: false, signIns: 'Google' })).toEqual([
            "To use BeanPool on your phone later: install the app, tap **Already a member**, then **Recover with Social**, sign in with Google and type this community's address, mullum.beanpool.org.",
        ]);
        // No address to give: nothing, never a sign-in line that would restore into the global community instead.
        expect(phoneLaterLines({ where: 'settings', appsGlobal: false, host: null, hasWords: false, signIns: 'Google' })).toEqual([]);
        // "too" only ever follows the line it points at.
        for (const appsGlobal of [true, false]) for (const host of ['mullum.beanpool.org', null]) for (const hasWords of [true, false]) {
            const lines = phoneLaterLines({ where: 'settings', appsGlobal, host, hasWords, signIns: 'Google' });
            if (lines.some((line) => / too\.$/.test(line))) expect(lines[0]).toMatch(/12 words/);
            for (const line of lines) expect(line).toMatch(/^To use BeanPool on your phone later: install the app|^If you joined with/);
        }
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
