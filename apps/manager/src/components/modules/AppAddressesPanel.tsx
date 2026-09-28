/**
 * Network → "Addresses members' apps use" (request binding).
 *
 * A member's app signs every request for the address it reaches the community at, and the node accepts only its own
 * addresses, so a request someone copied from another community can't be used here (apps/server
 * engine/own-addresses.ts, engine/member-signature.ts). This lists those addresses with where each comes from and how
 * many apps used it; how many apps still reach it by a name it had before, and where it lives now (lost-name L4); lets
 * the owner confirm an address the node doesn't know (a self-hoster's custom domain behind a proxy); and says how many
 * apps too old to name a community still reach it before the switch date.
 *
 * An owner or admin confirms; nothing here is ever learned from a request by itself. Only the address this page is
 * open at is offered with one tap (apps/server engine/address-offers.ts): members' keys can all be one person's, and
 * another community can pass on requests signed for its own address, so no count makes another address safe for one
 * tap. Every other address apps reached is shown with its counts (how many members' apps, and whether an owner's or
 * admin's did) and confirmed only once the owner ticks that it is this community's. One the BeanPool directory lists
 * as a community's is named and warned about too, on a node that holds the directory. Another community's
 * beanpool.org name can't be confirmed here at all.
 */
import { useCallback, useEffect, useState } from 'react';
import { audienceOf } from '@beanpool/core';
import type { NodeProfile } from '../../lib/profiles';
import {
    confirmAppAddress, getAppAddresses, getTfaSessionToken, removeAppAddress,
    type AddressSighting, type AppAddress, type AppAddressesReport, type HeldBackAddress,
} from '../../lib/node-client';

const SOURCE_TEXT: Record<AppAddress['source'], string> = {
    'public-address': "this community's web address",
    env: 'set on the server (BEANPOOL_ADDRESSES)',
    owner: 'confirmed in Settings',
    registrar: 'its BeanPool name',
};

const apps = (n: number) => `${n} app${n === 1 ? '' : 's'}`;
const membersApps = (n: number) => (n === 1 ? "1 member's app" : `${n} members' apps`);

/**
 * A name in the BeanPool registrar's zone. A node with none of its names has no such name of its own (its registrar
 * name would be one of them), so any it is offered is another community's: never offered here, even by an older
 * server that still lists one.
 */
export function isBeanPoolName(host: string): boolean {
    return host === 'beanpool.org' || host.endsWith('.beanpool.org');
}

/** Who reached the community at an address, in words. */
function reachedText(s: AddressSighting): string {
    return `${membersApps(s.busiestDay)} reached this community at ${s.address} on the busiest day this week${s.ownerOrAdmin ? ", an owner's or admin's among them" : ''}.`;
}

/** The one-tap offer of the address this page is open at, with the members' apps that reached it there too. */
function pageOfferText(host: string, s: AddressSighting | undefined): string {
    const also = s && s.busiestDay > 0
        ? `, and so did ${membersApps(s.busiestDay)} this week${s.ownerOrAdmin ? ", an owner's or admin's among them" : ''}`
        : '';
    return `This page reached the community at ${host}${also}. Is that the address members' apps use?`;
}

/**
 * Members' apps still reaching the community by a name it had before (lost-name L4), and what to do about it: the web
 * app there says where the community lives now; phone apps are moved by hand, so the owner tells those members.
 * Nothing on a node with no former names, or from a server too old to count them.
 */
function formerAppsText(report: AppAddressesReport): string | null {
    const f = report.formerApps;
    if (!f || !report.addresses.some((a) => a.former)) return null;
    if (f.busiestDay === 0) return 'No app reached this community by a name it had before this week.';
    const count = `${apps(f.today)} reached this community by a name it had before today (most in one day this week: ${f.busiestDay}).`;
    return report.primaryAddress
        ? `${count} The web app there tells its members the community has moved to ${report.primaryAddress}. Tell members on the phone app in a community post.`
        : count;
}

/** The directory's name for the community at an address, or words for one it gives no name. */
const listedName = (h: HeldBackAddress) => h.directory?.name || 'another community';

/** The node's answer, or null for anything else (an older server's page, a proxy's error page). */
function asReport(r: unknown): AppAddressesReport | null {
    const x = r as AppAddressesReport | null;
    return x && Array.isArray(x.addresses) && Array.isArray(x.unconfirmed) && x.oldApps && typeof x.oldApps === 'object' ? x : null;
}

export function formatSwitchDay(day: string | null): string {
    if (!day) return '';
    const t = Date.parse(`${day}T00:00:00Z`);
    return Number.isFinite(t) ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : day;
}

/** A host worth suggesting: not this machine and not a LAN address, which a node with no names accepts anyway. */
function offerable(host: string | null): host is string {
    if (!host) return false;
    if (host === 'localhost' || host.endsWith('.local') || host.startsWith('[')) return false;
    return !/^(10|127)\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^169\.254\./.test(host);
}

export function AppAddressesPanel({ activeNode }: { activeNode: NodeProfile }) {
    const [report, setReport] = useState<AppAddressesReport | null>(null);
    const [loadFailed, setLoadFailed] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    // The addresses the owner ticked as this community's: only then can one other than this page's be confirmed.
    const [sure, setSure] = useState<Record<string, boolean>>({});

    const load = useCallback(async () => {
        try {
            const got = asReport(await getAppAddresses(activeNode.url, activeNode.adminPassword, getTfaSessionToken(activeNode.id)));
            setReport(got);
            setLoadFailed(!got);
        } catch {
            setLoadFailed(true);
        }
    }, [activeNode.id, activeNode.url, activeNode.adminPassword]);

    useEffect(() => { void load(); }, [load]);

    const act = async (address: string, how: 'confirm' | 'remove') => {
        setBusy(address);
        setActionError(null);
        try {
            const call = how === 'confirm' ? confirmAppAddress : removeAppAddress;
            const got = asReport(await call(activeNode.url, address, activeNode.adminPassword, getTfaSessionToken(activeNode.id)));
            if (got) setReport(got); else await load();
        } catch (e) {
            setActionError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(null);
        }
    };

    // An older server without the route, or a moderator's session: say nothing rather than alarm.
    if (loadFailed || !report) return null;

    const known = new Set(report.addresses.map((a) => a.address));
    // A node whose only listed name is localhost (BEANPOOL_ADDRESSES, for an SSH tunnel) still knows none of its own.
    const named = report.named ?? report.addresses.length > 0;
    // Every address apps reached that isn't this community's yet. A server from before the guard offers them all in
    // `unconfirmed`: here they are held back all the same, and its beanpool.org ones never confirmed.
    const listed: HeldBackAddress[] = [
        ...report.unconfirmed.map((u) => ({ ...u, reason: isBeanPoolName(u.address) ? 'another-community' as const : 'not-this-page' as const })),
        ...(report.heldBack ?? []),
    ].filter((h) => !known.has(h.address));
    // This page's own address: the only one offered with one tap. The node says so by listing it in `unconfirmed` (it is
    // sent as ?host=, node-client.ts), or holds it back when the directory it holds lists it. A server from before the
    // guard can't say: this page suggests it itself, as it always did.
    const pageHost = audienceOf(activeNode.url);
    // A node with the guard decides which page hosts count as this community's (a public IPv6 address, a name such as
    // 10.example.org): take its word. Only for an older server does this page judge by itself (offerable).
    const pageOffered = !named && !!pageHost && !isBeanPoolName(pageHost) && !known.has(pageHost)
        && (Array.isArray(report.heldBack) ? report.unconfirmed.some((u) => u.address === pageHost) : offerable(pageHost));
    const pageSighting = pageOffered ? listed.find((h) => h.address === pageHost) : undefined;
    const others = listed.filter((h) => !(pageOffered && h.address === pageHost));
    // The ones an owner's or admin's app reached first, then the busiest.
    const toTick = others.filter((h) => h.reason === 'not-this-page')
        .sort((a, b) => Number(!!b.ownerOrAdmin) - Number(!!a.ownerOrAdmin) || b.busiestDay - a.busiestDay);
    const switchDay = formatSwitchDay(report.unboundSignaturesUntil);
    const formerLine = formerAppsText(report);
    const button = 'min-h-[44px] max-w-full break-words text-left px-4 py-2 rounded-xl text-sm font-semibold border transition-colors disabled:opacity-50';
    const confirmButton = `${button} bg-emerald-700 border-emerald-600 text-white hover:bg-emerald-600`;

    return (
        <div className="p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4" data-testid="app-addresses">
            <h3 className="text-base font-bold text-white m-0 flex items-center gap-2 break-words">🌐 Addresses members&apos; apps use</h3>
            <p className="text-sm text-nature-300 m-0 leading-relaxed">
                A member&apos;s app signs every request for the address it reaches this community at. This community
                accepts only the addresses below, so a request copied from another community can&apos;t be used here.
            </p>

            {!named && (
                <p className="text-sm text-amber-300 m-0 leading-relaxed" data-testid="app-addresses-none">
                    This community has no address set up yet
                    {report.unboundSignaturesAccepted ? `, so until ${switchDay} it accepts any address. After that it refuses addresses it doesn't know, so confirm yours below.` : ', so it refuses apps that reach it by name. Confirm its address below.'}
                </p>
            )}
            {report.addresses.length > 0 && (
                <ul className="m-0 p-0 list-none space-y-3">
                    {report.addresses.map((a) => (
                        <li key={a.address} className="text-sm text-nature-200 break-words" data-testid="app-address">
                            <strong className="text-white break-all">{a.address}</strong>
                            <span className="text-nature-400"> · {a.former ? 'a BeanPool name it had before, still accepted' : SOURCE_TEXT[a.source] ?? a.source}</span>
                            <span className="block text-xs text-nature-400">
                                used by {apps(a.today)} today · most in one day this week: {a.busiestDay}
                            </span>
                            {a.source === 'owner' && (
                                <button
                                    type="button"
                                    className={`${button} mt-2 bg-nature-950 border-nature-700 text-nature-200 hover:bg-nature-800`}
                                    disabled={busy !== null}
                                    onClick={() => act(a.address, 'remove')}
                                >
                                    Remove {a.address}
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            {formerLine && <p className="text-sm text-nature-300 m-0 leading-relaxed break-words" data-testid="former-apps">{formerLine}</p>}

            {pageOffered && pageHost && (
                <div className="p-3 rounded-xl bg-nature-950/60 border border-amber-700/60 space-y-2" data-testid="app-address-offer">
                    <p className="text-sm text-nature-200 m-0 break-words">{pageOfferText(pageHost, pageSighting)}</p>
                    <button type="button" className={confirmButton} disabled={busy !== null} onClick={() => act(pageHost, 'confirm')}>
                        Yes, {pageHost} is its address
                    </button>
                </div>
            )}

            {others.filter((h) => h.reason === 'another-community').map((h) => (
                <div key={h.address} className="p-3 rounded-xl bg-nature-950/60 border border-red-700/60 space-y-2" data-testid="app-address-held" data-reason={h.reason}>
                    <p className="text-sm text-nature-200 m-0 break-words">{reachedText(h)}</p>
                    <p className="text-sm text-red-300 m-0 break-words">
                        {h.address} is the name of another BeanPool community, so it isn&apos;t offered. Confirming it would let
                        what members&apos; apps send that community be copied and used here. If someone asked you to confirm it, don&apos;t.
                    </p>
                </div>
            ))}

            {others.filter((h) => h.reason === 'directory').map((h) => (
                <div key={h.address} className="p-3 rounded-xl bg-nature-950/60 border border-red-700/60 space-y-2" data-testid="app-address-held" data-reason={h.reason}>
                    <p className="text-sm text-nature-200 m-0 break-words">
                        {h.address === pageHost && h.busiestDay === 0 ? `This page reached the community at ${h.address}.` : reachedText(h)}
                    </p>
                    <p className="text-sm text-red-300 m-0 break-words">
                        The BeanPool directory lists {h.address} as the address of {listedName(h)}. Confirm it only if that is
                        this community: if it isn&apos;t, what members&apos; apps send {h.directory?.name || 'that community'} could be
                        copied and used here.
                    </p>
                    <label className="flex items-start gap-3 min-h-[44px] text-sm text-nature-200 break-words cursor-pointer">
                        <input
                            type="checkbox"
                            className="mt-0.5 h-5 w-5 shrink-0"
                            checked={!!sure[h.address]}
                            onChange={(e) => setSure((s) => ({ ...s, [h.address]: e.target.checked }))}
                        />
                        <span className="min-w-0 [overflow-wrap:anywhere]">{h.directory?.name ? `${h.directory.name} is this community` : 'That community is this one'}</span>
                    </label>
                    <button type="button" className={confirmButton} disabled={busy !== null || !sure[h.address]} onClick={() => act(h.address, 'confirm')}>
                        Yes, {h.address} is its address
                    </button>
                </div>
            ))}

            {toTick.length > 0 && (
                <p className="text-sm text-nature-300 m-0 leading-relaxed" data-testid="app-address-tick-note">
                    Only the address this page is open at is offered with one tap: a member&apos;s app can be made to use
                    any address. Tick another only if you know it is this community&apos;s.
                </p>
            )}
            {toTick.map((h) => (
                <div key={h.address} className="p-3 rounded-xl bg-nature-950/60 border border-nature-700 space-y-2" data-testid="app-address-held" data-reason={h.reason}>
                    <p className="text-sm text-nature-200 m-0 break-words">{reachedText(h)}</p>
                    <label className="flex items-start gap-3 min-h-[44px] text-sm text-nature-200 break-words cursor-pointer">
                        <input
                            type="checkbox"
                            className="mt-0.5 h-5 w-5 shrink-0"
                            checked={!!sure[h.address]}
                            onChange={(e) => setSure((s) => ({ ...s, [h.address]: e.target.checked }))}
                        />
                        <span className="min-w-0 [overflow-wrap:anywhere]">This is this community&apos;s address</span>
                    </label>
                    <button type="button" className={confirmButton} disabled={busy !== null || !sure[h.address]} onClick={() => act(h.address, 'confirm')}>
                        Yes, {h.address} is its address
                    </button>
                </div>
            ))}

            {actionError && <p className="text-sm text-red-300 m-0 break-words" role="alert">{actionError}</p>}

            <p className="text-sm text-nature-300 m-0 leading-relaxed" data-testid="old-apps">
                {report.unboundSignaturesAccepted
                    ? (report.oldApps.busiestDay > 0
                        ? `${apps(report.oldApps.today)} too old to name this community reached it today (most in one day this week: ${report.oldApps.busiestDay}). From ${switchDay} this community refuses apps that old, and their members see a message asking them to update BeanPool.`
                        : `No app too old to name this community reached it this week. From ${switchDay} such apps are refused here.`)
                    : 'Apps too old to name this community are refused here. Members using one see a message asking them to update BeanPool.'}
            </p>
        </div>
    );
}
