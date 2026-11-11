/**
 * Settings → Node Identity → "The listing promise" (Mothership A3; design scratch/global-node/DESIGN-global-mothership-fable.md
 * §1.2, the server side is A2: apps/server engine/directory-promise.ts, routes/settings.ts). Four lines a community in the public
 * directory makes to the strangers the directory sends to it, and the day it says it closes:
 *
 *   Two owners                              measured by the node (shown, never ticked)
 *   A recovery code and backups             measured by the node (shown, never ticked)
 *   We look at reports within a week        ticked by an owner
 *   If we close, members get thirty days' notice   ticked by an owner
 *   Closing on <date>                       an owner's day, shown on the Find card; the community leaves the directory that day
 *
 * The node re-measures the two measured lines at every push and leaves the promise out of its row when one fails, so the
 * headline here is the node's own word (`kept`), never worked out in this panel. The read is GET and the change POST
 * /api/local/admin/directory/promise; the change is an owner's, so anyone else reads it with the boxes closed.
 * Nothing here gates anything: the community is listed either way, and the promise only orders the list for people nearby.
 * Operators' Settings is English for launch (lib/fresh-proof); the sentences go through t() so a catalog can come later.
 */
import React, { useCallback, useEffect, useState } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { nodeCredential } from '../../lib/profiles';
import { buildAdminHeaders, resolveNodeApiUrl } from '../../lib/node-client';
import { t } from '../../lib/fresh-proof';
import type { RolesViewer } from './NodeRolesPanel';

/** The most days ahead the node takes for a closing day (apps/server engine/directory-cache.ts MAX_CLOSING_DAYS). */
export const MAX_CLOSING_DAYS = 400;

/** What the node says about the promise (apps/server services/directory-publisher.ts DirectoryPromiseDiagnostics). */
export interface PromiseStatus {
    kept: boolean;
    owners: number;
    backupsLocked: boolean;
    backupsRunning: boolean;
    reports: boolean;
    notice: boolean;
    closingOn: string | null;
}

/** A node's answer to the read and to the change: `promise` is null where nothing is pushed (a standby, Listed off). */
export function readPromise(body: unknown): { ok: true; promise: PromiseStatus | null } | { ok: false } {
    if (!body || typeof body !== 'object' || !('promise' in body)) return { ok: false };
    const p = (body as { promise: unknown }).promise;
    if (p === null) return { ok: true, promise: null };
    if (!p || typeof p !== 'object') return { ok: false };
    const o = p as Record<string, unknown>;
    if (typeof o.kept !== 'boolean' || typeof o.owners !== 'number' || typeof o.backupsLocked !== 'boolean' || typeof o.backupsRunning !== 'boolean'
        || typeof o.reports !== 'boolean' || typeof o.notice !== 'boolean') return { ok: false };
    return {
        ok: true,
        promise: {
            kept: o.kept, owners: o.owners, backupsLocked: o.backupsLocked, backupsRunning: o.backupsRunning,
            reports: o.reports, notice: o.notice, closingOn: typeof o.closingOn === 'string' ? o.closingOn : null,
        },
    };
}

/** A day (YYYY-MM-DD) as the owner reads it, in the browser's language; the day itself, whatever the zone. */
export function dayText(day: string | null): string {
    const m = day ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(day) : null;
    if (!m) return '';
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Today, and the last day the node takes, as the date box writes them: the node's own (UTC) day, not the browser's, so the
 * box never offers a day the node refuses as already past (a browser west of UTC late in its day).
 */
export function dayBounds(now: number = Date.now()): { min: string; max: string } {
    const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    return { min: iso(now), max: iso(now + (MAX_CLOSING_DAYS - 1) * 86_400_000) };
}

type Message = { text: string; type: 'success' | 'error' };

export function ListingPromisePanel({ activeNode, viewer = { kind: 'token' } }: { activeNode: NodeProfile; viewer?: RolesViewer }) {
    const isOwner = viewer.kind === 'token' || viewer.role === 'owner';
    const [load, setLoad] = useState<'loading' | 'loaded' | 'failed'>('loading');
    const [promise, setPromise] = useState<PromiseStatus | null>(null);
    const [reports, setReports] = useState(false);
    const [notice, setNotice] = useState(false);
    const [closingOn, setClosingOn] = useState('');
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<Message | null>(null);

    const take = useCallback((p: PromiseStatus | null) => {
        setPromise(p);
        if (p) { setReports(p.reports); setNotice(p.notice); setClosingOn(p.closingOn ?? ''); }
    }, []);

    useEffect(() => {
        let mounted = true;
        setLoad('loading');
        (async () => {
            try {
                const res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/local/admin/directory/promise'), {
                    headers: buildAdminHeaders(nodeCredential(activeNode)),
                    cache: 'no-store',
                });
                const read = res.ok ? readPromise(await res.json().catch(() => null)) : ({ ok: false } as const);
                if (!mounted) return;
                if (read.ok) { take(read.promise); setLoad('loaded'); } else setLoad('failed');
            } catch {
                if (mounted) setLoad('failed');
            }
        })();
        return () => { mounted = false; };
    }, [activeNode, take]);

    const changed = !!promise && (reports !== promise.reports || notice !== promise.notice || closingOn !== (promise.closingOn ?? ''));

    const save = async () => {
        if (!promise) return;
        setSaving(true);
        setMessage(null);
        try {
            // The day only when it changed: the node refuses a day already past, and one kept unchanged must not be re-sent.
            const body = {
                
                reports,
                notice,
                ...(closingOn !== (promise.closingOn ?? '') ? { closingOn: closingOn || null } : {}),
            };
            const res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/local/admin/directory/promise'), {
                method: 'POST',
                headers: buildAdminHeaders(nodeCredential(activeNode)),
                body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({}));
            const read = res.ok ? readPromise(data) : ({ ok: false } as const);
            if (read.ok && read.promise) {
                take(read.promise);
                setMessage({ text: t('Saved. The directory shows it at the next update.'), type: 'success' });
            } else {
                setMessage({ text: typeof data?.error === 'string' && data.error ? data.error : t('The promise was not saved. Try again in a minute.'), type: 'error' });
            }
        } catch {
            setMessage({ text: t('The promise was not saved. Try again in a minute.'), type: 'error' });
        } finally {
            setSaving(false);
        }
    };

    const bounds = dayBounds();
    const closed = !isOwner || saving;
    const measured = (ok: boolean, name: string, detail: string, testId: string) => (
        <li data-testid={testId} className="flex items-start gap-2.5 min-w-0">
            <span aria-hidden="true" className={`mt-0.5 text-sm ${ok ? 'text-bp-ink-success' : 'text-bp-ink-warning'}`}>{ok ? '✓' : '○'}</span>
            <span className="min-w-0 text-xs text-nature-300 leading-relaxed break-words">
                <span className="sr-only">{ok ? t('Kept.') : t('Not yet.')}{' '}</span>
                <strong className="text-white">{name}</strong>
                {' · '}{detail}
            </span>
        </li>
    );

    return (
        <div data-testid="listing-promise" className="space-y-4 max-w-2xl">
            <div className="pt-6 border-t border-nature-800/80 space-y-4">
                <div>
                    <h4 className="text-sm font-bold text-white m-0">{t('The listing promise')}</h4>
                    <p className="text-xs text-nature-400 mt-0.5 m-0 leading-relaxed">
                        {t('Four lines your community makes to the people the directory sends you. The first two are measured by this server; the other two are your word.')}
                    </p>
                </div>

                {load === 'loading' && <p role="status" className="text-xs text-nature-400 m-0">{t('Reading the promise from the node…')}</p>}
                {load === 'failed' && (
                    <p data-testid="listing-promise-failed" role="status" className="text-xs text-bp-ink-warning m-0 leading-normal">
                        {t("Couldn't read the listing promise from the node. Reload to try again.")}
                    </p>
                )}
                {load === 'loaded' && !promise && (
                    <p data-testid="listing-promise-unpublished" role="status" className="text-xs text-nature-400 m-0 leading-relaxed">
                        {t('This community is not published to the directory from here (it is a standby, or Listed is off), so the promise has nothing to show yet.')}
                    </p>
                )}

                {load === 'loaded' && promise && (
                    <>
                        <p data-testid="listing-promise-headline" className={`text-sm font-bold m-0 ${promise.kept ? 'text-bp-ink-success' : 'text-nature-300'}`}>
                            {promise.kept ? t('Keeps the listing promise') : t('New listing')}
                        </p>
                        <ul className="list-none p-0 m-0 space-y-2.5">
                            {measured(
                                promise.owners >= 2,
                                t('Two owners'),
                                promise.owners >= 2
                                    ? t('{n} owners act for this community.', { n: promise.owners })
                                    : t('Make a second person an owner under Owners & admins.'),
                                'listing-promise-owners',
                            )}
                            {measured(
                                promise.backupsLocked && promise.backupsRunning,
                                t('A recovery code and backups'),
                                !promise.backupsLocked
                                    ? t('Make a recovery code first, under Backups & Restore.')
                                    : !promise.backupsRunning
                                        ? t('Turn scheduled snapshots on, or add an off-box destination, under Backups & Restore.')
                                        : t('Backups are locked to a recovery code and running.'),
                                'listing-promise-backups',
                            )}
                        </ul>

                        <div className="space-y-2.5">
                            <label className="flex items-start gap-2.5 text-xs font-bold text-white cursor-pointer select-none min-h-[48px] lg:min-h-0">
                                <input
                                    type="checkbox"
                                    data-testid="listing-promise-reports"
                                    checked={reports}
                                    disabled={closed}
                                    onChange={(e) => setReports(e.target.checked)}
                                    className="mt-0.5 rounded border-nature-700 bg-nature-950 accent-terra-500 disabled:opacity-50"
                                />
                                <span className="min-w-0 break-words">{t('We look at reports within a week')}</span>
                            </label>
                            <label className="flex items-start gap-2.5 text-xs font-bold text-white cursor-pointer select-none min-h-[48px] lg:min-h-0">
                                <input
                                    type="checkbox"
                                    data-testid="listing-promise-notice"
                                    checked={notice}
                                    disabled={closed}
                                    onChange={(e) => setNotice(e.target.checked)}
                                    className="mt-0.5 rounded border-nature-700 bg-nature-950 accent-terra-500 disabled:opacity-50"
                                />
                                <span className="min-w-0 break-words">{t("If we close, members get thirty days' notice")}</span>
                            </label>
                        </div>

                        <div>
                            <label htmlFor="listing-promise-closing" className="block text-xs font-bold text-nature-300 mb-1">{t('Closing on (only if you have a day)')}</label>
                            <div className="flex flex-wrap items-center gap-2">
                                <input
                                    id="listing-promise-closing"
                                    type="date"
                                    data-testid="listing-promise-closing"
                                    value={closingOn}
                                    min={bounds.min}
                                    max={bounds.max}
                                    disabled={closed}
                                    onChange={(e) => setClosingOn(e.target.value)}
                                    className="bg-nature-950 border border-nature-700 text-white rounded-xl px-3 py-1.5 text-xs focus:outline-none focus:border-terra-500 disabled:opacity-50"
                                />
                                {closingOn !== '' && !closed && (
                                    <button
                                        type="button"
                                        data-testid="listing-promise-clear-day"
                                        onClick={() => setClosingOn('')}
                                        className="px-3 py-1.5 rounded-xl bg-nature-800 hover:bg-nature-700 border border-nature-700 text-xs font-bold text-white min-h-[48px] lg:min-h-0"
                                    >
                                        {t('Clear the day')}
                                    </button>
                                )}
                            </div>
                            <p className="text-[11px] text-nature-400 mt-1 m-0 leading-normal">
                                {closingOn
                                    ? t('Your card says "Closing on {date}". This community leaves the directory that day.', { date: dayText(closingOn) })
                                    : t('Leave it empty unless you know the day. It appears on your card, and this community leaves the directory that day.')}
                            </p>
                        </div>

                        {!isOwner && (
                            <p data-testid="listing-promise-owner-only" className="text-xs text-nature-400 m-0 leading-normal">
                                {t('Only an owner can make or change the promise.')}
                            </p>
                        )}
                        {isOwner && (
                            <button
                                type="button"
                                data-testid="listing-promise-save"
                                onClick={save}
                                disabled={saving || !changed}
                                className="px-4 py-2 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-xs font-bold text-bp-cta-on transition-all disabled:opacity-50 min-h-[48px] lg:min-h-0"
                            >
                                {saving ? t('Saving…') : t('Save the promise')}
                            </button>
                        )}
                        {message && (
                            <p data-testid="listing-promise-message" role="status" className={`text-xs m-0 break-words ${message.type === 'success' ? 'text-bp-ink-success' : 'text-bp-ink-danger'}`}>
                                {message.text}
                            </p>
                        )}
                        <p className="text-[11px] text-nature-400 m-0 leading-normal">
                            {t('Your community is listed either way. The promise only moves you up the list for people nearby.')}
                        </p>
                    </>
                )}
            </div>
        </div>
    );
}
