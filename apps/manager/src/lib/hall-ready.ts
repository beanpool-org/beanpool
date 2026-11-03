/**
 * "Ready for the hall" (lights-out H4; scratch/fable-design/DESIGN-lights-out-plain-ip-fable.md §3.7 and §5): what an owner
 * can still do, while the internet is up, so that a laptop in the hall can keep the community going when it is not.
 *
 * Every line here is one fact with a date and a rule for when it needs the owner's attention ("amber"). It gates nothing:
 * the card only says what is ready. Two rules keep it honest:
 *   - A line is "ok" only when something on record says so. What this page cannot see (a pulled image on the laptop, a file
 *     in a Downloads folder, a drill in the hall) is the owner's own note, kept in this browser and labelled as theirs;
 *     with no note the line is amber, never ticked. A fact the page could not read is "unknown", never ok.
 *   - Nothing here leaves this node. The card reads this node's own routes and this browser's storage, so it reads the same
 *     with the internet unplugged.
 *
 * The amber thresholds are the design's where it gave one (a copy older than a day) and picks where it did not (named below).
 */
import type { OwnerWordsCheck, StandbyHealthBanner, TakeoverStatus } from './node-client';

export type ReadyState = 'ok' | 'amber' | 'unknown';

export type ReadyLineId = 'image' | 'copy' | 'code' | 'owners' | 'download' | 'apk' | 'drill';

export interface ReadyLine {
    id: ReadyLineId;
    title: string;
    state: ReadyState;
    /** The fact, in words, with its date. */
    text: string;
    /** Under the fact: what to do when it is amber, or what this page cannot see when it is ok (paper, a Downloads folder). */
    hint?: string;
    /** More rows under the line (one per standby). */
    rows?: string[];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Design §3.7 item 2: a standby's copy older than a day is amber. */
export const COPY_AMBER_AFTER_MS = DAY;
/** Pick: the image on the laptop was pulled more than 60 days ago ("re-pull after each release"; releases come every few weeks). */
export const IMAGE_AMBER_AFTER_MS = 60 * DAY;
/** Pick: "monthly" (design §3.7 item 6) plus a few days' slack. */
export const DOWNLOAD_AMBER_AFTER_MS = 35 * DAY;
/** Pick: a drill older than half a year was tried on other releases of the app and the node. */
export const DRILL_AMBER_AFTER_MS = 180 * DAY;
/** The owners' words check renews yearly (OwnerWordsChecksPanel's RENEW_MS). */
export const WORDS_AMBER_AFTER_MS = 365 * DAY;

/**
 * The slug of the operator manual page H0 writes ("Before the lights go out", the kit page). Planned, not yet on main when
 * this was built: openManual falls back to the contents for a slug that does not exist, so a link made before it lands
 * still opens the manual.
 */
export const HALL_KIT_PAGE = 'before-the-lights-go-out';

// ── Words for a time ───────────────────────────────────────────────────────────────────────────────────

export function dayWords(ms: number): string {
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "just now", "5 minutes ago", "3 hours ago", "4 days ago". */
export function agoWords(ms: number, now: number): string {
    const age = Math.max(0, now - ms);
    if (age < MINUTE) return 'just now';
    if (age < HOUR) { const n = Math.floor(age / MINUTE); return `${n} minute${n === 1 ? '' : 's'} ago`; }
    if (age < 2 * DAY) { const n = Math.floor(age / HOUR); return `${n} hour${n === 1 ? '' : 's'} ago`; }
    const n = Math.floor(age / DAY);
    return `${n} day${n === 1 ? '' : 's'} ago`;
}

// ── The owner's notes (this browser only) ──────────────────────────────────────────────────────────────

/**
 * What only the owner knows, and when they noted it. Kept in this browser (localStorage) per node, because the server
 * cannot see a laptop's Docker images, a Downloads folder or a drill. They are dates and nothing else.
 */
export interface HallNotes {
    /** The image on the laptop was pulled. */
    imagePulledAt?: number;
    /** A locked (.bpsealed) file was downloaded in this browser (stamped by the download button itself, from the node's X-Backup-Locked: yes). */
    downloadedAt?: number;
    /**
     * An unlocked file was downloaded in this browser: the node had no recovery code then, so the file holds no keys
     * (backups-and-replicas.md). It is noted so the card can say so, and it never counts as the locked file.
     */
    downloadedPlainAt?: number;
    /** The switch was tried once with the internet unplugged. */
    drillAt?: number;
}

export type HallNoteKey = keyof HallNotes;

const NOTES_PREFIX = 'bp_hall_ready:';
/** Told on `window` when a note is written here, so a card already on screen (a download stamps one) reads it again. */
export const HALL_NOTES_EVENT = 'bp-hall-notes';
const EARLIEST = Date.UTC(2020, 0, 1);

/** A stored time we believe: a whole number of milliseconds since 2020, and not more than a day ahead of this clock. */
function believable(v: unknown, now: number): v is number {
    return typeof v === 'number' && Number.isFinite(v) && v >= EARLIEST && v <= now + DAY;
}

/** Storage can be refused or absent (private window, blocked site data): every read and write is wrapped. */
function store(): Storage | null {
    try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export function readHallNotes(nodeId: string, now: number = Date.now()): HallNotes {
    try {
        const raw = store()?.getItem(NOTES_PREFIX + nodeId);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as Record<string, unknown> | null;
        if (!parsed || typeof parsed !== 'object') return {};
        const out: HallNotes = {};
        for (const key of ['imagePulledAt', 'downloadedAt', 'downloadedPlainAt', 'drillAt'] as const) {
            if (believable(parsed[key], now)) out[key] = parsed[key] as number;
        }
        return out;
    } catch {
        return {};
    }
}

/** Note a time (`at` null clears the note). Returns the notes as stored, or the old ones where storage refused. */
export function writeHallNote(nodeId: string, key: HallNoteKey, at: number | null, now: number = Date.now()): HallNotes {
    const notes = readHallNotes(nodeId, now);
    if (at === null) delete notes[key];
    else notes[key] = at;
    try {
        const s = store();
        if (s) {
            if (Object.keys(notes).length === 0) s.removeItem(NOTES_PREFIX + nodeId);
            else s.setItem(NOTES_PREFIX + nodeId, JSON.stringify(notes));
        }
    } catch { /* refused: the card still works from what it can read */ }
    try {
        if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(HALL_NOTES_EVENT, { detail: { nodeId } }));
    } catch { /* nothing is listening */ }
    return notes;
}

// ── The lines ──────────────────────────────────────────────────────────────────────────────────────────

/** Item 1: Docker and the image on the laptop, pulled while online. The server cannot see the laptop, so this is the owner's note. */
export function imageLine(notes: HallNotes, now: number): ReadyLine {
    const title = 'Image on the laptop';
    const at = notes.imagePulledAt;
    if (at === undefined) {
        return { id: 'image', title, state: 'amber', text: 'Not noted yet.',
            hint: 'On the laptop, in the BeanPool folder, run docker compose pull. Then tap "I pulled it today" here. This page cannot see the laptop, so this is your note.' };
    }
    const text = `Pulled on the laptop ${dayWords(at)} (${agoWords(at, now)}), as you noted in this browser.`;
    if (now - at > IMAGE_AMBER_AFTER_MS) {
        return { id: 'image', title, state: 'amber', text, hint: 'Pull again after each release: docker compose pull on the laptop, then note it here.' };
    }
    return { id: 'image', title, state: 'ok', text };
}

/** "2 minutes ago", and from a day on, the day as well: "3 days ago (1 Nov 2026)". */
function copyWhen(at: number, now: number): string {
    return now - at >= DAY ? `${agoWords(at, now)} (${dayWords(at)})` : agoWords(at, now);
}

/** `owner` false: an admin's session, which the node does not tell about its standbys. */
export function copyLine(health: StandbyHealthBanner | null | undefined, owner: boolean, now: number): ReadyLine {
    const title = 'Laptop paired as the standby';
    if (!owner) {
        return { id: 'copy', title, state: 'unknown', text: 'Only an owner sees the standby\'s copies.' };
    }
    if (!health) {
        return { id: 'copy', title, state: 'unknown', text: 'This server is not watching a standby (it is not the main server, or it is too old to say).' };
    }
    const standbys = health.standbys ?? [];
    if (standbys.length === 0) {
        return { id: 'copy', title, state: 'amber', text: 'No standby has copied this server yet.',
            hint: 'Pair the laptop as the standby: the steps are just below.' };
    }
    const paired = (s: StandbyHealthBanner['standbys'][number]) => s.paired === undefined || s.paired === 'this' || s.paired === 'unknown';
    const fresh = (s: StandbyHealthBanner['standbys'][number]) => s.lastCopyAt !== null && now - s.lastCopyAt <= COPY_AMBER_AFTER_MS;
    const rows = standbys.map((s) => {
        const copied = s.lastCopyAt === null ? 'has not made a copy yet' : `last copy ${copyWhen(s.lastCopyAt, now)}`;
        const notes = [!paired(s) ? 'not paired with this server' : null, !s.healthy ? 'needs attention (see Home)' : null].filter(Boolean);
        return `${s.label}: ${copied}${notes.length ? `, ${notes.join(', ')}` : ''}`;
    });
    // The best standby speaks for the line: a good one if there is one, else the one that copied last.
    const good = standbys.find((s) => fresh(s) && s.healthy && paired(s));
    if (good) {
        // This page cannot tell which standby is the laptop: it names the one that copied, and the owner checks it is theirs.
        return { id: 'copy', title, state: 'ok', text: `Last copy ${copyWhen(good.lastCopyAt as number, now)}.`,
            hint: standbys.length === 1 ? `${good.label}. Check that this is the laptop.` : 'Check that the standby that copied is the laptop.',
            rows: standbys.length > 1 ? rows : undefined };
    }
    const newest = [...standbys].sort((a, b) => (b.lastCopyAt ?? -Infinity) - (a.lastCopyAt ?? -Infinity))[0];
    const text = newest.lastCopyAt === null
        ? 'The standby has not made a copy yet.'
        : `Last copy ${copyWhen(newest.lastCopyAt, now)}.`;
    const hint = !paired(newest) ? 'The standby is not paired with this server: pair it again from its shell (the steps are just below).'
        : !newest.healthy ? 'The standby needs attention: Home says what is wrong.'
            : newest.lastCopyAt === null ? 'Wait a minute for the first copy. If none comes, check the laptop is on and can reach this server.'
                : 'A copy older than a day: check the laptop is on and can reach this server.';
    return { id: 'copy', title, state: 'amber', text, hint, rows: standbys.length > 1 ? rows : undefined };
}

/** Item 3: the recovery code. The server knows its number and date; it cannot see that the paper is printed. */
export function codeLine(status: TakeoverStatus | null | undefined): ReadyLine {
    const title = 'Recovery code';
    if (!status) {
        return { id: 'code', title, state: 'unknown', text: 'Could not read this from the server.' };
    }
    if (status.codeUsed) {
        return { id: 'code', title, state: 'amber', text: `Recovery code #${status.codeUsed.codeId} was used in a take-over and is spent.`,
            hint: 'Make a new one under Who can unlock this community, print it, and keep it away from the laptop.' };
    }
    const code = status.recoveryCode;
    if (!code) {
        return { id: 'code', title, state: 'amber', text: 'No recovery code made yet.',
            hint: 'Make one under Who can unlock this community, print it, and keep it away from the laptop.' };
    }
    const made = new Date(code.createdAt).getTime();
    return { id: 'code', title, state: 'ok',
        text: `Recovery code #${code.codeId}${Number.isFinite(made) ? `, made ${dayWords(made)}` : ''}.`,
        hint: 'This server cannot see paper: check yours is printed and kept away from the laptop.' };
}

/** Item 4: a second owner, and each owner's 12 words checked (their own signed statement; the server cannot see the words). */
export function ownersLine(owners: OwnerWordsCheck[] | null | undefined, now: number): ReadyLine {
    const title = 'Owners and their 12 words';
    if (!owners) {
        return { id: 'owners', title, state: 'unknown', text: 'Could not read this from the server.' };
    }
    if (owners.length === 0) {
        return { id: 'owners', title, state: 'amber', text: 'This community has no owner yet.' };
    }
    const checked = owners.filter((o) => o.wordsCheckedAt && now - o.wordsCheckedAt < WORDS_AMBER_AFTER_MS).length;
    // The date: the oldest check any owner has reported (their own statement; the server cannot see the words).
    const dates = owners.map((o) => o.wordsCheckedAt).filter((d): d is number => typeof d === 'number' && d > 0);
    const text = `${checked} of ${owners.length} owner${owners.length === 1 ? '' : 's'} checked their 12 words in the last year.`
        + (dates.length ? ` The oldest check: ${dayWords(Math.min(...dates))}.` : '');
    if (owners.length < 2) {
        return { id: 'owners', title, state: 'amber', text: `Only one owner. ${text}`,
            hint: 'Make a second owner (Owners & admins), so the hall does not hang on one phone.' };
    }
    if (checked < owners.length) {
        return { id: 'owners', title, state: 'amber', text, hint: 'Each owner checks their 12 words in the BeanPool app, on their own phone.' };
    }
    return { id: 'owners', title, state: 'ok', text };
}

/**
 * Item 6: the newest locked file, downloaded in this browser. The browser cannot see where the file went afterwards. A file
 * downloaded before there was a recovery code is not locked and holds no keys, so it is not the file this line wants.
 */
export function downloadLine(notes: HallNotes, now: number): ReadyLine {
    const title = 'Locked backup file on the laptop';
    const at = notes.downloadedAt;
    if (at === undefined) {
        if (notes.downloadedPlainAt !== undefined) {
            return { id: 'download', title, state: 'amber',
                text: `The file downloaded in this browser ${dayWords(notes.downloadedPlainAt)} was not locked, so it holds no keys.`,
                hint: 'Make a recovery code (under Who can unlock this community), then download again.' };
        }
        return { id: 'download', title, state: 'amber', text: 'No file downloaded in this browser yet.',
            hint: 'Use Download Sovereign Database below, on the laptop\'s own browser if you can, and keep the file there. It is the fallback if the standby is ever unpaired.' };
    }
    const text = `Last locked file downloaded in this browser ${dayWords(at)} (${agoWords(at, now)}).`;
    if (now - at > DOWNLOAD_AMBER_AFTER_MS) {
        return { id: 'download', title, state: 'amber', text, hint: 'Download a newer one each month, and keep it on the laptop.' };
    }
    return { id: 'download', title, state: 'ok', text, hint: 'This browser cannot see where the file went: check it is on the laptop.' };
}

/**
 * What this node says about the Android app it carries (the apk-on-node lane, H3). Read leniently: until the node says
 * anything, the APK is "not on this node yet" and the line is amber, never ticked.
 */
export interface ApkState { version: string; versionCode?: number; size?: number }

export function readApkState(raw: unknown): ApkState | null {
    if (!raw || typeof raw !== 'object') return null;
    const v = (raw as Record<string, unknown>).version;
    if (typeof v !== 'string' || !/^\d+\.\d+\.\d+$/.test(v)) return null;
    const code = (raw as Record<string, unknown>).versionCode;
    const size = (raw as Record<string, unknown>).size;
    return {
        version: v,
        ...(typeof code === 'number' && Number.isFinite(code) ? { versionCode: code } : {}),
        ...(typeof size === 'number' && Number.isFinite(size) ? { size } : {}),
    };
}

/** Item 7: the APK on the node, for Android phones that have not got the app. */
export function apkLine(raw: unknown): ReadyLine {
    const title = 'Android app on this node';
    const apk = readApkState(raw);
    if (!apk) {
        return { id: 'apk', title, state: 'amber', text: 'The APK is not on this node yet.',
            hint: 'Until it is, an Android phone without the app cannot join in the hall. Members who already have the app are not affected.' };
    }
    return { id: 'apk', title, state: 'ok', text: `Version ${apk.version} is on this node, for the hall's Android phones.` };
}

/** Item 9: the switch tried once with the Wi-Fi's internet unplugged, phones moved and moved back. The owner's note. */
export function drillLine(notes: HallNotes, now: number): ReadyLine {
    const title = 'Tried once, with the internet unplugged';
    const at = notes.drillAt;
    if (at === undefined) {
        return { id: 'drill', title, state: 'amber', text: 'Not tried yet.',
            hint: 'Unplug the Wi-Fi\'s internet, turn the hall on, move a phone to it and back. Then tap "I tried it today". This page cannot see it, so this is your note.' };
    }
    const text = `Tried ${dayWords(at)} (${agoWords(at, now)}), as you noted in this browser.`;
    if (now - at > DRILL_AMBER_AFTER_MS) {
        return { id: 'drill', title, state: 'amber', text, hint: 'Try it again: the app and the node have changed since.' };
    }
    return { id: 'drill', title, state: 'ok', text };
}

/** How many lines are ok, of how many. Unknown counts as not ready. */
export function readySummary(lines: ReadyLine[]): { ready: number; total: number } {
    return { ready: lines.filter((l) => l.state === 'ok').length, total: lines.length };
}
