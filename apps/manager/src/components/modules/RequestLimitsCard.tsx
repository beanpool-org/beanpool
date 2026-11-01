import React, { useCallback, useEffect, useState } from 'react';
import { fetchRequestLimits, undoRequestLimit, type RequestLimitHow, type RequestLimitRow } from '../../lib/node-client';

/**
 * Who can't send message requests for now (server: engine/request-limits.ts): reports from the people they wrote to cleared
 * their requests, with no moderator needed. This is where a moderator sees that and can undo it: their requests come back and
 * they can send new ones. Not a pause: they can still answer people who wrote to them, and post. The reports themselves stay
 * in the queue. Nothing at all when nobody is limited.
 */

export interface RequestLimitsCardProps {
    nodeUrl: string;
    adminPassword?: string;
    tfaToken?: string;
    /** Changes when something was done elsewhere, so the list loads again. */
    reloadKey?: number;
}

const WHY: Record<RequestLimitHow, string> = {
    same_wording: 'Two people reported the same words.',
    many_reports: 'Three people reported their requests.',
    words_newcomer: 'Someone they wrote to reported them, on a new account made with 12 words.',
};

const day = (iso: string) => {
    const t = new Date(iso);
    return Number.isNaN(t.getTime()) ? iso : t.toLocaleDateString(undefined, { dateStyle: 'medium' });
};

const btn = 'min-h-[48px] px-4 rounded-xl text-sm font-bold transition-colors disabled:opacity-50';

export function RequestLimitsCard({ nodeUrl, adminPassword, tfaToken, reloadKey = 0 }: RequestLimitsCardProps) {
    const [limits, setLimits] = useState<RequestLimitRow[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            setLimits(await fetchRequestLimits(nodeUrl, adminPassword, tfaToken));
            setError(null);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : 'Could not load who is limited');
        }
    }, [nodeUrl, adminPassword, tfaToken]);

    useEffect(() => { void load(); }, [load, reloadKey]);

    const undo = async (limit: RequestLimitRow) => {
        setBusy(limit.publicKey);
        setError(null);
        try {
            await undoRequestLimit(nodeUrl, limit.publicKey, adminPassword, tfaToken);
            setNote(`${limit.callsign || 'They'} can send message requests again, and the ones cleared are back.`);
            await load();
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : 'That did not work');
        } finally {
            setBusy(null);
        }
    };

    if (error && !limits) return <p role="alert" className="text-sm font-semibold text-red-300 m-0">{error}</p>;
    if (!note && !error && (!limits || limits.length === 0)) return null;

    return (
        <section aria-label="Message requests cleared by reports" data-testid="request-limits"
            className="p-4 rounded-2xl bg-nature-900/80 border border-nature-800 space-y-3 break-words">
            <h2 className="text-base font-bold text-white m-0">Message requests cleared by reports</h2>
            <p className="text-sm text-nature-300 m-0">
                Enough people reported these members&apos; message requests, so the requests left everyone&apos;s list and they can&apos;t
                send new ones for now. They can still answer people who wrote to them, and post. Undo brings their requests back.
                Their reports stay in the queue.
            </p>
            {error && <p role="alert" className="text-sm font-semibold text-red-300 m-0">{error}</p>}
            {note && <p role="status" className="text-sm font-semibold text-emerald-300 m-0">{note}</p>}
            {limits && limits.length > 0 && (
                <ul className="list-none p-0 m-0 space-y-2">
                    {limits.map(limit => (
                        <li key={limit.id} data-testid="request-limit" className="flex flex-wrap items-center gap-2 p-3 rounded-xl bg-nature-950 border border-nature-800">
                            <p className="text-sm text-nature-100 m-0 flex-1 min-w-0">
                                <span className="font-bold">{limit.callsign || limit.publicKey.slice(0, 12)}</span>
                                {' '}{WHY[limit.how]} Until {day(limit.until)}.
                            </p>
                            <button type="button" disabled={busy !== null} onClick={() => void undo(limit)}
                                className={`${btn} bg-nature-800 hover:bg-nature-700 text-white`}>
                                {busy === limit.publicKey ? 'Undoing…' : 'Undo'}
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
