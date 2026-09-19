/**
 * `/app#profile=<member public key>` opens that member's profile. Node Settings links here for "View my
 * profile" when it was opened from the web app (apps/manager/src/lib/came-from.ts). A fragment, not a path:
 * the web app has no URL routes, and the fragment never reaches the server.
 *
 * Read once on load and taken out of the address bar, so a reload or Back does not reopen the profile.
 */
export function takeProfileFragment(win: Pick<Window, 'location' | 'history'> = window): string | null {
    const hash = win.location.hash || '';
    if (!/(^|[#&])profile=/.test(hash)) return null;
    const pubkey = new URLSearchParams(hash.replace(/^#/, '')).get('profile');
    try {
        win.history.replaceState(win.history.state, '', win.location.pathname + win.location.search);
    } catch { /* the profile still opens; the fragment just stays in the address bar */ }
    return pubkey && /^[0-9a-f]{64}$/i.test(pubkey) ? pubkey.toLowerCase() : null;
}
