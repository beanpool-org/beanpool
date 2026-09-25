/**
 * The welcome screen applies each invite once, and only a new invite switches it to the join form.
 *
 * An invite reaches welcome two ways, usually both for the same tap: the link itself (`Linking.useURL()`) and the
 * `invite` / `server` / `t` params the root layout sets from it (app/_layout.tsx, `routeToWelcomeWithInvite`).
 * Welcome's invite effect re-ran whenever either changed and applied the invite again, switching whatever the member
 * was doing to the join form (mode `create`):
 * - `useURL()` changes on every link the app receives: a sign-in provider's return (the Android App Link), and
 *   `beanpool://foreground`, which follows every Android sign-in (utils/sso-signin.ts, `returnToApp`).
 * - `useGlobalSearchParams()` follows the focused route, so the params vanish while another screen is on top and come
 *   back when it closes.
 * A recovery in progress became the join form. Step 3 (`seedBackup`) was rebuilt, because each mode draws its own
 * tree (`ScrollView key={mode}`), and its sign-in sheet started a second sign-in.
 *
 * The screen itself cannot be rendered here (see vitest.config.ts), so `welcomeScreen` below reduces welcome.tsx's
 * invite effect to what decides the mode, driven by the same functions the screen calls, and the last block checks
 * that the screen does call them.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { latestInviteLink, linkCarriesInvite, inviteToApply, type InviteParams } from '../welcome-invite';

const INVITE_LINK = 'https://mullum.beanpool.org/?invite=INV-ABCD-EFGH';
const PARAMS: InviteParams = { invite: 'INV-ABCD-EFGH', server: 'https://mullum.beanpool.org', t: '1727222400000' };

/** Links that reach the app during a sign-in on Android. None of them is an invite. */
const SIGN_IN_LINKS = [
    'https://beanpool.org/auth/google#state=n0nce&id_token=x.y.z',
    'https://beanpool.org/auth/facebook?code=c0de&state=n0nce#_=_',
    'https://beanpool.org/auth/facebook?error=access_denied&error_reason=user_denied&state=n0nce#_=_',
    'beanpool://auth/google#state=n0nce&id_token=x.y.z',
    'beanpool://foreground',
];

type Mode = 'home' | 'member' | 'create' | 'ssoRecover' | 'seedBackup';

/**
 * welcome.tsx's invite effect, reduced to what decides the mode. `render` is one render of the screen with what its
 * hooks return: `Linking.useURL()` and the params of the focused route. The effect runs only when one of its
 * dependencies changed, as React runs it.
 */
function welcomeScreen(first: { url: string | null; params: InviteParams }) {
    let mode: Mode = 'home';
    let link: string | null = null;
    let deps: unknown[] | null = null;
    const applied = new Set<string>();
    const render = ({ url, params }: { url: string | null; params: InviteParams }) => {
        link = latestInviteLink(link, url);
        const next = [params.invite, params.t, link];
        if (deps && next.every((d, i) => d === deps![i])) return;
        deps = next;
        const { arrival, seen } = inviteToApply(link, params, applied);
        seen.forEach((key) => applied.add(key));
        if (arrival) mode = 'create';
    };
    render(first);
    return {
        render,
        get mode() { return mode; },
        /** What the member does on the screen: Restore → Recover with Social, or finishing steps 1 and 2. */
        go(to: Mode) { mode = to; },
        /** The link a render would see. */
        get link() { return link; },
    };
}

/** Another screen opens over welcome and closes again: the focused route's params vanish, then come back. */
function focusAwayAndBack(screen: ReturnType<typeof welcomeScreen>, url: string | null, params: InviteParams) {
    screen.render({ url, params: {} });
    screen.render({ url, params });
}

describe('an invite that brought the member here is applied once', () => {
    it('arriving by an invite link opens the join form', () => {
        const screen = welcomeScreen({ url: INVITE_LINK, params: PARAMS });
        expect(screen.mode).toBe('create');
    });

    it('recovery after arriving by an invite link: the sign-in links leave the recovery screen as it is', () => {
        const screen = welcomeScreen({ url: INVITE_LINK, params: PARAMS });
        screen.go('member');
        screen.go('ssoRecover');
        for (const url of SIGN_IN_LINKS) {
            screen.render({ url, params: PARAMS });
            expect(screen.mode, url).toBe('ssoRecover');
        }
    });

    it('recovery: so does another screen opening over welcome and closing', () => {
        const screen = welcomeScreen({ url: INVITE_LINK, params: PARAMS });
        screen.go('ssoRecover');
        focusAwayAndBack(screen, INVITE_LINK, PARAMS);
        expect(screen.mode).toBe('ssoRecover');
        focusAwayAndBack(screen, SIGN_IN_LINKS[0], PARAMS);
        expect(screen.mode).toBe('ssoRecover');
    });

    it('recovery with only the params (the link never reached this screen): nothing re-applies them', () => {
        const screen = welcomeScreen({ url: null, params: PARAMS });
        expect(screen.mode).toBe('create');
        screen.go('ssoRecover');
        for (const url of SIGN_IN_LINKS) screen.render({ url, params: PARAMS });
        focusAwayAndBack(screen, SIGN_IN_LINKS[1], PARAMS);
        expect(screen.mode).toBe('ssoRecover');
    });

    it('onboarding step 3 after an invite link: the mode never leaves seedBackup, so step 3 is never rebuilt', () => {
        const screen = welcomeScreen({ url: INVITE_LINK, params: PARAMS });
        screen.go('seedBackup');
        for (const url of SIGN_IN_LINKS) {
            screen.render({ url, params: PARAMS });
            expect(screen.mode, url).toBe('seedBackup');
        }
        focusAwayAndBack(screen, SIGN_IN_LINKS[4], PARAMS);
        expect(screen.mode).toBe('seedBackup');
    });

    it('onboarding step 3 after a typed code (no link, no params): the sign-in links change nothing', () => {
        const screen = welcomeScreen({ url: null, params: {} });
        screen.go('seedBackup');
        for (const url of SIGN_IN_LINKS) screen.render({ url, params: {} });
        expect(screen.mode).toBe('seedBackup');
    });

    it('the same tap seen through both the link and the params is applied once', () => {
        const screen = welcomeScreen({ url: INVITE_LINK, params: {} });
        screen.render({ url: INVITE_LINK, params: PARAMS }); // the root layout's params land a render later
        expect(screen.mode).toBe('create');
        screen.go('member');
        focusAwayAndBack(screen, INVITE_LINK, PARAMS);
        expect(screen.mode).toBe('member');
    });
});

describe('a new invite still counts', () => {
    it('tapping the same invite again: the root layout sets a new t', () => {
        const screen = welcomeScreen({ url: INVITE_LINK, params: PARAMS });
        screen.go('member');
        screen.render({ url: INVITE_LINK, params: { ...PARAMS, t: '1727222499999' } });
        expect(screen.mode).toBe('create');
    });

    it('a different invite link', () => {
        const screen = welcomeScreen({ url: INVITE_LINK, params: PARAMS });
        screen.go('ssoRecover');
        screen.render({ url: 'https://test.beanpool.org/?invite=BP-WXYZ-1234', params: PARAMS });
        expect(screen.mode).toBe('create');
    });

    it('an invite link arriving after a sign-in link', () => {
        const screen = welcomeScreen({ url: null, params: {} });
        screen.go('ssoRecover');
        screen.render({ url: SIGN_IN_LINKS[0], params: {} });
        screen.render({ url: INVITE_LINK, params: {} });
        expect(screen.mode).toBe('create');
    });
});

describe('the link welcome reacts to', () => {
    it('is the last one that carried an invite: a sign-in link never replaces it', () => {
        for (const url of SIGN_IN_LINKS) {
            expect(latestInviteLink(INVITE_LINK, url), url).toBe(INVITE_LINK);
            expect(latestInviteLink(null, url), url).toBeNull();
        }
        expect(latestInviteLink(INVITE_LINK, null)).toBe(INVITE_LINK);
    });

    it('carries an invite in its query, and is not a sign-in return', () => {
        for (const url of [INVITE_LINK, 'beanpool://welcome?invite=INV-ABCD-EFGH&server=mullum.beanpool.org', 'https://beanpool.org/?server=x&invite=BP-ABCD-1234']) {
            expect(linkCarriesInvite(url), url).toBe(true);
        }
        for (const url of [
            ...SIGN_IN_LINKS,
            'https://beanpool.org/auth/facebook?invite=INV-ABCD-EFGH&state=n0nce',
            'https://mullum.beanpool.org/?invite=',
            'https://mullum.beanpool.org/#invite=INV-ABCD-EFGH',
            'https://mullum.beanpool.org/?post=p1',
        ]) {
            expect(linkCarriesInvite(url), url).toBe(false);
        }
    });
});

describe('app/welcome.tsx', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../app/welcome.tsx'), 'utf-8');

    it('keeps the last invite link and decides with inviteToApply', () => {
        expect(src).toMatch(/latestInviteLink\(inviteLink, incomingUrl\)/);
        expect(src).toMatch(/inviteToApply\(inviteLink, /);
    });

    it('re-runs neither the invite nor the resume effect on a link that carries no invite', () => {
        expect(src).toMatch(/\}, \[params\?\.invite, params\?\.t, inviteLink\]\);/);
        expect(src).toMatch(/\}, \[params\?\.invite, inviteLink\]\);/);
        expect(src).not.toMatch(/\[[^\]]*\bincomingUrl\b[^\]]*\]\);/);
    });
});
