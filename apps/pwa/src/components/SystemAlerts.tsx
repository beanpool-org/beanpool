/**
 * The alerts the node sends a member (`system_announcement`), shown one at a time as the app always showed them.
 *
 * Live, while the web app is open: the node sends each to the member's own sockets. And kept: the web app has no push,
 * so the node keeps each moderation notice for its member (a post hidden, back, removed or cleared; a report's outcome;
 * a pause and its lift), and this reads the ones they have not seen (GET /api/notices?unseen=1) when the app opens and
 * each time its socket connects again, since anything sent while it was down never arrived.
 *
 * Each is shown once. A live notice carries its kept copy's id, so the same notice read later is not shown again; and
 * each kept copy is marked seen on the node as it is shown (or when the member closes the rest). A read or a mark that
 * fails shows nothing and breaks nothing: an unmarked notice is read again at the next open, never lost.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { onSystemAnnouncement, onSocketOpen } from '../lib/sync';
import { getUnseenNotices, markNoticesSeen, type KeptNotice } from '../lib/api';

export interface ShownAlert {
    key: string;
    title: string;
    body: string;
    severity: string;
    /** The node's kept copy, when it keeps one: marked seen once shown. */
    noticeId?: string;
    /** What it is about (`moderation_muted`, `post_removed`, ...), when the node says. */
    kind?: string;
}

/** A second read this soon after one that answered is the same read: the app opening, then its socket connecting. */
export const REREAD_GAP_MS = 5_000;
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

const COLOURS: Record<string, string> = { critical: '#ef4444', warning: '#f59e0b' };
const ICONS: Record<string, string> = { critical: '🚨 ', warning: '⚠️ ' };

export interface SystemAlertsProps {
    /** The member this browser holds. Nothing is read or shown without one. */
    memberPubkey?: string | null;
    /** The membership check's answer (null until it comes). Kept notices are read only for a member; a live alert shows either way. */
    isGuest?: boolean | null;
    /** Each alert as it is shown: the app reads the member's standing again after a pause or a lift. */
    onShown?: (alert: ShownAlert) => void;
    /** For tests: the gap between two reads of the kept notices. */
    rereadGapMs?: number;
}

export function SystemAlerts({ memberPubkey, isGuest, onShown, rereadGapMs = REREAD_GAP_MS }: SystemAlertsProps) {
    const [queue, setQueue] = useState<ShownAlert[]>([]);
    /** Every kept copy queued or shown for this member in this tab: never queued twice. */
    const known = useRef(new Set<string>());
    /** Every kept copy already marked seen (or being marked). */
    const marked = useRef(new Set<string>());
    const onShownRef = useRef(onShown);
    onShownRef.current = onShown;

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

    const head = queue[0];
    useEffect(() => {
        if (!head) return;
        onShownRef.current?.(head);
        if (head.noticeId && !marked.current.has(head.noticeId)) {
            marked.current.add(head.noticeId);
            markSeen([head.noticeId]);
        }
        // Once per alert shown: keyed on the alert, not on the queue behind it.
    }, [head?.key]);

    if (!head) return null;

    const colour = COLOURS[head.severity] ?? '#3b82f6';
    const waiting = queue.length;
    const closeAll = () => {
        const rest = queue.slice(1).map(a => a.noticeId).filter((id): id is string => !!id && !marked.current.has(id));
        for (const id of rest) marked.current.add(id);
        if (rest.length > 0) markSeen(rest);
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
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="system-alert-title"
                aria-describedby="system-alert-body"
                style={{
                    background: 'var(--bg-primary)',
                    border: `2px solid ${colour}`,
                    borderRadius: '12px',
                    maxWidth: '400px', width: '100%', maxHeight: '100%', boxSizing: 'border-box',
                    // The words scroll and the buttons stay: a long notice at 320px with large text still shows Acknowledge.
                    display: 'flex', flexDirection: 'column', overflow: 'hidden',
                    boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
                    textAlign: 'center'
                }}
            >
                <div data-testid="system-alert-text" style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '1.5rem 1.25rem 0' }}>
                    <h2 id="system-alert-title" style={{ margin: '0 0 1rem', fontSize: 'min(1.5rem, 7vw)', lineHeight: 1.25, color: colour, overflowWrap: 'anywhere' }}>
                        {ICONS[head.severity] ?? 'ℹ️ '}
                        {head.title}
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
                        onClick={() => setQueue(q => q.slice(1))}
                        style={{
                            width: '100%', padding: '0.8rem',
                            background: colour,
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
                                border: '1px solid var(--border-secondary)', borderRadius: '8px',
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
