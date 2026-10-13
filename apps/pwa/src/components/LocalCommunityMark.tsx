/**
 * The one marker for "this lives in a local community", 🏘️ Local community, and the one sheet every variant opens
 * (scratch/global-node/DESIGN-global-showcase-fable.md §2). The words are @beanpool/core's (features.ts), shared with
 * the phone.
 *
 * - **Variants.** `pill` on a page or card title; `strip` across the top of a preview screen (✕ collapses it to one
 *   line, remembered per node and feature in this browser); `action` on a button that would move Beans or cast a vote
 *   (the button keeps its place and words, dashed, with the pill); `line`, one tappable sentence.
 * - **Look.** Info tone (the Join card's blue) with a dashed border, the sample family's. Never a lock, amber, red,
 *   grey, reduced opacity or a tier's colours: nothing here is locked, it lives somewhere else.
 * - **The sheet** says why, then Start a community, Communities near you and How it works. Nothing here writes to the
 *   node: Start opens the node's start link, the other two move within the app.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
    LOCAL_COMMUNITY_EMOJI, LOCAL_COMMUNITY_MARK, LOCAL_COMMUNITY_SHEET, LOCAL_COMMUNITY_STRIP, type ShowcaseFeature,
} from '@beanpool/core';
import { startCommunityUrl, useCommunityInfo } from '../lib/features';

/** Where the sheet's two in-app ways forward lead; a button whose way is absent is not shown. */
export interface LocalCommunityWays {
    /** Communities near you: Home's Find card. */
    onNearYou?: () => void;
    /** How it works: the feature's guide page. */
    onGuide?: (slug: string) => void;
}

const TONE = 'border border-dashed border-blue-400 dark:border-blue-600 bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-200';

export function LocalCommunityPill() {
    return (
        <span
            data-testid="local-community-pill"
            className={`${TONE} inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-black uppercase tracking-wide`}
        >
            <span aria-hidden="true">{LOCAL_COMMUNITY_EMOJI}</span>{LOCAL_COMMUNITY_MARK}
        </span>
    );
}

export function LocalCommunitySheet({ feature, onClose, onNearYou, onGuide }: { feature: ShowcaseFeature; onClose: () => void } & LocalCommunityWays) {
    const info = useCommunityInfo();
    const closeRef = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        closeRef.current?.focus();
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);
    const go = (fn: () => void) => () => { onClose(); fn(); };
    return (
        <div className="fixed inset-0 z-[200] flex items-end justify-center bg-black/50 sm:items-center" onClick={onClose}>
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="local-community-sheet-title"
                data-testid="local-community-sheet"
                onClick={(e) => e.stopPropagation()}
                className="w-full max-w-md rounded-t-2xl sm:rounded-2xl border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-900 p-5 shadow-xl"
            >
                <div className="mb-3 flex items-start justify-between gap-3">
                    <LocalCommunityPill />
                    <button
                        ref={closeRef}
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        className="-mr-1 -mt-1 rounded-lg px-2 py-1 text-nature-500 dark:text-nature-400 hover:bg-nature-100 dark:hover:bg-nature-800"
                    >✕</button>
                </div>
                <h2 id="local-community-sheet-title" className="mb-2 text-lg font-extrabold text-nature-900 dark:text-nature-50">{LOCAL_COMMUNITY_SHEET.title}</h2>
                <p className="mb-2 text-sm text-nature-700 dark:text-nature-200">{LOCAL_COMMUNITY_SHEET.features[feature]}</p>
                <p className="mb-4 text-sm text-nature-600 dark:text-nature-300">{LOCAL_COMMUNITY_SHEET.common}</p>
                <div className="flex flex-col gap-2">
                    <a
                        href={startCommunityUrl(info)}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={onClose}
                        data-testid="local-community-start"
                        className="w-full rounded-xl bg-terra-600 hover:bg-terra-500 px-4 py-3 text-center font-bold text-white"
                    >{LOCAL_COMMUNITY_SHEET.start}</a>
                    {onNearYou && (
                        <button type="button" onClick={go(onNearYou)} data-testid="local-community-near-you"
                            className="w-full rounded-xl border border-nature-300 dark:border-nature-600 px-4 py-3 font-bold text-nature-800 dark:text-nature-100 hover:bg-nature-50 dark:hover:bg-nature-800">
                            {LOCAL_COMMUNITY_SHEET.nearYou}
                        </button>
                    )}
                    {onGuide && (
                        <button type="button" onClick={go(() => onGuide(LOCAL_COMMUNITY_SHEET.guide[feature]))} data-testid="local-community-guide"
                            className="w-full rounded-xl px-4 py-3 font-bold text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/50">
                            {LOCAL_COMMUNITY_SHEET.howItWorks} ›
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

/** The sheet, opened by whatever `children` renders with the `open` it is handed. */
function WithSheet({ feature, ways, children }: { feature: ShowcaseFeature; ways: LocalCommunityWays; children: (open: () => void) => ReactNode }) {
    const [open, setOpen] = useState(false);
    return (
        <>
            {children(() => setOpen(true))}
            {open && <LocalCommunitySheet feature={feature} onClose={() => setOpen(false)} {...ways} />}
        </>
    );
}

/** The collapsed state of a strip: per node and feature, in this browser only; a store that won't answer reads open. */
function stripKey(feature: ShowcaseFeature): string {
    let host = '';
    try { host = window.location.host; } catch { /* no location: one key */ }
    return `bp_local_strip_collapsed:${host}:${feature}`;
}
function readCollapsed(feature: ShowcaseFeature): boolean {
    try { return localStorage.getItem(stripKey(feature)) === '1'; } catch { return false; }
}
function writeCollapsed(feature: ShowcaseFeature, collapsed: boolean): void {
    try {
        if (collapsed) localStorage.setItem(stripKey(feature), '1');
        else localStorage.removeItem(stripKey(feature));
    } catch { /* a private window: open again next time */ }
}

export function LocalCommunityStrip({ feature, ...ways }: { feature: ShowcaseFeature } & LocalCommunityWays) {
    const [collapsed, setCollapsed] = useState(() => readCollapsed(feature));
    const collapse = (c: boolean) => { setCollapsed(c); writeCollapsed(feature, c); };
    return (
        <WithSheet feature={feature} ways={ways}>
            {(open) => collapsed ? (
                <div className={`${TONE} mb-4 flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-bold`} data-testid="local-community-strip-collapsed">
                    <button type="button" onClick={open} className="min-w-0 flex-1 text-left">{LOCAL_COMMUNITY_STRIP.collapsed}</button>
                    <button type="button" onClick={() => collapse(false)} aria-label="Show the whole note" className="shrink-0 rounded px-1">▾</button>
                </div>
            ) : (
                <section className={`${TONE} mb-4 rounded-2xl p-4`} data-testid="local-community-strip" aria-label={LOCAL_COMMUNITY_MARK}>
                    <div className="mb-2 flex items-start justify-between gap-2">
                        <LocalCommunityPill />
                        <button type="button" onClick={() => collapse(true)} aria-label="Make this note one line" data-testid="local-community-strip-close"
                            className="-mr-1 -mt-1 shrink-0 rounded-lg px-2 py-0.5">✕</button>
                    </div>
                    <p className="text-sm text-nature-800 dark:text-nature-100">
                        <strong>{LOCAL_COMMUNITY_STRIP.lead[feature]}</strong> {LOCAL_COMMUNITY_STRIP.body}
                    </p>
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                        <button type="button" onClick={open} data-testid="local-community-strip-why"
                            className="w-full rounded-xl bg-terra-600 hover:bg-terra-500 px-4 py-2.5 font-bold text-white">{LOCAL_COMMUNITY_SHEET.start}</button>
                        {ways.onNearYou && (
                            <button type="button" onClick={ways.onNearYou}
                                className="w-full rounded-xl border border-blue-300 dark:border-blue-700 bg-white/70 dark:bg-nature-900/60 px-4 py-2.5 font-bold text-nature-800 dark:text-nature-100">
                                {LOCAL_COMMUNITY_SHEET.nearYou}
                            </button>
                        )}
                    </div>
                </section>
            )}
        </WithSheet>
    );
}

/** A button that would move Beans or cast a vote: its place and words kept, dashed, with the pill; opens the sheet. */
export function LocalCommunityAction({ feature, label, className = '', ...ways }: { feature: ShowcaseFeature; label: string; className?: string } & LocalCommunityWays) {
    return (
        <WithSheet feature={feature} ways={ways}>
            {(open) => (
                <button type="button" onClick={open} data-testid="local-community-action"
                    className={`${TONE} inline-flex flex-wrap items-center justify-center gap-2 rounded-xl px-4 py-2.5 font-bold ${className}`}>
                    <span>{label}</span><LocalCommunityPill />
                </button>
            )}
        </WithSheet>
    );
}

/** One tappable sentence where a local community differs (the words start with 🏘️ and end with ›). */
export function LocalCommunityLine({ feature, text, ...ways }: { feature: ShowcaseFeature; text: string } & LocalCommunityWays) {
    return (
        <WithSheet feature={feature} ways={ways}>
            {(open) => (
                <button type="button" onClick={open} data-testid="local-community-line"
                    className="block w-full text-left text-sm font-semibold text-blue-700 dark:text-blue-300 underline-offset-2 hover:underline">
                    {text}
                </button>
            )}
        </WithSheet>
    );
}
