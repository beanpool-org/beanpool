/**
 * Settings → Shared outside (front doors S6, scratch/fable-design/DESIGN-entry-points-fable.md §3.4): the links this
 * member shared outside the community that still open their post, each with when it stops, and Stop sharing. Read from
 * the node (lib/peek.ts getPeekShares), so the phone and the web list the same links. Shown only where the community
 * lets members share outside (`features.shareOutside`): turned off, every link has stopped and there is nothing to list.
 */
import { useCallback, useEffect, useState } from 'react';
import { PEEK_WORDS as W, formatDate, t, type PeekShare } from '@beanpool/core';
import { useCommunityInfo } from '../lib/features';
import { getPeekShares, stopPeekShare } from '../lib/peek';

export function SharedOutsideSection() {
    const info = useCommunityInfo();
    const on = info?.features?.shareOutside === true;
    const [open, setOpen] = useState(false);
    const [shares, setShares] = useState<PeekShare[] | 'loading' | 'failed'>('loading');
    const [stopping, setStopping] = useState<string | null>(null);
    const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);

    const load = useCallback(() => {
        setShares('loading');
        getPeekShares().then(setShares, () => setShares('failed'));
    }, []);
    useEffect(() => { if (on && open) load(); }, [on, open, load]);
    if (!on) return null;

    const stop = async (id: string) => {
        setStopping(id);
        setNote(null);
        try {
            await stopPeekShare(id);
            setShares(prev => (Array.isArray(prev) ? prev.filter(s => s.id !== id) : prev));
            setNote({ text: t(W.stoppedNow), ok: true });
        } catch (e) {
            setNote({ text: (e as Error)?.message || t('Request failed'), ok: false });
        } finally {
            setStopping(null);
        }
    };

    const rowClass = 'w-full min-h-[56px] p-4 text-nature-900 dark:text-white font-bold text-[15px] flex items-center gap-3 hover:bg-nature-50 dark:hover:bg-nature-800 transition-colors bg-transparent border-none cursor-pointer text-left';
    return (
        <div data-testid="settings-shared-outside">
            <div className="bg-white dark:bg-nature-900 rounded-2xl shadow-sm border border-nature-200 dark:border-nature-800 overflow-hidden">
                <button type="button" onClick={() => setOpen(o => !o)} className={rowClass} aria-expanded={open} data-testid="settings-shared-outside-row">
                    <span className="text-xl" aria-hidden="true">🔗</span>
                    <span className="flex-1 min-w-0 break-words">{t(W.sharedOutside)}</span>
                    <span className="text-nature-400 dark:text-nature-300" aria-hidden="true">{open ? '▾' : '›'}</span>
                </button>
                {open && (
                    <div className="px-4 pb-4 flex flex-col gap-3" data-testid="settings-shared-outside-list">
                        {shares === 'loading' && <p role="status" className="m-0 text-sm text-text-primary">{t('Loading...')}</p>}
                        {shares === 'failed' && (
                            <p role="alert" className="m-0 text-sm text-red-700 dark:text-red-300 break-words">
                                {t('Could not load this. Check your connection and try again.')}{' '}
                                <button type="button" onClick={load} className="underline font-semibold bg-transparent border-0 p-0 cursor-pointer text-inherit">{t('Retry')}</button>
                            </p>
                        )}
                        {Array.isArray(shares) && shares.length === 0 && (
                            <p className="m-0 text-sm text-text-primary break-words">{t(W.sharedOutsideNone)}</p>
                        )}
                        {Array.isArray(shares) && shares.map(s => (
                            <div key={s.id} data-testid="shared-outside-item" className="flex flex-col gap-2 p-3 rounded-xl border border-nature-200 dark:border-nature-800">
                                <span className="font-bold text-nature-900 dark:text-white break-words" dir="auto">{s.title ?? t(W.postGone)}</span>
                                <span className="text-xs text-nature-600 dark:text-nature-300">{t(W.worksUntil, { date: formatDate(new Date(s.expiresAt), 'day-month') })}</span>
                                <button type="button" onClick={() => stop(s.id)} disabled={stopping === s.id} data-testid="shared-outside-stop"
                                    className="self-start min-h-[44px] px-4 rounded-xl border border-red-300 dark:border-red-800 text-red-700 dark:text-red-300 font-bold text-sm bg-transparent cursor-pointer disabled:opacity-60 break-words">
                                    {t(W.stopSharing)}
                                </button>
                            </div>
                        ))}
                        {note && <p role="status" className={`m-0 text-sm font-semibold break-words ${note.ok ? 'text-bp-ink-accent' : 'text-red-700 dark:text-red-300'}`}>{note.text}</p>}
                    </div>
                )}
            </div>
        </div>
    );
}
