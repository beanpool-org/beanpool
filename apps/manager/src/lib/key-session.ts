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
 * fresh CSRF token is fetched. Nothing here stores a password, and the password login stays exactly as it was.
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
    | { kind: 'none'; section: HandoffSection | null }
    | { kind: 'failed'; message: string; section: HandoffSection | null };

function asRole(r: unknown): KeySessionRole | null {
    return r === 'owner' || r === 'admin' || r === 'moderator' ? r : null;
}

/**
 * Run once when the single-node /settings page loads. `win` is injectable for tests.
 */
export async function startKeySession(win: Pick<Window, 'location' | 'history'> = window): Promise<KeySessionStart> {
    const { token, section } = parseHandoffFragment(win.location.hash || '');
    if (win.location.hash && /(^|[#&])(handoff|section|from)=/.test(win.location.hash)) {
        // Out of the address bar (and so out of history, bookmarks and screenshots) before anything else.
        // `from` (lib/came-from.ts, read before this runs) goes with it.
        win.history.replaceState(null, '', win.location.pathname + win.location.search);
    }

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
            const why = body.expired
                ? 'That sign-in link expired (they last 60 seconds).'
                : body.replay
                    ? 'That sign-in link was already used.'
                    : 'That sign-in link was not accepted.';
            return { kind: 'failed', message: `${why} Open “Manage” again from the BeanPool app, or sign in with the admin password.`, section };
        } catch {
            return { kind: 'failed', message: 'Could not reach the node to finish signing in.', section };
        }
    }

    // No link: an earlier key sign-in may still hold a live cookie.
    try {
        const res = await fetch('/api/local/admin/auth/session', { credentials: 'same-origin', cache: 'no-store' });
        const body = await res.json().catch(() => ({})) as Record<string, unknown>;
        const role = asRole(body.role);
        if (body.authenticated === true && body.isKeySession === true && role && typeof body.memberPubkey === 'string') {
            const csrfRes = await fetch('/api/local/admin/csrf-token', { method: 'POST', credentials: 'same-origin' });
            const csrfBody = await csrfRes.json().catch(() => ({})) as Record<string, unknown>;
            if (csrfRes.ok && typeof csrfBody.csrfToken === 'string') {
                return { kind: 'session', session: { memberPubkey: body.memberPubkey, role }, csrfToken: csrfBody.csrfToken, section };
            }
        }
    } catch { /* fall through to the password login */ }
    return { kind: 'none', section };
}

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
