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
 *   node: Start opens the Start a community screen (StartCommunityScreen.tsx, whose link is the node's start link),
 *   the other two move within the app.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
    LOCAL_COMMUNITY_EMOJI, LOCAL_COMMUNITY_LINES, LOCAL_COMMUNITY_MARK, LOCAL_COMMUNITY_SHEET, LOCAL_COMMUNITY_STRIP, type ShowcaseFeature,
} from '@beanpool/core';
import { StartCommunityScreen } from './StartCommunityScreen';
import { useDialogFocus } from './dialog-focus';

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

export function LocalCommunitySheet({
    feature,
    onClose,
    onStart,
    onNearYou,
    onGuide,
    returnFocus,
}: {
    feature: ShowcaseFeature;
    onClose: () => void;
    onStart: () => void;
    returnFocus?: () => HTMLElement | null | undefined;
} & LocalCommunityWays) {
    const dialog = useRef<HTMLDivElement>(null);
    const closeRef = useRef<HTMLButtonElement>(null);
    useDialogFocus(dialog, onClose, {
        initialFocus: () => closeRef.current,
        fallback: returnFocus,
    });
    const go = (fn: () => void) => () => { onClose(); fn(); };
    return (
        <div className="fixed inset-0 z-[1200] flex items-end justify-center bg-black/50 sm:items-center" onClick={onClose}>
            <div
                ref={dialog}
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
                        className="-mr-2 -mt-2 inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-nature-500 dark:text-nature-400 hover:bg-nature-100 dark:hover:bg-nature-800 dark:hover:text-nature-200"
                    >✕</button>
                </div>
                <h2 id="local-community-sheet-title" className="mb-2 text-lg font-extrabold text-nature-900 dark:text-nature-50">{LOCAL_COMMUNITY_SHEET.title}</h2>
                <p className="mb-2 text-sm text-nature-700 dark:text-nature-200">{LOCAL_COMMUNITY_SHEET.features[feature]}</p>
                <p className="mb-4 text-sm text-nature-600 dark:text-nature-300">{LOCAL_COMMUNITY_SHEET.common}</p>
                <div className="flex flex-col gap-2">
                    <button
                        type="button"
                        onClick={onStart}
                        data-testid="local-community-start"
                        className="w-full rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover px-4 py-3 text-center font-bold text-bp-cta-on"
                    >{LOCAL_COMMUNITY_SHEET.start}</button>
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

/**
 * The sheet and the Start a community screen, opened by whatever `children` renders with the `open` (the sheet) and
 * `start` (the screen) it is handed. Both are drawn on document.body: a `fixed` overlay drawn in place inside a
 * transformed card (a pending invite's hover lift) would fill that card, not the screen (review of #2057, B3).
 */
function WithSheet({ feature, ways, children }: { feature: ShowcaseFeature; ways: LocalCommunityWays; children: (open: () => void, start: () => void) => ReactNode }) {
    const [shown, setShown] = useState<'sheet' | 'start' | null>(null);
    const openerRef = useRef<HTMLElement | null>(null);
    const open = () => {
        openerRef.current = (document.activeElement as HTMLElement | null) ?? null;
        setShown('sheet');
    };
    const start = () => {
        openerRef.current = (document.activeElement as HTMLElement | null) ?? null;
        setShown('start');
    };
    const close = () => {
        setShown(null);
        const back = openerRef.current;
        if (back && back !== document.body && back.isConnected) {
            back.focus();
        }
    };
    return (
        <>
            {children(open, start)}
            {/* A marker inside a tappable card (a poll, a listing): React still bubbles the portal's clicks through the
                card, so they stop here. */}
            {shown && createPortal(
                <div onClick={(e) => e.stopPropagation()}>
                    {shown === 'sheet'
                        ? <LocalCommunitySheet feature={feature} onClose={close} onStart={() => setShown('start')} returnFocus={() => openerRef.current} {...ways} />
                        : <StartCommunityScreen onClose={close} onNearYou={ways.onNearYou} returnFocus={() => openerRef.current} />}
                </div>,
                document.body,
            )}
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
            {(open, start) => collapsed ? (
                <div className={`${TONE} mb-4 flex items-center gap-1 rounded-xl pl-3 text-sm font-bold`} data-testid="local-community-strip-collapsed">
                    <button type="button" onClick={open} className="min-h-[44px] min-w-0 flex-1 py-2 text-left">{LOCAL_COMMUNITY_STRIP.collapsed}</button>
                    <button type="button" onClick={() => collapse(false)} aria-label="Show the whole note" data-testid="local-community-strip-open"
                        className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center shrink-0 rounded-lg">▾</button>
                </div>
            ) : (
                <section className={`${TONE} mb-4 rounded-2xl p-4`} data-testid="local-community-strip" aria-label={LOCAL_COMMUNITY_MARK}>
                    <div className="mb-2 flex items-start justify-between gap-2">
                        <LocalCommunityPill />
                        <button type="button" onClick={() => collapse(true)} aria-label="Make this note one line" data-testid="local-community-strip-close"
                            className="-mr-3 -mt-3 inline-flex min-h-[44px] min-w-[44px] items-center justify-center shrink-0 rounded-lg">✕</button>
                    </div>
                    <p className="text-sm text-nature-800 dark:text-nature-100">
                        <strong>{LOCAL_COMMUNITY_STRIP.lead[feature]}</strong> {LOCAL_COMMUNITY_STRIP.body[feature]}
                    </p>
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                        <button type="button" onClick={start} data-testid="local-community-strip-start"
                            className="w-full rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover px-4 py-2.5 font-bold text-bp-cta-on">{LOCAL_COMMUNITY_SHEET.start}</button>
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

/** A listing's deal action, "Request · Beans held safely": the pill after it carries the 🏘️. */
export const DEAL_ACTION_LABEL = LOCAL_COMMUNITY_LINES.dealAction.replace(LOCAL_COMMUNITY_EMOJI, '').trim();

/** A button that would move Beans or cast a vote: its place and words kept, dashed, with the pill; opens the sheet. */
export function LocalCommunityAction({ feature, label, className = '', 'aria-label': ariaLabel, ...ways }: { feature: ShowcaseFeature; label: string; className?: string; 'aria-label'?: string } & LocalCommunityWays) {
    return (
        <WithSheet feature={feature} ways={ways}>
            {(open) => (
                <button type="button" onClick={(e) => { e.stopPropagation(); open(); }} data-testid="local-community-action"
                    aria-label={ariaLabel}
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
                <button type="button" onClick={(e) => { e.stopPropagation(); open(); }} data-testid="local-community-line"
                    className="block w-full text-left text-sm font-semibold text-blue-700 dark:text-blue-300 underline-offset-2 hover:underline">
                    {text}
                </button>
            )}
        </WithSheet>
    );
}
