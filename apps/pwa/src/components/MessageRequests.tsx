/**
 * Message requests on the web (DESIGN-message-a-friend-fable.md §4.5, slice S3): the Requests list under Messages' Requests
 * row, each request's card, and the Accept / Decline / Report bar the card and the chat's request mode share. The node
 * decides (PR #2392 routes/messaging.ts); this only asks it, and says in words what it answered, or that it couldn't be
 * reached: nothing is shown as done that the node didn't take.
 *
 * A card reads the request's own lines (lib/dm-requests.ts requestPreviewLines): the words opened with the reader's key, a
 * photo closed and never fetched. Every control is at least 44 px and the buttons wrap under each other at 320 px.
 */
import { useEffect, useRef, useState, type CSSProperties, type Dispatch, type MutableRefObject, type ReactNode, type SetStateAction } from 'react';
import { t, tn } from '@beanpool/core';
import { decideMessageRequest, getConversationMessages, ignoreAllMessageRequests, type DmRequest, type DmRequestEntry } from '../lib/api';
import { decisionFailureWords, requestPreviewLines, REQUEST_CARDS_SHOWN, IGNORE_ALL_FROM, type RequestPreviewLine } from '../lib/dm-requests';
import type { BeanPoolIdentity } from '../lib/identity';

const button: CSSProperties = {
    minHeight: '44px', padding: '0.5rem 1rem', borderRadius: '10px', fontFamily: 'inherit', fontSize: '0.9rem',
    fontWeight: 700, cursor: 'pointer', flex: '1 1 7rem',
};
const acceptButton: CSSProperties = { ...button, border: 'none', background: 'var(--bp-commit-fill)', color: 'var(--bp-commit-on)', flex: '1 1 100%' };
const ignoreButton: CSSProperties = { ...button, border: '1px solid var(--border-primary)', background: 'var(--bg-hover)', color: 'var(--text-primary)' };
const reportButton: CSSProperties = {
    ...button, border: '1px solid var(--bp-chip-danger-ink)', background: 'var(--bp-chip-danger-tint)', color: 'var(--bp-chip-danger-ink)',
};

interface ActionsProps {
    conversationId: string;
    /** Accepted: the request as the node now reads it. */
    onAccepted: (request: DmRequest) => void;
    onIgnored: () => void;
    /** Report: the page opens the report card, which reports the line and blocks its sender (lib/dm-line-report.ts). */
    onReport: () => void;
}

/**
 * Accept, Decline and Report for one request. Accept and Decline ask the node and wait: a decision it didn't take leaves
 * the buttons as they were, with its words, or the offline sentence. Decline is the node's `ignore`: its sender isn't told.
 */
export function RequestActions({ conversationId, onAccepted, onIgnored, onReport }: ActionsProps) {
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const alive = useRef(true);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

    async function decide(decision: 'accept' | 'ignore') {
        if (busy) return;
        setBusy(true);
        setFailure(null);
        try {
            const answer = await decideMessageRequest(conversationId, decision);
            if (!alive.current) return;
            setBusy(false);
            if (decision === 'accept') onAccepted(answer.request);
            else onIgnored();
        } catch (e) {
            if (!alive.current) return;
            setBusy(false);
            // The request is gone (ignored on another device, its sender removed): nothing is left to decide here.
            if ((e as { code?: unknown } | null)?.code === 'request_not_found') { onIgnored(); return; }
            setFailure(decisionFailureWords(e));
        }
    }

    return (
        <div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                <button type="button" style={{ ...acceptButton, opacity: busy ? 0.7 : 1 }} disabled={busy} onClick={() => decide('accept')}>
                    {t('Accept', undefined, 'button: accept a message request')}
                </button>
                <button type="button" style={ignoreButton} disabled={busy} onClick={() => decide('ignore')}>
                    {t('Decline', undefined, 'button: decline a message request')}
                </button>
                <button type="button" style={reportButton} disabled={busy} onClick={onReport}>
                    {t('Report', undefined, 'button: report a message request')}
                </button>
            </div>
            {failure && (
                <p role="alert" style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)', wordBreak: 'break-word' }}>{failure}</p>
            )}
        </div>
    );
}

/** A request's lines as the card shows them, once read: or why they aren't shown. */
type Preview = RequestPreviewLine[] | 'loading' | 'failed';

/** The words standing in for a request's photo until it is accepted. */
export function closedPhotoWords(): string {
    return t('Photo: shown when you accept');
}

interface CardProps {
    entry: DmRequestEntry;
    identity: BeanPoolIdentity;
    preview: Preview;
    /** A face: the picture, else the ready-made one chosen from the key (MessagesPage renderAvatar). */
    avatar: (avatarUrl: string | null | undefined, faceKey: string, size: number) => ReactNode;
    joinedWords: string | null;
    onOpen: () => void;
    onOpenProfile?: () => void;
    onAccepted: (request: DmRequest) => void;
    onGone: () => void;
    onReport: () => void;
}

function RequestCard({ entry, identity, preview, avatar, joinedWords, onOpen, onOpenProfile, onAccepted, onGone, onReport }: CardProps) {
    const peer = entry.participants.find((p) => p !== identity.publicKey) || entry.request.from;
    const name = entry.peerCallsign || peer.slice(0, 8);
    const who = (
        <>
            {avatar(entry.peerAvatar, peer, 44)}
            <span style={{ fontWeight: 700, fontSize: '1rem', overflowWrap: 'anywhere' }}>{name}</span>
        </>
    );
    return (
        <li data-testid="request-card" style={{
            listStyle: 'none', background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: '12px',
            padding: '0.85rem 1rem', marginBottom: '0.75rem',
        }}>
            {onOpenProfile ? (
                <button type="button" onClick={onOpenProfile} aria-label={t("{name}, see {name}'s profile", { name })} style={{
                    display: 'flex', alignItems: 'center', gap: '0.75rem', minHeight: '44px', padding: 0, background: 'none', border: 'none',
                    color: 'var(--text-primary)', font: 'inherit', cursor: 'pointer', textAlign: 'left', maxWidth: '100%',
                }}>{who}</button>
            ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minHeight: '44px' }}>{who}</div>
            )}
            <p style={{ margin: '0.35rem 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>
                {t('{name} wants to message you', { name })}
            </p>
            {(joinedWords || entry.addedYou) && (
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.4rem', marginTop: '0.35rem' }}>
                    {joinedWords && <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{joinedWords}</span>}
                    {entry.addedYou && (
                        <span style={{
                            fontSize: '0.75rem', fontWeight: 700, padding: '2px 8px', borderRadius: '8px', overflowWrap: 'anywhere',
                            background: 'var(--bp-chip-ok-tint)', color: 'var(--bp-chip-ok-ink)',
                        }}>{t('{name} added you', { name })}</span>
                    )}
                </div>
            )}
            {/* The words, read before deciding (design §4.6): tapping them opens the chat in request mode, in context. */}
            <button type="button" onClick={onOpen} data-testid="request-card-open" style={{
                display: 'block', width: '100%', textAlign: 'left', margin: '0.6rem 0 0.75rem', padding: '0.6rem 0.75rem', minHeight: '44px',
                background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', borderRadius: '10px',
                color: 'var(--text-primary)', font: 'inherit', fontSize: '0.95rem', cursor: 'pointer',
            }}>
                {preview === 'loading' ? (
                    <span style={{ color: 'var(--text-muted)' }}>{t('Loading…')}</span>
                ) : preview === 'failed' ? (
                    <span style={{ color: 'var(--text-muted)' }}>{t('Open the chat to read it.')}</span>
                ) : preview.length === 0 ? (
                    <span style={{ color: 'var(--text-muted)' }}>{t('Open the chat to read it.')}</span>
                ) : preview.map((l) => (
                    <span key={l.id} style={{ display: 'block' }}>
                        {l.photo && (
                            <span style={{ display: 'block', fontStyle: 'italic', color: 'var(--text-secondary)' }}>
                                <span aria-hidden="true">🖼️ </span>{closedPhotoWords()}
                            </span>
                        )}
                        {l.text && (
                            <span dir="auto" style={{
                                display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                                whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
                            }}>{l.text}</span>
                        )}
                    </span>
                ))}
            </button>
            <RequestActions
                conversationId={entry.id}
                onAccepted={onAccepted}
                onIgnored={onGone}
                onReport={onReport}
            />
        </li>
    );
}

/**
 * The cards' lines as read, by request (its id and time), and which have been asked for: held by the Messages page, which
 * stays while a chat is open, so going into one and Back reads none of them again (PR #2404 review 4356503723).
 */
export interface RequestPreviews {
    previews: Record<string, Preview>;
    setPreviews: Dispatch<SetStateAction<Record<string, Preview>>>;
    asked: MutableRefObject<Set<string>>;
}

export function useRequestPreviews(): RequestPreviews {
    const [previews, setPreviews] = useState<Record<string, Preview>>({});
    const asked = useRef<Set<string>>(new Set());
    return { previews, setPreviews, asked };
}

interface ListProps {
    entries: DmRequestEntry[];
    count: number;
    identity: BeanPoolIdentity;
    /** The cards' lines, kept by the page (useRequestPreviews). */
    store: RequestPreviews;
    /** A face: the picture, else the ready-made one chosen from the key (MessagesPage renderAvatar). */
    avatar: (avatarUrl: string | null | undefined, faceKey: string, size: number) => ReactNode;
    /** When the sender joined, in words, where this page holds their card. */
    joinedWordsOf: (pubkey: string) => string | null;
    onOpen: (entry: DmRequestEntry) => void;
    onOpenProfile?: (pubkey: string) => void;
    onAccepted: (entry: DmRequestEntry, request: DmRequest) => void;
    /** Something changed the requests (a decline, a report, Decline all): read the list again. */
    onChanged: () => void;
    onReport: (entry: DmRequestEntry) => void;
    /** Back to the chats: the row at the top of Chat opened this. */
    onBack: () => void;
}

/**
 * The Requests list: how many people want to message you, a card for each (newest first, 50 shown), "and {n} more", and
 * Decline all when more than five wait. Each card's lines are read once per request (by its id and time) while the page is
 * open, three at a time.
 */
export function MessageRequestsList({ entries, count, identity, store, avatar, joinedWordsOf, onOpen, onOpenProfile, onAccepted, onChanged, onReport, onBack }: ListProps) {
    const shown = entries.slice(0, REQUEST_CARDS_SHOWN);
    const { previews, setPreviews, asked } = store;
    const keyOf = (e: DmRequestEntry) => `${e.id}@${e.request.at}`;
    const [ignoringAll, setIgnoringAll] = useState(false);
    const [allFailure, setAllFailure] = useState<string | null>(null);

    // A preview is kept by its request's id and time, so one that lands after the list has changed, or after the member has
    // gone into a chat, still lands on its own card (or on none): nothing asked is ever dropped, so no card waits on a read
    // that won't come.
    useEffect(() => {
        const wanted = shown.filter((e) => !asked.current.has(keyOf(e)));
        if (wanted.length === 0) return;
        wanted.forEach((e) => asked.current.add(keyOf(e)));
        setPreviews((p) => ({ ...p, ...Object.fromEntries(wanted.map((e) => [keyOf(e), 'loading' as Preview])) }));
        const queue = [...wanted];
        const next = async (): Promise<void> => {
            const e = queue.shift();
            if (!e) return;
            let preview: Preview;
            try {
                const read = await getConversationMessages(e.id, 20);
                preview = requestPreviewLines({ ...e, ...(read.conversation ?? {}), request: read.conversation?.request ?? e.request }, identity, read.messages ?? []);
            } catch {
                preview = 'failed';
                asked.current.delete(keyOf(e));
            }
            setPreviews((p) => ({ ...p, [keyOf(e)]: preview }));
            return next();
        };
        void Promise.all([next(), next(), next()]);
    }, [shown.map(keyOf).join(','), identity.publicKey]);

    async function ignoreAll() {
        if (ignoringAll) return;
        if (!window.confirm(tn(count, "Decline {n} request? They won't be told.", "Decline all {n} requests? They won't be told."))) return;
        setIgnoringAll(true);
        setAllFailure(null);
        try {
            await ignoreAllMessageRequests();
            onChanged();
        } catch (e) {
            setAllFailure(decisionFailureWords(e));
        } finally {
            setIgnoringAll(false);
        }
    }

    const more = count - shown.length;
    return (
        <section data-testid="message-requests" aria-label={t('Message requests')}>
            <button type="button" data-testid="message-requests-back" onClick={onBack} style={{
                display: 'block', minHeight: '44px', padding: 0, marginBottom: '0.25rem', background: 'none', border: 'none',
                color: 'var(--text-primary)', font: 'inherit', fontSize: '0.9rem', fontWeight: 700, cursor: 'pointer',
            }}>
                <span aria-hidden="true">‹ </span>{t('Back to chats')}
            </button>
            {count === 0 ? (
                <p style={{
                    textAlign: 'center', padding: '2rem 1.25rem', margin: 0, background: 'var(--bg-card)', border: '1px solid var(--border-primary)',
                    borderRadius: '1rem', color: 'var(--text-secondary)', fontSize: '0.95rem', lineHeight: 1.45,
                }}>
                    {t("No requests. A first message from someone you haven't added or talked to arrives here.")}
                </p>
            ) : (
                <>
                    <p style={{ margin: '0 0 0.75rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                        {tn(count, '{n} person wants to message you', '{n} people want to message you')}
                    </p>
                    <ul style={{ margin: 0, padding: 0 }}>
                        {shown.map((e) => {
                            const peer = e.participants.find((p) => p !== identity.publicKey) || e.request.from;
                            return (
                                <RequestCard
                                    key={e.id}
                                    entry={e}
                                    identity={identity}
                                    preview={previews[keyOf(e)] ?? 'loading'}
                                    avatar={avatar}
                                    joinedWords={joinedWordsOf(peer)}
                                    onOpen={() => onOpen(e)}
                                    onOpenProfile={onOpenProfile ? () => onOpenProfile(peer) : undefined}
                                    onAccepted={(request) => onAccepted(e, request)}
                                    onGone={onChanged}
                                    onReport={() => onReport(e)}
                                />
                            );
                        })}
                    </ul>
                    {more > 0 && (
                        <p style={{ margin: '0 0 0.75rem', color: 'var(--text-muted)', fontSize: '0.9rem' }}>{tn(more, 'and {n} more', 'and {n} more')}</p>
                    )}
                    {count >= IGNORE_ALL_FROM && (
                        <div style={{ marginTop: '0.5rem' }}>
                            <button type="button" onClick={ignoreAll} disabled={ignoringAll} style={{ ...ignoreButton, width: '100%' }}>
                                {t('Decline all')}
                            </button>
                            {allFailure && (
                                <p role="alert" style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{allFailure}</p>
                            )}
                        </div>
                    )}
                </>
            )}
        </section>
    );
}
