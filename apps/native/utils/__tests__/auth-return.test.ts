/**
 * A sign-in provider's page that returns by link must hand the member back to the screen waiting for that
 * sign-in, not bury it under a fresh welcome screen.
 *
 * On Android the return is the `https://beanpool.org/auth/<provider>` App Link: always for Facebook, and for
 * Google whenever Credential Manager's sheet cannot appear. Expo Router pushes `auth/<provider>` over the
 * waiting screen, and the return screen goes back to it 300 ms later. The root guard in app/_layout.tsx used to
 * replace it with a new /welcome first while the member had no identity yet (recovery on a new phone) or a join
 * wizard pending (onboarding step 3). The screen doing the work ended up hidden: a failed recovery's error never
 * showed, a second recovery could start on top, and after a successful link step 3 showed the member as
 * unprotected. The token itself still arrives by the Linking event (utils/sso-signin.ts); none of this touches it.
 */
import { describe, it, expect } from 'vitest';
import { setupRedirect, authReturnDestination, isAuthReturnLink } from '../auth-return';
import { extractInviteToken, normaliseInviteCode } from '../invite-parser';

const NO_IDENTITY = { hasIdentity: false, pendingOnboarding: false };
const WIZARD_PENDING = { hasIdentity: true, pendingOnboarding: true };
const SET_UP = { hasIdentity: true, pendingOnboarding: false };

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
];

describe('the root guard while the member is still setting up', () => {
    it("leaves Google's and Facebook's return screens alone with no identity yet (recovery on a new phone)", () => {
        expect(setupRedirect(['auth', 'google'], NO_IDENTITY)).toBeNull();
        expect(setupRedirect(['auth', 'facebook'], NO_IDENTITY)).toBeNull();
    });

    it('leaves them alone while a join wizard is pending (onboarding step 3)', () => {
        expect(setupRedirect(['auth', 'google'], WIZARD_PENDING)).toBeNull();
        expect(setupRedirect(['auth', 'facebook'], WIZARD_PENDING)).toBeNull();
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
        for (const segments of [...OTHER_ROOTS, ['welcome'], ['recover-identity'], ['auth', 'google'], ['auth', 'facebook']]) {
            expect(setupRedirect(segments, SET_UP), segments.join('/') || '(empty)').toBeNull();
        }
    });
});

describe('the return screen, once it has passed the link on', () => {
    it('goes back to the screen waiting for the sign-in whenever there is one', () => {
        for (const state of [NO_IDENTITY, WIZARD_PENDING, SET_UP]) {
            expect(authReturnDestination({ canGoBack: true, ...state })).toBe('back');
        }
    });

    it('with nothing to go back to (a cold start from the link), lands where the guard would have sent it', () => {
        expect(authReturnDestination({ canGoBack: false, ...NO_IDENTITY })).toBe('/welcome');
        expect(authReturnDestination({ canGoBack: false, ...WIZARD_PENDING })).toBe('/welcome');
        expect(authReturnDestination({ canGoBack: false, ...SET_UP })).toBe('/(tabs)');
    });

    it('never lands on a root the guard would move again', () => {
        for (const state of [NO_IDENTITY, WIZARD_PENDING, SET_UP]) {
            const to = authReturnDestination({ canGoBack: false, ...state });
            expect(setupRedirect([to.slice(1)], state)).toBeNull();
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
            'https://beanpool.org/auth/instagram?code=c&state=s',
            'https://beanpool.org/auth/tiktok?code=c&state=s',
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
