/**
 * Removed lines drawn as one (Marty, 15 Oct: "Yes, one line"): consecutive lines removed the same way show as ONE line
 * ("11 messages removed by a convenor") on the web and the phone. Display only: every line keeps its id, so a reply to
 * one, a search hit and a scroll to one still land (on the run's line).
 *
 * Only CONSECUTIVE lines of ONE kind join: any other line between breaks the run, and an author's own delete never joins
 * a convenor's removal. A run of one is not collapsed at all: the caller draws it with today's words, so the singular
 * count sentence below is never shown (it is there for languages whose `one` form also holds 21, 31, …).
 */
import { t, tn } from './words.js';

/**
 * Who removed a line: a convenor; its own author (their delete, or their account deleted); or nobody, the node itself,
 * when the chat was locked end-to-end and every line it could read went (the day-zero wipe, server group-thread.ts
 * wipeReadableGroupLines). Telling a member a convenor removed those would be false.
 */
export type RemovedLineKind = 'convenor' | 'author' | 'locked';

/**
 * A line the node removed when the chat was locked: its tombstone says `removedBy: 'SYSTEM'` and `lockedAway: true`.
 * Both, because only `removedBy` is the node's alone (it strips a client's and writes the remover's key over it at
 * every removal); a member's own metadata could carry `lockedAway` into a later removal.
 */
export function isLockedAwayLine(metadata: unknown): boolean {
    const m = metadata as { removedBy?: unknown; lockedAway?: unknown } | null | undefined;
    return !!m && typeof m === 'object' && m.removedBy === 'SYSTEM' && m.lockedAway === true;
}

/** One such line on its own, in the device's language. */
export function lockedAwayLineText(): string {
    return t('An earlier message was removed when this chat was locked');
}

/** A stretch of the conversation: a removed run (`kind` set, one line or more) or one ordinary line (`kind` null). */
export interface RemovedLineRun<T> {
    kind: RemovedLineKind | null;
    lines: T[];
}

/** The conversation, in order, cut into runs; `kindOf` names a removed line's kind and null for every other line. */
export function removedLineRuns<T>(lines: readonly T[], kindOf: (line: T) => RemovedLineKind | null): RemovedLineRun<T>[] {
    const runs: RemovedLineRun<T>[] = [];
    for (const line of lines) {
        const kind = kindOf(line);
        const last = runs[runs.length - 1];
        if (kind !== null && last && last.kind === kind) last.lines.push(line);
        else runs.push({ kind, lines: [line] });
    }
    return runs;
}

/** Whether a run is drawn as one line: two or more removed lines. */
export function isCollapsedRun<T>(run: RemovedLineRun<T>): run is RemovedLineRun<T> & { kind: RemovedLineKind } {
    return run.kind !== null && run.lines.length >= 2;
}

/** The words of a collapsed run, in the device's language. */
export function removedRunText(kind: RemovedLineKind, n: number): string {
    if (kind === 'locked') return tn(n, '{n} earlier message removed when this chat was locked', '{n} earlier messages removed when this chat was locked');
    return kind === 'convenor'
        ? tn(n, '{n} message removed by a convenor', '{n} messages removed by a convenor')
        : tn(n, '{n} message was deleted', '{n} messages were deleted');
}
