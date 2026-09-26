/**
 * Network → "Addresses members' apps use" (request binding).
 *
 * A member's app signs every request for the address it reaches the community at, and the node accepts only its own
 * addresses, so a request someone copied from another community can't be used here (apps/server
 * engine/own-addresses.ts, engine/member-signature.ts). This lists those addresses with where each comes from and how
 * many apps used it; offers, with one tap, to confirm an address the node doesn't know (a self-hoster's custom domain
 * behind a proxy); and says how many apps too old to name a community still reach it before the switch date.
 *
 * An owner or admin confirms; nothing here is ever learned from a request by itself.
 */
import { useCallback, useEffect, useState } from 'react';
import { audienceOf } from '@beanpool/core';
import type { NodeProfile } from '../../lib/profiles';
import {
    confirmAppAddress, getAppAddresses, getTfaSessionToken, removeAppAddress,
    type AppAddress, type AppAddressesReport,
} from '../../lib/node-client';

const SOURCE_TEXT: Record<AppAddress['source'], string> = {
    'public-address': "this community's web address",
    env: 'set on the server (BEANPOOL_ADDRESSES)',
    owner: 'confirmed in Settings',
    registrar: 'its BeanPool name',
};

const apps = (n: number) => `${n} app${n === 1 ? '' : 's'}`;

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

/** A host worth offering: not this machine and not a LAN address, which a node with no names accepts anyway. */
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
    const pageHost = audienceOf(activeNode.url);
    const suggestPage = report.addresses.length === 0 && offerable(pageHost) && !report.unconfirmed.some((u) => u.address === pageHost);
    const switchDay = formatSwitchDay(report.unboundSignaturesUntil);
    const button = 'min-h-[44px] px-4 py-2 rounded-xl text-sm font-semibold border transition-colors disabled:opacity-50';

    return (
        <div className="p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4" data-testid="app-addresses">
            <h3 className="text-base font-bold text-white m-0 flex items-center gap-2 break-words">🌐 Addresses members&apos; apps use</h3>
            <p className="text-sm text-nature-300 m-0 leading-relaxed">
                A member&apos;s app signs every request for the address it reaches this community at. This community
                accepts only the addresses below, so a request copied from another community can&apos;t be used here.
            </p>

            {report.addresses.length === 0 ? (
                <p className="text-sm text-amber-300 m-0 leading-relaxed" data-testid="app-addresses-none">
                    This community has no address set up yet
                    {report.unboundSignaturesAccepted ? `, so until ${switchDay} it accepts any address. After that it refuses addresses it doesn't know, so confirm yours below.` : ', so it refuses apps that reach it by name. Confirm its address below.'}
                </p>
            ) : (
                <ul className="m-0 p-0 list-none space-y-3">
                    {report.addresses.map((a) => (
                        <li key={a.address} className="text-sm text-nature-200 break-words" data-testid="app-address">
                            <strong className="text-white break-all">{a.address}</strong>
                            <span className="text-nature-400"> · {SOURCE_TEXT[a.source] ?? a.source}</span>
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

            {[
                ...report.unconfirmed.filter((u) => !known.has(u.address)).map((u) => ({
                    address: u.address,
                    text: `BeanPool apps reached this community at ${u.address} (${apps(u.busiestDay)} on the busiest day this week). Is that its address?`,
                })),
                ...(suggestPage && pageHost ? [{ address: pageHost, text: `This page reached the community at ${pageHost}. Is that the address members' apps use?` }] : []),
            ].map((offer) => (
                <div key={offer.address} className="p-3 rounded-xl bg-nature-950/60 border border-amber-700/60 space-y-2" data-testid="app-address-offer">
                    <p className="text-sm text-nature-200 m-0 break-words">{offer.text}</p>
                    <button
                        type="button"
                        className={`${button} bg-emerald-700 border-emerald-600 text-white hover:bg-emerald-600`}
                        disabled={busy !== null}
                        onClick={() => act(offer.address, 'confirm')}
                    >
                        Yes, {offer.address} is its address
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
