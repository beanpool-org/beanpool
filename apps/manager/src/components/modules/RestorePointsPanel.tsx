import React, { useCallback, useEffect, useState } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { nodeCredential } from '../../lib/profiles';
import { resolveNodeApiUrl, buildAdminHeaders, getTfaSessionToken, passwordField } from '../../lib/node-client';
import { rollBackDoneWords } from '../../lib/restore-words';
import type { RolesViewer } from './NodeRolesPanel';

/**
 * Restore points (design case 18 §3.3): the server keeps one before every restore and every roll-back, under
 * data/restore-points, and no route deletes one or changes how long it is kept (the newest 5, none younger than 7 days
 * pruned, none older than 30 kept). This card lists them, read-only (when, why, size, kept until), and offers
 * Roll back, which the server takes from an owner with a fresh proof, every time (a current authenticator code on the
 * password path; Manage pressed within 90 seconds on the phone). The server answers anyone else 403, so the card draws
 * nothing for an admin.
 */

export interface RestorePointInfo {
    name: string;
    why: 'restore' | 'roll-back';
    takenAt: string;
    bytes: number;
    keptAtLeastUntil: string;
    keptAtMostUntil: string;
}

function when(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function dateOnly(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

function size(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const WHY: Record<RestorePointInfo['why'], string> = {
    restore: 'Kept before a restore',
    'roll-back': 'Kept before a roll-back',
};

const BTN = 'min-h-[48px] px-4 py-2 rounded-xl text-sm font-bold transition-all disabled:opacity-50';

export function RestorePointsPanel({ activeNode, viewer = { kind: 'password' } }: { activeNode: NodeProfile; viewer?: RolesViewer }) {
    const isOwner = viewer.kind === 'password' || viewer.role === 'owner';
    const [points, setPoints] = useState<RestorePointInfo[] | null>(null);
    const [listMessage, setListMessage] = useState('');
    const [chosen, setChosen] = useState<RestorePointInfo | null>(null);
    const [code, setCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<string | null>(null);

    const headers = useCallback(
        () => buildAdminHeaders(nodeCredential(activeNode), getTfaSessionToken(activeNode.id)),
        [nodeCredential(activeNode), activeNode.id],
    );

    const load = useCallback(async () => {
        try {
            const res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/local/admin/restore-points'), {
                method: 'GET', headers: headers(), credentials: 'same-origin',
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                setPoints(Array.isArray(data.points) ? data.points as RestorePointInfo[] : []);
                setListMessage('');
            } else {
                setPoints(null);
                setListMessage(`The restore points could not be listed: ${data.error || `HTTP ${res.status}`}`);
            }
        } catch (e: unknown) {
            setPoints(null);
            setListMessage(`The restore points could not be listed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }, [activeNode.url, headers]);

    useEffect(() => {
        if (!isOwner) return;
        void load();
    }, [isOwner, load]);

    // A different node: nothing of the last one's step stays.
    useEffect(() => {
        setChosen(null);
        setCode('');
        setError(null);
        setDone(null);
    }, [activeNode.id]);

    if (!isOwner) return null;

    const open = (p: RestorePointInfo) => {
        setChosen(p);
        setCode('');
        setError(null);
        setDone(null);
    };

    const rollBack = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!chosen) return;
        setBusy(true);
        setError(null);
        try {
            const body: Record<string, unknown> = { ...passwordField(nodeCredential(activeNode)), name: chosen.name };
            if (code.trim()) body.code = code.trim();
            const res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/local/admin/restore-points/roll-back'), {
                method: 'POST', headers: headers(), credentials: 'same-origin', body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                setDone(rollBackDoneWords(data, when(chosen.takenAt)));
                setChosen(null);
                setCode('');
            } else {
                // The server's own words: "Enter a current code…", "Press Manage on your phone again…", "Do this from
                // your phone…", or why the point could not be used. Nothing was changed.
                setError(typeof data.error === 'string' ? data.error : `The server answered HTTP ${res.status}.`);
            }
        } catch (err: unknown) {
            setError(`The server did not answer: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4 min-w-0" data-testid="restore-points-card" style={{ overflowWrap: 'anywhere' }}>
            <div className="min-w-0">
                <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                    <span>⏪</span>
                    <span className="min-w-0 break-words">Restore points</span>
                </h3>
                <p className="text-xs text-nature-400 m-0 mt-1">
                    The server keeps a copy of itself before every restore and every roll-back. Nobody can delete one from here:
                    the newest 5 are kept, none is removed before it is 7 days old, and none is kept past 30 days. On the server:{' '}
                    <code className="font-mono">beanpool restore-point list</code>.
                </p>
            </div>

            {done && <div role="status" className="p-3 rounded-xl bg-nature-950 border border-terra-500/50 text-xs text-bp-ink-terra">{done}</div>}
            {listMessage && <p className="m-0 text-xs text-red-300" role="alert">{listMessage}</p>}

            {points && points.length === 0 && (
                <p className="m-0 text-xs text-nature-400">No restore points yet. One is taken before every restore and roll-back.</p>
            )}

            {points && points.length > 0 && (
                <ul className="m-0 p-0 list-none space-y-2" aria-label="Restore points">
                    {points.map((p) => (
                        <li key={p.name} className="p-3.5 rounded-xl bg-nature-950 border border-nature-800 text-xs space-y-2" data-testid="restore-point">
                            <div className="min-w-0">
                                <div className="font-bold text-white">{when(p.takenAt)}</div>
                                <div className="text-nature-300 mt-0.5">{WHY[p.why] ?? p.why} · {size(p.bytes)} · kept until at least {dateOnly(p.keptAtLeastUntil)}</div>
                                <div className="text-[11px] text-nature-400 font-mono mt-0.5">{p.name}</div>
                            </div>
                            {chosen?.name === p.name ? (
                                <form onSubmit={rollBack} className="space-y-2" data-testid="roll-back-step">
                                    <p className="m-0 text-white font-bold">Roll back to {when(p.takenAt)}?</p>
                                    <p className="m-0 text-nature-200">
                                        Everything on this server since then is replaced by this point's copy: the database, its photos and
                                        the server's keys and settings. A restore point of the server as it is now is taken first, so this
                                        can be undone the same way. The server restarts after; sign in again.
                                    </p>
                                    {/* TODO(S4a): switch this field to S4a's shared fresh-proof component (its brief, item 1: the code
                                        field for a password viewer, "press Manage again" / "from your phone" for a key viewer). Until
                                        then: the code field for a password viewer, and the server's own words for every refusal. */}
                                    {viewer.kind === 'password' ? (
                                        <>
                                            <label htmlFor={`roll-back-code-${p.name}`} className="block text-nature-200">
                                                A current code from your authenticator app (or a backup code):
                                            </label>
                                            <input id={`roll-back-code-${p.name}`} type="text" inputMode="numeric" autoComplete="one-time-code" value={code}
                                                onChange={(e) => setCode(e.target.value)} spellCheck={false}
                                                className="w-full min-w-0 min-h-[48px] bg-nature-950 border border-nature-700 rounded-xl px-3 py-2 text-sm text-white font-mono" />
                                        </>
                                    ) : (
                                        <p className="m-0 text-nature-200">From your phone: press Manage again, then roll back within 90 seconds.</p>
                                    )}
                                    {error && <div role="alert" className="p-3 rounded-xl bg-red-950/80 border border-red-800 text-red-200">{error}</div>}
                                    <div className="flex flex-wrap gap-2">
                                        <button type="submit" disabled={busy || (viewer.kind === 'password' && !code.trim())}
                                            className={`${BTN} flex-1 bg-bp-danger-fill hover:bg-bp-danger-hover text-bp-danger-on border border-bp-danger-fill`}>
                                            {busy ? 'Rolling back…' : 'Roll back'}
                                        </button>
                                        <button type="button" onClick={() => setChosen(null)} disabled={busy} className={`${BTN} flex-1 bg-nature-800 hover:bg-nature-700 text-white`}>
                                            Cancel
                                        </button>
                                    </div>
                                </form>
                            ) : (
                                <button type="button" onClick={() => open(p)} className={`${BTN} w-full sm:w-auto bg-nature-800 hover:bg-nature-700 text-white border border-nature-700`}>
                                    Roll back to this point
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
