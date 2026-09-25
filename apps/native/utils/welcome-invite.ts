/**
 * How the welcome screen takes an invite that arrives while it is open (app/welcome.tsx).
 *
 * An invite reaches welcome two ways, usually both for the same tap: the link itself (`Linking.useURL()`), and the
 * `invite` / `server` / `t` params the root layout sets from that link (app/_layout.tsx, `routeToWelcomeWithInvite`).
 * Applying one switches welcome to the join form.
 *
 * Both also change when no invite has arrived, and welcome used to apply the invite again each time, switching
 * whatever the member was doing to the join form:
 * - `useURL()` changes on every link the app receives: a sign-in provider's return (the Android App Link), and
 *   `beanpool://foreground`, which follows every Android sign-in (utils/sso-signin.ts, `returnToApp`).
 * - `useGlobalSearchParams()` follows the focused route, so the params vanish while another screen is on top and come
 *   back when it closes.
 * A recovery in progress became the join form. Onboarding's step 3 was rebuilt, and its sign-in sheet started a
 * second sign-in.
 */

import { isAuthReturnLink } from './auth-return';

/** The router params an invite arrives in. */
export interface InviteParams {
    invite?: string;
    server?: string;
    /** Set afresh each time the root layout routes an invite link here, so a second tap on the same invite counts. */
    t?: string;
}

export type InviteArrival =
    | { from: 'link'; url: string }
    | { from: 'params'; invite: string; server?: string };

/** A link with an invite in its query, which is what welcome reads from one. A sign-in return never counts. */
export function linkCarriesInvite(url: string): boolean {
    if (isAuthReturnLink(url)) return false;
    return /[?&]invite=[^&#]/.test(url.split('#')[0]);
}

/** The last link that carried an invite. Any other link leaves it as it was, so nothing that depends on it re-runs. */
export function latestInviteLink(previous: string | null, incoming: string | null): string | null {
    return incoming && linkCarriesInvite(incoming) ? incoming : previous;
}

/**
 * The invite to apply now, if any, and the keys of every invite present, for the caller to mark applied.
 *
 * Each arrival is applied once for as long as the screen is mounted. A link is known by its URL, the params by their
 * values, `t` included. When both are present and new they are the same tap, or the link is newer, so the link is
 * applied, as before. Both are marked, so neither is applied again when the params return after another screen
 * closes.
 */
export function inviteToApply(
    link: string | null,
    params: InviteParams,
    applied: ReadonlySet<string>,
): { arrival: InviteArrival | null; seen: string[] } {
    const present: Array<{ key: string; arrival: InviteArrival }> = [];
    if (link) present.push({ key: `link:${link}`, arrival: { from: 'link', url: link } });
    if (params.invite) {
        present.push({
            key: `params:${params.invite}|${params.server ?? ''}|${params.t ?? ''}`,
            arrival: { from: 'params', invite: params.invite, server: params.server },
        });
    }
    const fresh = present.find((p) => !applied.has(p.key));
    return { arrival: fresh?.arrival ?? null, seen: present.map((p) => p.key) };
}
