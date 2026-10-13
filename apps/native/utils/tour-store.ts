/**
 * The one-minute tour on the phone (scratch/global-node/DESIGN-getting-started-fable.md §2), and the "?"'s screen
 * context (§4). Home starts the tour (Look around ›) and owns what it writes; the tab layout draws the bar and moves
 * the app from tab to tab. The two meet here: a small store of whether a tour is running and at which step, the
 * handlers Home registers for the last step's chips and the end, and the sub-view a tab screen names for the "?".
 *
 * - **On the device, per account:** the step a tour part way is at (`{ v: 1, step, startedAt }`), so a killed app's card
 *   says "Pick up the tour at step n ›"; and a Done or Skip the node hasn't taken yet, sent again on the next Home open.
 * - **On the account:** the `tour` preference (core tour.ts), written by {@link saveTourRecord}.
 *
 * The tour never blocks: nothing here holds a tap, and nothing starts by itself.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';
import { TOUR_PREF_KEY, readTourProgress, readTourRecord, type TourProgress, type TourRecord } from '@beanpool/core';
import { signedPost } from './node-post';
import type { BeanPoolIdentity } from './identity';

const progressKey = (publicKey: string) => `beanpool_tour_progress_${publicKey}`;
const pendingKey = (publicKey: string) => `beanpool_tour_pending_${publicKey}`;

// ── The running tour ──────────────────────────────────────────────────────────────────────────────────────────────

export interface TourRun {
    /** The account the tour runs for: a tour never outlives its account on the phone. */
    publicKey: string;
    step: number;
    startedAt: string;
}

/** What Home lends the bar: the last step's chips go on Home through Home's own add, and the end through Home's write. */
export interface TourHome {
    /** The chips' card types, already filtered to what this node shows this reader (core `tourChips`). */
    chips: readonly string[];
    /** A chip's name as the picker says it. */
    chipName(type: string): string;
    /** Whether the card is on Home now (a chip reads "On Home ✓"). */
    onHome(type: string): boolean;
    addChip(type: string): void;
    /** Opens Add a card (More cards ›). */
    moreCards(): void;
    end(kind: 'done' | 'skipped'): void;
    /** Take the tour again (the "?"): the account's record back to open, and the bar from step 1. */
    restart(): void;
}

let run: TourRun | null = null;
let home: TourHome | null = null;
const listeners = new Set<() => void>();
const publish = () => listeners.forEach((l) => l());

export const currentTour = (): TourRun | null => run;
export const tourHome = (): TourHome | null => home;

/** Home lends its handlers while it is mounted (and gives them back on unmount). */
export function lendTourHome(next: TourHome | null): void {
    home = next;
    publish();
}

/** Starts (or resumes) the tour at `step` for this account. Only Home's card and the "?" call this: it never auto-plays. */
export function startTour(publicKey: string, step = 0): void {
    run = { publicKey, step, startedAt: new Date().toISOString() };
    void keepProgress(run);
    publish();
}

/** Moves the running tour to `step` (Next, or a tab the member tapped: the tour follows). */
export function moveTour(step: number): void {
    if (!run || run.step === step) return;
    run = { ...run, step };
    void keepProgress(run);
    publish();
}

/** The bar closes (Done or Skip, or the account left the phone). The device's progress goes with it. */
export function closeTour(): void {
    const was = run;
    run = null;
    if (was) void AsyncStorage.removeItem(progressKey(was.publicKey)).catch(() => {});
    publish();
}

/** The running tour and Home's handlers, redrawn on every change. */
export function useTour(): { run: TourRun | null; home: TourHome | null } {
    const [, tick] = useState(0);
    useEffect(() => {
        const l = () => tick((n) => n + 1);
        listeners.add(l);
        return () => { listeners.delete(l); };
    }, []);
    return { run, home };
}

async function keepProgress(r: TourRun): Promise<void> {
    try {
        await AsyncStorage.setItem(progressKey(r.publicKey), JSON.stringify({ v: 1, step: r.step, startedAt: r.startedAt } satisfies TourProgress));
    } catch { /* the card says Look around again: never worse than that */ }
}

/** The step a tour part way is at on this phone for this account, or null. */
export async function readProgress(publicKey: string): Promise<TourProgress | null> {
    try {
        const raw = await AsyncStorage.getItem(progressKey(publicKey));
        return raw ? readTourProgress(JSON.parse(raw)) : null;
    } catch {
        return null;
    }
}

// ── The account's record ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Writes the tour record to the account. A write that fails (offline, a node that is down) is kept on the phone and sent
 * again by {@link resendTourRecord} on the next Home open; a node that refuses it outright (a node from before the
 * tour) drops it: the phone's own word ends the card here, as the layout write does.
 */
export async function saveTourRecord(url: string, identity: BeanPoolIdentity, record: TourRecord): Promise<boolean> {
    try {
        const res = await signedPost(url, '/api/members/preferences', { publicKey: identity.publicKey, preferences: { [TOUR_PREF_KEY]: record } }, identity);
        if (res.ok || (res.status >= 400 && res.status < 500)) {
            await AsyncStorage.removeItem(pendingKey(identity.publicKey)).catch(() => {});
            return res.ok;
        }
    } catch { /* kept below */ }
    try {
        await AsyncStorage.setItem(pendingKey(identity.publicKey), JSON.stringify(record));
    } catch { /* nothing more to do */ }
    return false;
}

/** The record a Done or Skip left on this phone that the node hasn't taken yet, or null. */
export async function pendingTourRecord(publicKey: string): Promise<TourRecord | null> {
    try {
        const raw = await AsyncStorage.getItem(pendingKey(publicKey));
        return raw ? readTourRecord(JSON.parse(raw)) : null;
    } catch {
        return null;
    }
}

/** Sends a kept record again (Home's open). */
export async function resendTourRecord(url: string, identity: BeanPoolIdentity): Promise<void> {
    const pending = await pendingTourRecord(identity.publicKey);
    if (pending) await saveTourRecord(url, identity, pending);
}

// ── The "?"'s context ─────────────────────────────────────────────────────────────────────────────────────────────

let helpView: string | null = null;

/** A tab screen names its sub-view for the "?" (`polls`, `deals`, `groups`, `people`), and clears it (null) on blur. */
export function setHelpContext(view: string | null): void {
    helpView = view;
}
export const helpContext = (): string | null => helpView;

/** The event the header's "?" sends; the tab layout opens the sheet. */
export const OPEN_HELP_EVENT = 'open_help';
