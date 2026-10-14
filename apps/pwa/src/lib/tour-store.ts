/**
 * The one-minute tour in the web app (scratch/global-node/DESIGN-getting-started-fable.md §2), the web side of the
 * phone's utils/tour-store.ts. Home starts it (Look around ›) and owns what it writes; App draws the bar and moves the
 * tabs. Home is drawn only while its tab is open, so an end made on another tab (Skip) waits here as `pendingEnd` and
 * Home applies it as it opens (the bar always closes on Home).
 *
 * - **In this browser, per account:** the step a tour part way is at (`{ v: 1, step, startedAt }`), and a Done or Skip the
 *   node hasn't taken yet, sent again on the next Home open.
 * - **On the account:** the `tour` preference (core tour.ts).
 *
 * Every storage read and write is guarded: a browser that keeps nothing still gets the tour, never an error.
 */
import { useEffect, useState } from 'react';
import { readTourProgress, readTourRecord, type TourNodeFacts, type TourProgress, type TourRecord } from '@beanpool/core';

const progressKey = (publicKey: string) => `beanpool_tour_progress_${publicKey}`;
const pendingKey = (publicKey: string) => `beanpool_tour_pending_${publicKey}`;

function readJson(key: string): unknown {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}
function writeJson(key: string, value: unknown | null): void {
    try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(value));
    } catch { /* nothing kept: the card says Look around again */ }
}

/** A tour running for an account, with what Home said of the node as it began (App derives the steps from it). */
export interface TourRun { publicKey: string; step: number; startedAt: string; node: TourNodeFacts }

/** What Home lends the bar while it is open: the last step's chips go through Home's own add. */
export interface TourHome {
    chips: readonly string[];
    chipName(type: string): string;
    onHome(type: string): boolean;
    addChip(type: string): void;
    moreCards(): void;
}

let run: TourRun | null = null;
let home: TourHome | null = null;
let pendingEnd: { publicKey: string; kind: 'done' | 'skipped' } | null = null;
let pendingAgain: string | null = null;
/** Whether Home's Getting started card is up for an account: the tour is offered and has not ended (App holds the install banner back meanwhile). */
let offered: { publicKey: string; up: boolean } | null = null;
const listeners = new Set<() => void>();
const publish = () => listeners.forEach((l) => l());

export const currentTour = (): TourRun | null => run;
export const tourHome = (): TourHome | null => home;

export function lendTourHome(next: TourHome | null): void {
    home = next;
    publish();
}

/** Starts (or resumes) the tour at `step`. Only Home's card and the "?" call this: it never auto-plays. */
export function startTour(publicKey: string, node: TourNodeFacts, step = 0): void {
    run = { publicKey, step, startedAt: new Date().toISOString(), node };
    writeJson(progressKey(publicKey), { v: 1, step, startedAt: run.startedAt } satisfies TourProgress);
    publish();
}

export function moveTour(step: number): void {
    if (!run || run.step === step) return;
    run = { ...run, step };
    writeJson(progressKey(run.publicKey), { v: 1, step, startedAt: run.startedAt } satisfies TourProgress);
    publish();
}

/** Done or Skip: the bar closes, this browser's progress goes, and Home applies the end as it opens. */
export function endTour(kind: 'done' | 'skipped'): void {
    if (!run) return;
    pendingEnd = { publicKey: run.publicKey, kind };
    writeJson(progressKey(run.publicKey), null);
    run = null;
    publish();
}

/** The bar closes with nothing written (the account left this page). */
export function closeTour(): void {
    if (run) writeJson(progressKey(run.publicKey), null);
    run = null;
    pendingEnd = null;
    publish();
}

/** Home says whether its Getting started card is up for this account (the install banner waits while it is). */
export function offerTour(publicKey: string, up: boolean): void {
    if (offered?.publicKey === publicKey && offered.up === up) return;
    offered = { publicKey, up };
    publish();
}

/** Home takes the end waiting for this account (once). */
export function takePendingEnd(publicKey: string): 'done' | 'skipped' | null {
    if (!pendingEnd || pendingEnd.publicKey !== publicKey) return null;
    const kind = pendingEnd.kind;
    pendingEnd = null;
    return kind;
}

export function useTour(): { run: TourRun | null; home: TourHome | null; pendingEnd: typeof pendingEnd; pendingAgain: string | null; offered: typeof offered } {
    const [, tick] = useState(0);
    useEffect(() => {
        const l = () => tick((n) => n + 1);
        listeners.add(l);
        return () => { listeners.delete(l); };
    }, []);
    return { run, home, pendingEnd, pendingAgain, offered };
}

/** The step a tour part way is at in this browser for this account, or null. */
export const readProgress = (publicKey: string): TourProgress | null => readTourProgress(readJson(progressKey(publicKey)));

/** A Done or Skip the node didn't take: kept here and sent on the next Home open. */
export const pendingTourRecord = (publicKey: string): TourRecord | null => readTourRecord(readJson(pendingKey(publicKey)));
export const keepPendingTourRecord = (publicKey: string, record: TourRecord | null): void => writeJson(pendingKey(publicKey), record);

// ── The "?"'s screen context and its opening ──────────────────────────────────────────────────────────────────────────

/** Said on the page by any "?" (the mobile pill, the sidebar, the lobby); App opens the dialog. */
export const OPEN_HELP_EVENT = 'beanpool:open-help';
export const openHelp = (): void => { window.dispatchEvent(new Event(OPEN_HELP_EVENT)); };
/** Take the tour again (the "?"): waits for Home, which writes `open`, puts its card back and starts the bar from step 1. */
export function askTourAgain(publicKey: string): void {
    pendingAgain = publicKey;
    publish();
}
export function takeTourAgain(publicKey: string): boolean {
    if (pendingAgain !== publicKey) return false;
    pendingAgain = null;
    return true;
}
