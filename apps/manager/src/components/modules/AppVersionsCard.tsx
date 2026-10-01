import React, { useEffect, useState } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { fetchAppVersions, getTfaSessionToken, type AppPlatformVersions, type AppVersionsResponse } from '../../lib/node-client';

/**
 * The phone app's versions in this community, and each platform's floor (server routes/admin.ts app-versions): so an
 * operator can see whom raising a floor would stop before raising it. Counts only, never who (server
 * app-version-counts.ts). The floor itself is set on the server (MIN_APP_VERSION_IOS / _ANDROID, MIN_APP_VERSION_FROM):
 * the manual's "Raising the app's floor" says how, safely.
 */

/** Whether dotted version `a` is older than `b`, segment by segment ("1.2.9" < "1.2.10"). The node sends only clean versions. */
function isVersionOlder(a: string, b: string): boolean {
    const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
    const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
    }
    return false;
}

const PLATFORMS = [
    { key: 'android', label: 'Android', store: 'Google Play' },
    { key: 'ios', label: 'iPhone', store: 'the App Store' },
] as const;

function dateLabel(iso: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

const members = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'member' : 'members'}`;

/** One sentence: what this platform's floor does right now. */
function floorStatus(p: AppPlatformVersions, store: string): string {
    if (p.fromInvalid) {
        return `Floor ${p.floor}. The grace date set on the server isn't a date, so no app is stopped until it is fixed.`;
    }
    if (!p.store) {
        return `Floor ${p.floor}, not enforced yet: this server hasn't read ${store}'s version. No app is stopped until it has.`;
    }
    if (p.held) {
        return `Floor ${p.floor} is waiting for ${store}, which has ${p.store}. No app is stopped until ${store} has ${p.floor}.`;
    }
    if (!p.blocking && p.from) {
        return `Floor ${p.floor}. Apps below it show a banner now, and stop at their next start from ${dateLabel(p.from)}.`;
    }
    return `Floor ${p.floor}. Apps below it stop at their next start, or after five minutes away, until they update.`;
}

function PlatformBlock({ p, label, store }: { p: AppPlatformVersions; label: string; store: string }) {
    const total = p.versions.reduce((sum, v) => sum + v.members, 0);
    const below = p.versions.filter((v) => isVersionOlder(v.version, p.floor)).reduce((sum, v) => sum + v.members, 0);
    return (
        <div data-testid={`app-versions-${label.toLowerCase()}`} className="min-w-0">
            <h4 className="text-sm font-bold text-white m-0 mb-1">{label}</h4>
            <p className="text-xs text-nature-300 m-0 mb-2">{floorStatus(p, store)}</p>
            {p.store && <p className="text-xs text-nature-400 m-0 mb-2">{store} has {p.store}.</p>}
            {total === 0 ? (
                <p className="text-xs text-nature-400 m-0">No {label} app has said its version yet.</p>
            ) : (
                <>
                    <p data-testid={`app-versions-${label.toLowerCase()}-below`} className="text-xs text-nature-300 m-0 mb-1">
                        <strong className="text-white">{members(below)}</strong> of {total.toLocaleString()} below {p.floor}
                    </p>
                    <table className="w-full text-xs text-nature-300">
                        <thead>
                            <tr className="text-nature-400 text-left">
                                <th scope="col" className="font-bold py-1 pr-2">Version</th>
                                <th scope="col" className="font-bold py-1 text-right">Members</th>
                            </tr>
                        </thead>
                        <tbody>
                            {p.versions.map((v) => {
                                const isBelow = isVersionOlder(v.version, p.floor);
                                return (
                                    <tr key={v.version} className="border-t border-nature-800">
                                        <td className="py-1 pr-2 tabular-nums">
                                            {v.version}
                                            {isBelow && <span className="text-amber-300"> · below the floor</span>}
                                        </td>
                                        <td className="py-1 text-right tabular-nums">{v.members.toLocaleString()}</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </>
            )}
        </div>
    );
}

export function AppVersionsCard({ node }: { node: NodeProfile }) {
    const [data, setData] = useState<AppVersionsResponse | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        // Cleared first, so one node's numbers never show under another's name while the next loads.
        setData(null);
        setError(null);
        fetchAppVersions(node.url, node.adminPassword, getTfaSessionToken(node.id))
            .then((res) => {
                if (cancelled) return;
                // Anything but the shape this card reads (a proxy's page, a build that answers something else) is said in
                // words, never read: a missing field here took the whole Home section down.
                if (!res || typeof res !== 'object' || !res.platforms || typeof res.platforms !== 'object') {
                    setError("This node's build doesn't count app versions yet. Update it to see them.");
                    return;
                }
                setData(res);
            })
            .catch((e) => { if (!cancelled) setError(e?.message || 'Could not reach this node'); });
        return () => { cancelled = true; };
    }, [node.id, node.url, node.adminPassword]);

    return (
        <section
            data-testid="app-versions-card"
            aria-labelledby="app-versions-title"
            className="bg-nature-900/60 border border-nature-800 rounded-2xl p-5 shadow-lg"
            style={{ overflowWrap: 'anywhere' }}
        >
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 mb-3">
                <h3 id="app-versions-title" className="text-xs font-bold uppercase tracking-wider text-nature-400 m-0 flex items-center gap-2">
                    <span aria-hidden="true">📱</span>
                    <span>Phone app versions</span>
                </h3>
                {data && <span className="text-xs text-nature-400">Members seen since {dateLabel(data.since)}</span>}
            </div>

            {error ? (
                <p role="alert" className="text-sm text-amber-300 m-0">{error}</p>
            ) : !data ? (
                <p className="text-sm text-nature-400 m-0">Counting…</p>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                    {PLATFORMS.filter((pl) => Array.isArray(data.platforms[pl.key]?.versions)).map((pl) => (
                        <PlatformBlock key={pl.key} p={data.platforms[pl.key]} label={pl.label} store={pl.store} />
                    ))}
                </div>
            )}

            <p className="text-xs text-nature-400 m-0 mt-3">
                Counted by this server from the app's own requests: how many members (and visitors) run each version, never who, and
                kept only until the server restarts. Apps from before the full-screen update don't say their version, so
                they aren't counted: no floor can stop them, they show a banner only.
            </p>
        </section>
    );
}
