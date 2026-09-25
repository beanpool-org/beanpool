/**
 * A sign-in provider's page that returns by link must leave the member on the screen waiting for that sign-in.
 *
 * On Android the return is the `https://beanpool.org/auth/<provider>` App Link: always for Facebook, and for Google
 * whenever Credential Manager's sheet cannot appear. It reaches the running app as a Linking event, and that event is
 * what the waiting sign-in listens for (utils/sso-signin.ts, utils/pulse-oauth.ts). Expo Router used to navigate to
 * `auth/<provider>` as well, over the waiting screen, and every screen that reacts to navigation got a chance to
 * disturb it: first the root guard put a fresh welcome on top; once the return screen went back instead, welcome
 * applied its invite again when it regained focus, and step 3's sheet started a second sign-in.
 *
 * `+native-intent.ts` now passes the link on and cancels the navigation, as it already did for
 * `beanpool://foreground`: nothing is pushed, and nothing loses or regains focus. On a cold start no sign-in can be
 * waiting (the process that started it is gone), so the app opens at `/`, as it does from its icon.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const rn = vi.hoisted(() => ({ Platform: { OS: 'android' as string }, broadcasts: [] as string[] }));

vi.mock('react-native', () => ({
    Platform: rn.Platform,
    DeviceEventEmitter: {
        emit: vi.fn((name: string, url: string) => {
            if (name === 'SSO_AUTH_CALLBACK') rn.broadcasts.push(url);
        }),
    },
}));
vi.mock('expo-web-browser', () => ({
    maybeCompleteAuthSession: vi.fn(),
    dismissBrowser: vi.fn(async () => undefined),
}));

import { redirectSystemPath } from '../../app/+native-intent';
import { setupRedirect, isAuthReturnLink } from '../auth-return';
import { extractInviteToken, normaliseInviteCode } from '../invite-parser';

const APP = path.resolve(__dirname, '../../app');

/** Every sign-in return screen there is: app/auth/<provider>.tsx. */
const PROVIDERS = fs.readdirSync(path.join(APP, 'auth'))
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => f.replace(/\.tsx$/, ''))
    .sort();

/** The forms a provider's return arrives in: the Android App Link (query or fragment) and our scheme. */
function returnLinks(provider: string): string[] {
    return [
        `https://beanpool.org/auth/${provider}?code=c0de&state=n0nce#_=_`,
        `https://beanpool.org/auth/${provider}?error=access_denied&error_reason=user_denied&state=n0nce#_=_`,
        `https://beanpool.org/auth/${provider}#state=n0nce&id_token=x.y.z`,
        `beanpool://auth/${provider}#state=n0nce&id_token=x.y.z`,
        `beanpool://auth/${provider}?error=access_denied&state=n0nce`,
    ];
}

const NO_IDENTITY = { hasIdentity: false, pendingOnboarding: false };
const WIZARD_PENDING = { hasIdentity: true, pendingOnboarding: true };
const SET_UP = { hasIdentity: true, pendingOnboarding: false };

beforeEach(() => {
    rn.broadcasts.length = 0;
    rn.Platform.OS = 'android';
});

describe('a sign-in return link while the app is running', () => {
    it('covers every return screen in app/auth/', () => {
        expect(PROVIDERS).toEqual(['facebook', 'github', 'google', 'instagram', 'tiktok']);
    });

    for (const os of ['android', 'ios']) {
        it(`${os}: is handed to the waiting sign-in, and the member stays on the screen they were on`, () => {
            rn.Platform.OS = os;
            for (const provider of PROVIDERS) {
                for (const url of returnLinks(provider)) {
                    rn.broadcasts.length = 0;
                    expect(redirectSystemPath({ path: url, initial: false }), url).toBeNull();
                    expect(rn.broadcasts, url).toEqual([url]);
                }
            }
        });
    }

    it('also when Android adds a slash after the scheme', () => {
        expect(redirectSystemPath({ path: 'beanpool:///auth/facebook?code=c&state=n0nce', initial: false })).toBeNull();
    });
});

describe('a stray return link that opens the app from cold', () => {
    for (const os of ['android', 'ios']) {
        it(`${os}: opens the app at /, as its icon does, and never on a return screen`, () => {
            rn.Platform.OS = os;
            for (const provider of PROVIDERS) {
                for (const url of returnLinks(provider)) {
                    expect(redirectSystemPath({ path: url, initial: true }), url).toBe('/');
                }
            }
        });
    }

    it('/ is the welcome screen, which the guard leaves alone with no identity or a wizard pending: no member screen mounts', () => {
        const index = fs.readFileSync(path.join(APP, 'index.tsx'), 'utf-8');
        expect(index).toMatch(/<Redirect href="\/welcome" \/>/);
        expect(setupRedirect(['welcome'], NO_IDENTITY)).toBeNull();
        expect(setupRedirect(['welcome'], WIZARD_PENDING)).toBeNull();
    });

    it('a set-up member goes on from welcome to home, as on any launch', () => {
        const layout = fs.readFileSync(path.join(APP, '_layout.tsx'), 'utf-8');
        expect(setupRedirect(['welcome'], SET_UP)).toBeNull();
        expect(layout).toMatch(/root === 'welcome'\) \{\s*router\.replace\('\/\(tabs\)'\);/);
    });
});

describe('other links keep what they did', () => {
    it('beanpool://foreground stays where the member is, or opens at / from cold', () => {
        expect(redirectSystemPath({ path: 'beanpool://foreground', initial: false })).toBeNull();
        expect(redirectSystemPath({ path: 'beanpool://foreground', initial: true })).toBe('/');
    });

    it('an invite, a shared event and a takeover link still navigate', () => {
        const invite = 'https://mullum.beanpool.org/?invite=INV-ABCD-EFGH';
        expect(redirectSystemPath({ path: invite, initial: false })).toBe(invite);
        expect(redirectSystemPath({ path: 'https://mullum.beanpool.org/?post=p1', initial: false })).toBe('/post/p1');
        const unlock = 'beanpool://unlock-keys?server=mullum.beanpool.org';
        expect(redirectSystemPath({ path: unlock, initial: false })).toBe(unlock);
        expect(rn.broadcasts).toEqual([]);
    });
});

describe('the root guard while the member is still setting up', () => {
    // Roots the guard has always moved while the member is setting up (useSegments() output, root first).
    const OTHER_ROOTS: string[][] = [
        [],
        ['(tabs)'],
        ['(tabs)', 'settings'],
        ['node-mismatch'],
        ['chat', '[id]'],
        ['post', '[id]'],
        ['settings-signin'],
        ['google-probe'],
        ['channels'],
    ];

    it('sends a return screen to welcome like any other root, should one ever mount (the web preview)', () => {
        // On a phone they never mount (above). Where one does, the guard replaces it (after 50 ms with no identity,
        // at once with a wizard pending) before its own 300 ms timer can open /channels or anything else.
        for (const provider of PROVIDERS) {
            expect(setupRedirect(['auth', provider], NO_IDENTITY), provider).toBe('/welcome');
            expect(setupRedirect(['auth', provider], WIZARD_PENDING), provider).toBe('/welcome');
        }
    });

    it('still sends every other root to welcome with no identity, except welcome and guardian recovery', () => {
        for (const segments of OTHER_ROOTS) {
            expect(setupRedirect(segments, NO_IDENTITY), segments.join('/') || '(empty)').toBe('/welcome');
        }
        expect(setupRedirect(['recover-identity'], NO_IDENTITY)).toBeNull();
        expect(setupRedirect(['welcome'], NO_IDENTITY)).toBeNull();
    });

    it('still sends every other root to welcome while a wizard is pending, guardian recovery included', () => {
        for (const segments of [...OTHER_ROOTS, ['recover-identity']]) {
            expect(setupRedirect(segments, WIZARD_PENDING), segments.join('/') || '(empty)').toBe('/welcome');
        }
        expect(setupRedirect(['welcome'], WIZARD_PENDING)).toBeNull();
    });

    it('does not act once the member is set up: the node-recognition checks decide, as before', () => {
        for (const segments of [...OTHER_ROOTS, ['welcome'], ['recover-identity'], ...PROVIDERS.map((p) => ['auth', p])]) {
            expect(setupRedirect(segments, SET_UP), segments.join('/') || '(empty)').toBeNull();
        }
    });
});

describe('the invite handler and a sign-in return link', () => {
    const FACEBOOK_CANCEL = 'https://beanpool.org/auth/facebook?error=access_denied&error_code=200&error_description=Permissions+error&error_reason=user_denied&state=n0nce#_=_';
    // An id_token is base64url, so an invite-shaped run of characters can turn up anywhere in it.
    const GOOGLE_TOKEN_WITH_INVITE_SHAPE = 'https://beanpool.org/auth/google#state=n0nce&id_token=eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.aBp-A1B2-C3D4xyz&authuser=0';

    it('is needed: the invite parser reads these returns as invites from https://beanpool.org', () => {
        expect(normaliseInviteCode(extractInviteToken(FACEBOOK_CANCEL))).toBe('INV-FACE-BOOK');
        expect(extractInviteToken(GOOGLE_TOKEN_WITH_INVITE_SHAPE)).toBe('Bp-A1B2-C3D4');
    });

    it('recognises every form a sign-in return arrives in', () => {
        for (const url of [
            FACEBOOK_CANCEL,
            GOOGLE_TOKEN_WITH_INVITE_SHAPE,
            'https://beanpool.org/auth/google#state=n0nce&id_token=x',
            'https://beanpool.org/auth/facebook#access_token=a&id_token=b&state=n0nce',
            'beanpool://auth/google#state=n0nce&id_token=x',
            'beanpool://auth/facebook?error=access_denied',
            'beanpool:///auth/facebook?error=access_denied',
            'https://beanpool.org/auth/instagram?code=c&state=s',
            'https://beanpool.org/auth/tiktok?code=c&state=s',
            '/auth/github?code=c&state=s',
            'auth/github?code=c&state=s',
            ...PROVIDERS.flatMap(returnLinks),
        ]) {
            expect(isAuthReturnLink(url), url).toBe(true);
        }
    });

    it('never swallows an invite', () => {
        for (const url of [
            'https://mullum.beanpool.org/?invite=INV-ABCD-EFGH',
            'https://test.beanpool.org/?invite=BP-ABCD-1234',
            'https://beanpool.org/?invite=INV-ABCD-EFGH&server=mullum.beanpool.org',
            'beanpool://invite?code=BP-ABCD-EFGH',
            'beanpool://welcome?invite=INV-ABCD-EFGH',
            'INV-ABCD-EFGH',
            'https://mullum.beanpool.org/auth/google?invite=INV-ABCD-EFGH',
        ]) {
            expect(isAuthReturnLink(url), url).toBe(false);
        }
    });
});
