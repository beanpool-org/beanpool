/**
 * The bell's row for a yes from a community this member asked from here (DESIGN-global-yes-join-fable.md §2.4, slice Y3):
 * "🎉 {name} said yes.", made by this app when Home's read of the request says yes, since the community the app talks to
 * keeps nothing of the requests its members send elsewhere (global introduces, never holds or routes), as the phone posts its
 * own "A community answered your request." from its sync (apps/native utils/sync-notices.ts).
 *
 * Kept in this browser for this account, one row per yes (a new invite from the same community is a new row). A row shows
 * on the bell, counted with the notices, until the yes is seen: its Join tapped (the banner's own mark, lib/knock.ts
 * markYesSeen), or the row tapped or cleared on the bell, which marks it the same way. A request read as anything but an
 * unused yes (used: the key joined there; nothing open; waiting) takes its row away. A tap lands on Home's row for that
 * community ({@link landOnKnockRow}: App.tsx brings Home up with the Find card on it, its Join in focus).
 */
import { YES_BELL_EVENT, yesMark, yesSeenMarks } from './knock';

export { YES_BELL_EVENT };

/** Asks App.tsx for Home with the Find card on this community's row (lib/knock-landing.ts does the same for a push's click). */
export const KNOCK_ROW_EVENT = 'beanpool-knock-row';

export interface YesRow { url: string; name: string; invite: string; at: number }

const STORE_KEY = 'beanpool_yes_bell';
const MAX_ROWS = 20;

const isRow = (r: unknown): r is YesRow => !!r && typeof r === 'object'
    && typeof (r as YesRow).url === 'string' && typeof (r as YesRow).name === 'string'
    && typeof (r as YesRow).invite === 'string' && typeof (r as YesRow).at === 'number';

function readRows(pubkey: string): YesRow[] {
    try {
        const kept = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as { pubkey?: unknown; rows?: unknown } | null;
        return kept && kept.pubkey === pubkey && Array.isArray(kept.rows) ? kept.rows.filter(isRow) : [];
    } catch {
        return [];
    }
}

function tell(): void {
    try { window.dispatchEvent(new Event(YES_BELL_EVENT)); } catch { /* no window: nothing listens */ }
}

/**
 * What Home's read of this account's requests said, for the requests it read (an answer not read yet changes nothing):
 * an unused yes keeps a row, from the first read that said it; any other answer takes that community's row away.
 */
export function noteYesAnswers(pubkey: string, answers: ReadonlyArray<{ url: string; name: string; invite: string | null }>, now: number = Date.now()): void {
    const rows = readRows(pubkey);
    const next = rows.filter(r => !answers.some(a => a.url === r.url && a.invite !== r.invite));
    for (const a of answers) {
        if (a.invite && !next.some(r => r.url === a.url && r.invite === a.invite)) next.push({ url: a.url, name: a.name, invite: a.invite, at: now });
    }
    if (next.length === rows.length && next.every((r, i) => r === rows[i])) return;
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify({ pubkey, rows: next.slice(-MAX_ROWS) }));
    } catch { /* storage off: the Find card and the banner still have the yes */ }
    tell();
}

/** The yeses the bell shows for this account: kept, and not seen yet. */
export function unseenYeses(pubkey: string): YesRow[] {
    const seen = yesSeenMarks(pubkey);
    return readRows(pubkey).filter(r => !seen.has(yesMark(r.url, r.invite)));
}

/** Home, with the Find card on this community's row. */
export function landOnKnockRow(url: string): void {
    try { window.dispatchEvent(new CustomEvent(KNOCK_ROW_EVENT, { detail: url })); } catch { /* no window */ }
}
