/**
 * Key sign-in for the node's own /settings (docs/admin-surface.md §2.3).
 *
 * The member app opens `/settings#handoff=<token>[&section=<id>]`. The token is a 60-second, single-use
 * credential the node minted after the member signed its challenge with their key (and, if the owner turned
 * it on, gave the node's 2FA code). It rides in the URL FRAGMENT so no server, proxy log or Referer ever
 * sees it; this module takes it out of the address bar first, then posts it to the node once. The node
 * answers with an httpOnly `admin_session` cookie — every later request carries it automatically, same
 * origin — and a CSRF token, which has to go on every request because the cookie is ambient.
 *
 * A reload keeps working without a new link: the cookie is still there, so `/auth/session` says so and a
 * fresh CSRF token is fetched.
 *
 * The password sign-in (signInWithPassword, below) ends the same way: the node checks the password (and its 2FA code)
 * once and answers the same kind of cookie and CSRF token. The password is never kept: not in web storage, not in
 * memory after the call. The members' web app shares this origin, so anything stored here is one script away from
 * it (Fable's web review, M1); an httpOnly cookie is not.
 */

export type KeySessionRole = 'owner' | 'admin' | 'moderator';
export type KeySession = { memberPubkey: string; role: KeySessionRole };

/** A moderator's Settings is Reports and nothing else (components/modules/ModeratorView.tsx). */
export function isModeratorSession(session: KeySession | null | undefined): boolean {
    return session?.role === 'moderator';
}

/** /settings sections the node's admin queue links to — mirrors ADMIN_SETTINGS_SECTIONS on the server. */
export const HANDOFF_SECTIONS = ['home', 'moderation', 'disputes', 'decisions'] as const;
export type HandoffSection = typeof HANDOFF_SECTIONS[number];

export function sectionTarget(section: HandoffSection): { tab: 'home' | 'people' | 'economy'; subTab?: string } {
    switch (section) {
        case 'moderation': return { tab: 'people', subTab: 'moderation' };
        case 'disputes': return { tab: 'economy', subTab: 'disputes' };
        case 'decisions': return { tab: 'economy', subTab: 'decisions' };
        default: return { tab: 'home' };
    }
}

/**
 * Where a link lands for this role. A moderator has one screen, Reports, so every link lands there: a section they
 * cannot open (disputes, decisions, home) never shows an empty or refused screen.
 */
export function sectionTargetFor(role: KeySessionRole | null | undefined, section: HandoffSection | null): { tab: 'home' | 'people' | 'economy'; subTab?: string } | null {
    if (role === 'moderator') return sectionTarget('moderation');
    return section ? sectionTarget(section) : null;
}

export function parseHandoffFragment(hash: string): { token: string | null; section: HandoffSection | null } {
    const params = new URLSearchParams(hash.replace(/^#/, ''));
    const token = params.get('handoff');
    const section = params.get('section');
    return {
        token: token && /^[0-9a-f]{16,128}$/i.test(token) ? token : null,
        section: section && (HANDOFF_SECTIONS as readonly string[]).includes(section) ? section as HandoffSection : null,
    };
}

export type KeySessionStart =
    | { kind: 'session'; session: KeySession; csrfToken: string; section: HandoffSection | null }
    /**
     * An earlier password sign-in whose cookie is still live: the node's owner, no member. `totpSetupRequired`: the
     * node's 2FA is off, so the session opens only the 2FA setup card (design step 6, components/auth/TotpSetupGate).
     */
    | { kind: 'password'; csrfToken: string; section: HandoffSection | null; totpSetupRequired: boolean }
    | { kind: 'none'; section: HandoffSection | null }
    | { kind: 'failed'; message: string; section: HandoffSection | null };

function asRole(r: unknown): KeySessionRole | null {
    return r === 'owner' || r === 'admin' || r === 'moderator' ? r : null;
}

/** Whether the fragment carries the app's sign-in link at all, usable or not. */
export function carriesHandoff(hash: string): boolean {
    return /(^|[#&])handoff=/.test(hash);
}

/** What the page says when the phone's link can't be used. Never the password form alone, with no word why. */
export function handoffRefusedMessage(why: 'expired' | 'replay' | 'refused' | 'damaged' | 'unreachable'): string {
    const again = 'Tap Manage again in the BeanPool app, or sign in below with the admin password.';
    switch (why) {
        case 'expired': return `This sign-in link from your phone has expired (they last 60 seconds). ${again}`;
        case 'replay': return `This sign-in link from your phone was already used. ${again}`;
        case 'damaged': return `This sign-in link from your phone arrived cut short or damaged. ${again}`;
        case 'unreachable': return `Could not reach the node to finish signing in with the link from your phone. ${again}`;
        default: return `This sign-in link from your phone was not accepted. ${again}`;
    }
}

/**
 * Run when the single-node /settings page loads, and again whenever a new link reaches the page already open
 * (App.tsx, hashchange: an Android Custom Tab brought back to the front loads `/settings#handoff=…` into the page it
 * still shows, and a change of fragment alone reloads nothing). `win` is injectable for tests.
 *
 * A link that can't be used is SAID (`failed`), never left as a silent password form, unless the browser already holds a
 * live session, which is resumed as a reload would: a page that loaded twice burns its own link the first time.
 */
export async function startKeySession(win: Pick<Window, 'location' | 'history'> = window): Promise<KeySessionStart> {
    const hash = win.location.hash || '';
    const { token, section } = parseHandoffFragment(hash);
    if (hash && /(^|[#&])(handoff|section|from)=/.test(hash)) {
        // Out of the address bar (and so out of history, bookmarks and screenshots) before anything else.
        // `from` (lib/came-from.ts, read before this runs) goes with it.
        win.history.replaceState(null, '', win.location.pathname + win.location.search);
    }

    let refused: string | null = null;
    if (token) {
        try {
            const res = await fetch('/api/local/admin/auth/exchange', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token }),
            });
            const body = await res.json().catch(() => ({})) as Record<string, unknown>;
            const role = asRole(body.role);
            if (res.ok && role && typeof body.memberPubkey === 'string' && typeof body.csrfToken === 'string') {
                return { kind: 'session', session: { memberPubkey: body.memberPubkey, role }, csrfToken: body.csrfToken, section };
            }
            refused = handoffRefusedMessage(body.expired ? 'expired' : body.replay ? 'replay' : 'refused');
        } catch {
            refused = handoffRefusedMessage('unreachable');
        }
    } else if (carriesHandoff(hash)) {
        refused = handoffRefusedMessage('damaged');
    }

    // No usable link: an earlier sign-in (a key's or the password's) may still hold a live cookie.
    try {
        const res = await fetch('/api/local/admin/auth/session', { credentials: 'same-origin', cache: 'no-store' });
        const body = await res.json().catch(() => ({})) as Record<string, unknown>;
        const role = asRole(body.role);
        const isKey = body.isKeySession === true && role && typeof body.memberPubkey === 'string';
        const isPassword = body.isPasswordSession === true && role === 'owner';
        if (body.authenticated === true && (isKey || isPassword)) {
            const csrfRes = await fetch('/api/local/admin/csrf-token', { method: 'POST', credentials: 'same-origin' });
            const csrfBody = await csrfRes.json().catch(() => ({})) as Record<string, unknown>;
            if (csrfRes.ok && typeof csrfBody.csrfToken === 'string') {
                if (isPassword) return { kind: 'password', csrfToken: csrfBody.csrfToken, section, totpSetupRequired: body.totpSetupRequired === true };
                return { kind: 'session', session: { memberPubkey: body.memberPubkey as string, role: role! }, csrfToken: csrfBody.csrfToken, section };
            }
        }
    } catch { /* fall through to the password login */ }
    return refused ? { kind: 'failed', message: refused, section } : { kind: 'none', section };
}

export type PasswordSignIn =
    /** `totpSetupRequired`: the node's 2FA is off, so this session opens only the 2FA setup card (TotpSetupGate). */
    | { ok: true; csrfToken: string; totpSetupRequired: boolean }
    | { ok: false; error: string; totpRequired: boolean };

/**
 * The password sign-in: POST /api/local/admin/auth/password with the password (and the 2FA code, once the node asks
 * for one). On success the node has set the httpOnly admin_session cookie; this returns its CSRF token. Nothing is
 * stored: the caller drops the password as soon as this returns.
 */
export async function signInWithPassword(url: string, password: string, totpCode?: string): Promise<PasswordSignIn> {
    const res = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, ...(totpCode ? { totpCode } : {}) }),
    });
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (res.ok && typeof body.csrfToken === 'string') return { ok: true, csrfToken: body.csrfToken, totpSetupRequired: body.totpSetupRequired === true };
    return {
        ok: false,
        totpRequired: body.totpRequired === true,
        error: typeof body.error === 'string' && body.error ? body.error : `Authentication failed (${res.status})`,
    };
}

/**
 * Leftovers of the old password sign-in, which kept the password and its 2FA session in this origin's web storage.
 * Removed on every load, so a browser that signed in before this build holds none of them after its next visit.
 */
const OLD_SECRET_KEYS = ['bp-admin-token', 'bp-2fa-session', 'bp-csrf-token'];
const OLD_SECRET_PREFIX = 'bp_tfa_session_';

export function forgetStoredAdminSecrets(store: Pick<Storage, 'length' | 'key' | 'removeItem'> | undefined = typeof window !== 'undefined' ? window.sessionStorage : undefined): void {
    if (!store) return;
    try {
        for (let i = store.length - 1; i >= 0; i--) {
            const key = store.key(i);
            if (key && (OLD_SECRET_KEYS.includes(key) || key.startsWith(OLD_SECRET_PREFIX))) store.removeItem(key);
        }
    } catch { /* storage unavailable: nothing was kept there either */ }
}

/** Sign-out, for a key session and a password session alike: the node ends the session and clears the cookie. */
export async function endKeySession(csrfToken: string | null): Promise<void> {
    try {
        await fetch('/api/local/admin/auth/logout', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) },
            body: '{}',
        });
    } catch { /* the cookie dies with its session anyway */ }
}
