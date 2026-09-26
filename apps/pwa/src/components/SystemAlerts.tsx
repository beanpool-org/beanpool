/**
 * The alerts the node sends a member (`system_announcement`), shown one at a time as the app always showed them.
 *
 * Live, while the web app is open: the node sends each to the member's own sockets. And kept: the web app has no push,
 * so the node keeps each moderation notice for its member (a post hidden, back, removed or cleared; a report's outcome;
 * a pause and its lift), and this reads the ones they have not seen (GET /api/notices?unseen=1) when the app opens and
 * each time its socket connects again, since anything sent while it was down never arrived.
 *
 * Each is shown once. A live notice carries its kept copy's id, so the same notice read later is not shown again; and
 * each kept copy is marked seen on the node when the member puts it away (Acknowledge, or Close all), never as it is
 * shown: a tab nobody is looking at (a live notice on a background tab's socket, or its reconnect's read) shows it and
 * marks nothing, so a tab closed or discarded before the member looks leaves it for the next open. Two tabs may both
 * show it; none may use it up unseen. A read or a mark that fails shows nothing and breaks nothing: an unmarked notice
 * is read again at the next open, never lost.
 *
 * Put away on purpose, never by accident: for a second after each alert appears its buttons ignore a press, as browsers
 * delay their own permission buttons, and so they do for a second after a letter is typed. A member typing when an
 * alert comes, whose Tab lands on Acknowledge, would otherwise put it away unread with the next Space (#1186's review,
 * measured). While an alert shows it is modal: Tab stays inside it, and when the last one is put away focus goes back
 * to where the member was.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { onSystemAnnouncement, onSocketOpen } from '../lib/sync';
import { getUnseenNotices, markNoticesSeen, type KeptNotice } from '../lib/api';

export interface ShownAlert {
    key: string;
    title: string;
    body: string;
    severity: string;
    /** The node's kept copy, when it keeps one: marked seen once the member puts it away. */
    noticeId?: string;
    /** What it is about (`moderation_muted`, `post_removed`, ...), when the node says. */
    kind?: string;
}

/** A second read this soon after one that answered is the same read: the app opening, then its socket connecting. */
export const REREAD_GAP_MS = 5_000;
/** How long after an alert appears, or after a letter is typed while it shows, its buttons ignore a press. */
export const PRESS_GUARD_MS = 1_000;
/** The most ids one mark sends (the node takes up to 100). */
const MARK_BATCH = 100;

let liveSeq = 0;

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

function fromLive(a: any): ShownAlert | null {
    if (!a || (!text(a.title) && !text(a.body))) return null;
    const noticeId = text(a.noticeId) || undefined;
    return {
        key: noticeId ?? `live-${++liveSeq}`,
        title: text(a.title),
        body: text(a.body),
        severity: text(a.severity) || 'info',
        noticeId,
        kind: text(a.kind) || undefined,
    };
}

function fromKept(n: KeptNotice): ShownAlert | null {
    if (!n || !text(n.id) || (!text(n.title) && !text(n.body))) return null;
    return {
        key: n.id,
        title: text(n.title),
        body: text(n.body),
        severity: text(n.severity) || 'info',
        noticeId: n.id,
        kind: text(n.data?.kind) || undefined,
    };
}

function markSeen(ids: string[]): void {
    for (let i = 0; i < ids.length; i += MARK_BATCH) {
        const batch = ids.slice(i, i + MARK_BATCH);
        // Inside the promise chain, so nothing this throws (offline, an older node) reaches the page.
        Promise.resolve().then(() => markNoticesSeen(batch)).catch(() => { /* read again at the next open */ });
    }
}

/** Each severity's heading and border, and its button: index.css, a pair per theme that passes WCAG AA on the dialog. */
const SEVERITIES = new Set(['info', 'warning', 'critical']);
const ink = (severity: string) => `var(--alert-${SEVERITIES.has(severity) ? severity : 'info'}-ink)`;
const fill = (severity: string) => `var(--alert-${SEVERITIES.has(severity) ? severity : 'info'}-fill)`;
const ICONS: Record<string, string> = { critical: '🚨 ', warning: '⚠️ ' };

/** A key that types a character (not Space, Enter or Tab, which work the buttons): the member is typing, not pressing. */
function typesACharacter(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    // 'Unidentified' and 'Process': a phone's on-screen keyboard, and a character being composed.
    return (e.key.length === 1 && e.key !== ' ') || e.key === 'Unidentified' || e.key === 'Process';
}
/** A title's own icon: the node's moderation notices start with one ("🛡️ Your post was removed"). */
const LEADING_EMOJI = /^\s*(\p{Extended_Pictographic}[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D]*)\s*/u;

/**
 * The title's words, and the icons before them: the severity's, or ℹ️ for a title with no icon of its own (never
 * "ℹ️ 🛡️ ..."). The icons are shown but hidden from a screen reader, which would read out each emoji's name.
 */
function titleParts(title: string, severity: string): { icon: string; words: string } {
    const own = LEADING_EMOJI.exec(title);
    const words = own ? title.slice(own[0].length) : '';
    if (!own || !words) return { icon: ICONS[severity] ?? 'ℹ️ ', words: title };
    return { icon: `${ICONS[severity] ?? ''}${own[1]} `, words };
}

export interface SystemAlertsProps {
    /** The member this browser holds. Nothing is read or shown without one. */
    memberPubkey?: string | null;
    /** The membership check's answer (null until it comes). Kept notices are read only for a member; a live alert shows either way. */
    isGuest?: boolean | null;
    /** Each alert as it is shown, or closed unread by "Close all": the app reads the member's standing again after a pause or a lift. */
    onShown?: (alert: ShownAlert) => void;
    /** For tests: the gap between two reads of the kept notices. */
    rereadGapMs?: number;
    /** For tests: how long the buttons ignore a press after an alert appears or a letter is typed. */
    pressGuardMs?: number;
}

export function SystemAlerts({ memberPubkey, isGuest, onShown, rereadGapMs = REREAD_GAP_MS, pressGuardMs = PRESS_GUARD_MS }: SystemAlertsProps) {
    const [queue, setQueue] = useState<ShownAlert[]>([]);
    /** Every kept copy queued or shown for this member in this tab: never queued twice. */
    const known = useRef(new Set<string>());
    /** Every kept copy already marked seen (or being marked). */
    const marked = useRef(new Set<string>());
    const onShownRef = useRef(onShown);
    onShownRef.current = onShown;
    const dialogRef = useRef<HTMLDivElement>(null);
    /** When the alert showing now appeared, and when a character was last typed while one showed (performance.now()). */
    const shownAt = useRef(-Infinity);
    const typedAt = useRef(-Infinity);

    const enqueue = useCallback((alerts: (ShownAlert | null)[]) => {
        const fresh: ShownAlert[] = [];
        for (const a of alerts) {
            if (!a) continue;
            if (a.noticeId) {
                if (known.current.has(a.noticeId)) continue;
                known.current.add(a.noticeId);
            }
            fresh.push(a);
        }
        if (fresh.length > 0) setQueue(q => [...q, ...fresh]);
    }, []);

    // Another member on this browser starts from nothing.
    useEffect(() => {
        known.current = new Set();
        marked.current = new Set();
        setQueue([]);
    }, [memberPubkey]);

    useEffect(() => {
        if (!memberPubkey) return;
        return onSystemAnnouncement(a => enqueue([fromLive(a)]));
    }, [memberPubkey, enqueue]);

    // Only once the node has said this is a member: a guest has nothing kept here, and never sends the read.
    const readsKept = !!memberPubkey && isGuest === false;
    useEffect(() => {
        if (!readsKept) return;
        let cancelled = false;
        let inFlight = false;
        let answeredAt = -Infinity;
        const read = () => {
            if (cancelled || inFlight || Date.now() - answeredAt < rereadGapMs) return;
            inFlight = true;
            Promise.resolve()
                .then(() => getUnseenNotices())
                .then(notices => {
                    answeredAt = Date.now();
                    if (!cancelled && Array.isArray(notices)) enqueue(notices.map(fromKept));
                })
                .catch(() => { /* offline, an older node, not a member: nothing to show */ })
                .finally(() => { inFlight = false; });
        };
        read();
        const unsubscribe = onSocketOpen(read);
        return () => {
            cancelled = true;
            unsubscribe();
        };
    }, [readsKept, memberPubkey, enqueue, rereadGapMs]);

    /** Marks the kept copies of alerts the member has put away, each once. Only a tap calls this: never a render. */
    const putAway = (alerts: ShownAlert[]) => {
        const ids = alerts.map(a => a.noticeId).filter((id): id is string => !!id && !marked.current.has(id));
        for (const id of ids) marked.current.add(id);
        if (ids.length > 0) markSeen(ids);
    };

    const head = queue[0];
    const showing = !!head;

    // While an alert shows it is modal (WCAG 2.1.2, 2.4.3): Tab and Shift+Tab go round its buttons and never out to the
    // page behind it, and focus that lands outside it all the same comes back to it. A typed character is noted (see
    // `pressable`). When the last alert is put away, focus goes back to where the member was when the first came, if
    // that is still on the page and nothing else has taken focus since. Declared before the effect that focuses the
    // dialog, so it sees the member's own focus first.
    useEffect(() => {
        if (!showing) return;
        const before = document.activeElement;
        const onKeyDown = (e: KeyboardEvent) => {
            if (typesACharacter(e)) typedAt.current = performance.now();
            const dialog = dialogRef.current;
            if (e.key !== 'Tab' || !dialog) return;
            const stops = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled)'));
            const at = stops.indexOf(document.activeElement as HTMLElement);
            const last = stops.length - 1;
            // From one of its buttons to the next: the browser's own Tab. Anywhere else, round to the other end.
            if (at !== -1 && (e.shiftKey ? at > 0 : at < last)) return;
            e.preventDefault();
            (stops.length === 0 ? dialog : e.shiftKey ? stops[last] : stops[0]).focus();
        };
        const onFocusIn = (e: FocusEvent) => {
            const dialog = dialogRef.current;
            if (dialog && e.target instanceof Node && !dialog.contains(e.target)) dialog.focus();
        };
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('focusin', onFocusIn, true);
        return () => {
            document.removeEventListener('keydown', onKeyDown, true);
            document.removeEventListener('focusin', onFocusIn, true);
            const now = document.activeElement;
            if (before instanceof HTMLElement && before !== document.body && before.isConnected && (!now || now === document.body)) {
                before.focus();
            }
        };
    }, [showing]);

    // Each alert's second starts as it is drawn: a layout effect, so no press can come in between.
    useLayoutEffect(() => {
        if (head) shownAt.current = performance.now();
    }, [head?.key]);

    useEffect(() => {
        if (!head) return;
        onShownRef.current?.(head);
        // A screen reader goes to the alert, and again for each next one in the queue: to the dialog itself, not to
        // Acknowledge, so a Space or an Enter the member was typing into a text box puts nothing away. Acknowledge is
        // one Tab away.
        dialogRef.current?.focus();
        // Once per alert shown: keyed on the alert, not on the queue behind it.
    }, [head?.key]);

    if (!head) return null;

    const { icon, words } = titleParts(head.title, head.severity);
    const waiting = queue.length;
    /** A press counts once this alert has shown for the guard's length, and nothing has been typed for as long. */
    const pressable = () => {
        const now = performance.now();
        return now - shownAt.current >= pressGuardMs && now - typedAt.current >= pressGuardMs;
    };
    const acknowledge = () => {
        if (!pressable()) return;
        putAway([head]);
        setQueue(q => (q[0]?.key === head.key ? q.slice(1) : q));
    };
    const closeAll = () => {
        if (!pressable()) return;
        const closed = queue.slice(1);
        // Closed unread, the app still hears of each: a pause behind another notice still puts "Posting paused" up.
        for (const a of closed) onShownRef.current?.(a);
        putAway(queue);
        setQueue([]);
    };

    return (
        <div
            data-testid="system-alert"
            style={{
                position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                background: 'rgba(0,0,0,0.8)', zIndex: 9999,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '1rem', backdropFilter: 'blur(4px)',
                WebkitBackdropFilter: 'blur(4px)'
            }}
        >
            <div
                key={head.key}
                ref={dialogRef}
                tabIndex={-1}
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="system-alert-title"
                aria-describedby="system-alert-body"
                style={{
                    background: 'var(--bg-primary)',
                    border: `2px solid ${ink(head.severity)}`,
                    borderRadius: '12px',
                    maxWidth: '400px', width: '100%', maxHeight: '100%', boxSizing: 'border-box',
                    // The words scroll and the buttons stay: a long notice at 320px with large text still shows Acknowledge.
                    display: 'flex', flexDirection: 'column', overflow: 'hidden',
                    boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
                    textAlign: 'center',
                    // Focused for a screen reader, not a control: no ring around the whole card (Acknowledge keeps its own).
                    outline: 'none'
                }}
            >
                <div data-testid="system-alert-text" style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '1.5rem 1.25rem 0' }}>
                    <h2 id="system-alert-title" style={{ margin: '0 0 1rem', fontSize: 'min(1.5rem, 7vw)', lineHeight: 1.25, color: ink(head.severity), overflowWrap: 'anywhere' }}>
                        <span aria-hidden="true">{icon}</span>
                        {words}
                    </h2>
                    <p id="system-alert-body" style={{ margin: '0 0 1.25rem', lineHeight: 1.5, fontSize: '1.05rem', color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>
                        {head.body}
                    </p>
                </div>
                <div style={{ flex: '0 0 auto', padding: '0.75rem 1.25rem 1.25rem' }}>
                    {waiting > 1 && (
                        <p data-testid="system-alert-count" style={{ margin: '0 0 0.5rem', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                            1 of {waiting}
                        </p>
                    )}
                    <button
                        type="button"
                        onClick={acknowledge}
                        style={{
                            width: '100%', padding: '0.8rem',
                            background: fill(head.severity),
                            color: '#fff', border: 'none', borderRadius: '8px',
                            fontSize: '1.1rem', fontWeight: 600, cursor: 'pointer'
                        }}
                    >
                        Acknowledge
                    </button>
                    {waiting > 1 && (
                        <button
                            type="button"
                            onClick={closeAll}
                            style={{
                                width: '100%', padding: '0.6rem', marginTop: '0.5rem',
                                background: 'transparent', color: 'var(--text-secondary)',
                                // A border that shows (3:1 or more on the dialog, WCAG 1.4.11): --border-secondary was 1.06:1.
                                border: '1px solid var(--text-muted)', borderRadius: '8px',
                                fontSize: '0.95rem', cursor: 'pointer'
                            }}
                        >
                            Close all {waiting}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
