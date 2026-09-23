/**
 * EventChat — the chat every event carries (docs/events-on-the-map.md §2.1, §3 "Chat entry", slice 4).
 *
 * The host and everyone marked Going; the node can read it, and the footer says so in one line rather than
 * pretending otherwise. The host's note for people going is pinned at the top as a card the list scrolls
 * under — it is never a message, so editing the note never leaves a stale copy behind. The host may remove a
 * message, as a keeper may in an enterprise thread. When the event ends or is cancelled the composer goes and
 * the banner says which.
 *
 * Built for 320px at 130% text: the header truncates, every button is at least 48px and nothing wraps under
 * the composer.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
    getEventChat, postEventChatMessage, removeEventChatMessage,
    type EventThreadMessage, type EventThreadView,
} from '../lib/api';
import { resolveAvatarUrl } from '../lib/avatar';
import { imageFromTransfer, dragCarriesFile } from '../lib/chat-image-transfer';
import type { BeanPoolIdentity } from '../lib/identity';

/** Messages are stored base64 `plaintext-v1`: node-readable by design, not end-to-end encrypted. */
export function decodeEventChatText(ciphertext: string, type: string): string {
    if (type === 'removed') return 'removed by the host';
    try {
        const binString = atob(ciphertext);
        const bytes = Uint8Array.from(binString, (m) => m.charCodeAt(0));
        return new TextDecoder().decode(bytes);
    } catch {
        return ciphertext;
    }
}

export const EVENT_CHAT_MESSAGE_MAX = 2000;

function formatTime(iso: string): string {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

interface Props {
    /** The event's post id — which is also the conversation's id. */
    postId: string;
    identity: BeanPoolIdentity | null;
    onBack?: () => void;
    /**
     * Opens the event's own page. The chat is often the only way back to an event that has left the feed —
     * after it ends, or after the host cancels it — so the header always carries the way to it.
     */
    onOpenEvent?: () => void;
    /** Poll interval while the chat is open; 0 turns it off (tests). */
    refreshMs?: number;
}

export function EventChat({ postId, identity, onBack, onOpenEvent, refreshMs = 12000 }: Props) {
    const [view, setView] = useState<EventThreadView | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [draft, setDraft] = useState('');
    const [posting, setPosting] = useState(false);
    const [postError, setPostError] = useState<string | null>(null);
    const [removingId, setRemovingId] = useState<string | null>(null);
    // An event chat carries no photos: the node refuses them. A paste or a drop
    // says so in one line here rather than failing silently or in an alert().
    const [imageNotice, setImageNotice] = useState<string | null>(null);
    const bottomRef = useRef<HTMLDivElement | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await getEventChat(postId);
            setView(res);
            setLoadError(null);
        } catch (e: any) {
            setLoadError(e?.message || 'Could not open this event chat.');
        }
    }, [postId]);

    useEffect(() => { load(); }, [load]);

    // Moving to another event's chat drops the line the last one left behind.
    useEffect(() => { setImageNotice(null); }, [postId]);

    // Paused while the tab is hidden, as every other poller in this app is (MessagesPage, SyncStatus,
    // RecoveryAlertBanner). An event chat left open in a background tab used to keep pulling a page of
    // messages every twelve seconds for as long as the browser stayed open; most of our members pay for
    // that data. Coming back loads once, straight away, rather than waiting out an interval.
    useEffect(() => {
        if (!refreshMs) return;
        let timer: ReturnType<typeof setInterval> | null = null;

        /** `immediate` is false only at mount, where the effect above has already done the first read. */
        const startPolling = (immediate: boolean) => {
            if (!timer) {
                if (immediate) load();
                timer = setInterval(load, refreshMs);
            }
        };

        const stopPolling = () => {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
        };

        const handleVisibilityChange = () => {
            if (document.hidden) stopPolling();
            else startPolling(true);
        };

        if (!document.hidden) startPolling(false);
        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => {
            stopPolling();
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [load, refreshMs]);

    useEffect(() => {
        // jsdom has no layout, so scrollIntoView is not always there to call.
        bottomRef.current?.scrollIntoView?.({ block: 'end' });
    }, [view?.messages.length]);

    // The one way a message goes: the Send button and the Enter key share it,
    // so they share its guard against an empty draft and a send already in flight.
    const submitDraft = async () => {
        const text = draft.trim();
        if (!text || posting) return;
        setPosting(true);
        setPostError(null);
        try {
            await postEventChatMessage(postId, text);
            setDraft('');
            setImageNotice(null);
            await load();
        } catch (err: any) {
            setPostError(err?.message || 'Could not send that message.');
        } finally {
            setPosting(false);
        }
    };

    const send = async (e: React.FormEvent) => {
        e.preventDefault();
        await submitDraft();
    };

    const remove = async (m: EventThreadMessage) => {
        if (removingId) return;
        if (!window.confirm('Remove this message from the event chat?')) return;
        setRemovingId(m.id);
        setPostError(null);
        try {
            await removeEventChatMessage(postId, m.id);
            await load();
        } catch (err: any) {
            setPostError(err?.message || 'Could not remove that message.');
        } finally {
            setRemovingId(null);
        }
    };

    if (loadError && !view) {
        return (
            <div data-testid="event-chat" className="h-full w-full flex flex-col">
                <ChatHeader title="Event chat" onBack={onBack} onOpenEvent={onOpenEvent} />
                <p role="alert" data-testid="event-chat-error" className="m-4 text-sm text-nature-700 dark:text-nature-300">
                    {loadError}
                </p>
            </div>
        );
    }

    if (!view) {
        return (
            <div data-testid="event-chat" className="h-full w-full flex flex-col">
                <ChatHeader title="Event chat" onBack={onBack} onOpenEvent={onOpenEvent} />
                <p className="m-4 text-sm text-nature-500 dark:text-nature-400">Opening the chat…</p>
            </div>
        );
    }

    const canPost = view.canPost && !!identity;

    return (
        <div data-testid="event-chat" className="h-full max-w-4xl mx-auto w-full flex flex-col min-w-0">
            <ChatHeader title={view.title} onBack={onBack} onOpenEvent={onOpenEvent} />

            {view.privateNote && (
                <div
                    data-testid="event-chat-pinned-note"
                    className="flex-shrink-0 mx-3 mt-3 p-3 rounded-xl bg-violet-50 dark:bg-violet-950/40 border border-violet-200 dark:border-violet-800"
                >
                    <p className="m-0 mb-1 text-xs font-black uppercase tracking-wide text-violet-800 dark:text-violet-300">
                        📌 Note for people who are going
                    </p>
                    <p className="m-0 text-sm text-nature-900 dark:text-nature-100 whitespace-pre-wrap break-words">
                        {view.privateNote}
                    </p>
                </div>
            )}

            {view.readOnly && (
                <p
                    data-testid="event-chat-readonly"
                    className="flex-shrink-0 m-3 p-3 rounded-xl bg-nature-100 dark:bg-nature-800/60 text-sm italic text-nature-700 dark:text-nature-300 text-center"
                >
                    {view.readOnlyReason}
                </p>
            )}

            <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2">
                {view.messages.length === 0 ? (
                    <p className="m-0 py-4 text-sm italic text-nature-500 dark:text-nature-400">
                        {view.readOnly ? 'Nothing was said here.' : 'No messages yet. Say hello.'}
                    </p>
                ) : (
                    <ul className="m-0 p-0 list-none divide-y divide-nature-100 dark:divide-nature-800">
                        {view.messages.map(m => {
                            const isRemoved = m.type === 'removed';
                            const author = m.authorCallsign || m.authorPubkey?.slice(0, 8) || 'Member';
                            const avatar = resolveAvatarUrl(m.authorAvatar);
                            return (
                                <li key={m.id} className="py-3 flex items-start gap-2 min-w-0">
                                    {avatar ? (
                                        <img src={avatar} alt="" className="w-8 h-8 rounded-full object-cover flex-shrink-0 bg-nature-100 dark:bg-nature-800" />
                                    ) : (
                                        <div className="w-8 h-8 rounded-full flex-shrink-0 bg-nature-200 dark:bg-nature-700 flex items-center justify-center font-bold text-nature-700 dark:text-nature-200">
                                            {author.charAt(0).toUpperCase()}
                                        </div>
                                    )}
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-baseline gap-2 min-w-0">
                                            <span className="flex-1 min-w-0 truncate text-sm font-bold text-nature-900 dark:text-white">{author}</span>
                                            <span className="flex-shrink-0 text-[11px] text-nature-400">{formatTime(m.timestamp)}</span>
                                        </div>
                                        <p className={`m-0 mt-1 text-sm leading-relaxed whitespace-pre-wrap break-words ${isRemoved ? 'italic text-nature-400 dark:text-nature-500' : 'text-nature-800 dark:text-nature-200'}`}>
                                            {decodeEventChatText(m.ciphertext, m.type)}
                                        </p>
                                        {view.isHost && !isRemoved && (
                                            <button
                                                type="button"
                                                onClick={() => remove(m)}
                                                disabled={removingId === m.id}
                                                aria-label={`Remove message from ${author}`}
                                                className="mt-1 min-h-[48px] px-2 -ml-2 bg-transparent border-0 text-xs font-bold text-rose-600 dark:text-rose-400 cursor-pointer disabled:opacity-50"
                                            >
                                                {removingId === m.id ? 'Removing…' : 'Remove'}
                                            </button>
                                        )}
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )}
                <div ref={bottomRef} />
            </div>

            {postError && (
                <p role="alert" className="flex-shrink-0 m-0 px-3 pb-1 text-xs text-red-600 dark:text-red-400">{postError}</p>
            )}

            {imageNotice && (
                <div
                    role="status"
                    data-testid="event-chat-image-notice"
                    className="flex-shrink-0 flex items-center gap-2 px-3 pb-1 min-w-0"
                >
                    <span className="flex-1 min-w-0 text-xs text-nature-600 dark:text-nature-300 break-words">
                        {imageNotice}
                    </span>
                    <button
                        type="button"
                        onClick={() => setImageNotice(null)}
                        aria-label="Dismiss"
                        className="flex-shrink-0 min-h-[48px] px-3 -mr-1 bg-transparent border-0 text-sm text-nature-500 dark:text-nature-400 cursor-pointer"
                    >
                        ✕
                    </button>
                </div>
            )}

            {canPost && (
                <form
                    onSubmit={send}
                    className="flex-shrink-0 flex items-end gap-2 p-3 border-t border-nature-200 dark:border-nature-800"
                    onDragOver={e => { if (dragCarriesFile(e.dataTransfer)) e.preventDefault(); }}
                    onDrop={e => {
                        // Text dropped into the textarea is the browser's own
                        // business. A file is only here because onDragOver took
                        // it, so this drop has to be prevented whatever the file
                        // is — left to itself the browser navigates the tab to
                        // it, taking the chat and the unsent draft.
                        if (!dragCarriesFile(e.dataTransfer)) return;
                        e.preventDefault();
                        if (!imageFromTransfer(e.dataTransfer)) return;
                        setImageNotice('Photos can only be sent in direct messages');
                    }}
                >
                    <textarea
                        value={draft}
                        onChange={e => setDraft(e.target.value.slice(0, EVENT_CHAT_MESSAGE_MAX))}
                        onPaste={e => {
                            if (!imageFromTransfer(e.clipboardData)) return;
                            e.preventDefault();
                            setImageNotice('Photos can only be sent in direct messages');
                        }}
                        onKeyDown={e => {
                            // An input method is mid-word — Japanese, Chinese, Korean and
                            // the rest. Enter is how the person picks the characters they
                            // are composing, so it is never a send.
                            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                            // Enter sends; Shift+Enter inserts a newline.
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                void submitDraft();
                            }
                        }}
                        rows={1}
                        maxLength={EVENT_CHAT_MESSAGE_MAX}
                        placeholder="Message everyone going…"
                        aria-label="Message everyone going"
                        className="flex-1 min-w-0 min-h-[48px] resize-y rounded-xl border border-nature-300 dark:border-nature-700 bg-white dark:bg-nature-900 px-3 py-3 text-sm text-nature-900 dark:text-white"
                    />
                    <button
                        type="submit"
                        disabled={posting || !draft.trim()}
                        className="flex-shrink-0 min-h-[48px] px-4 rounded-xl bg-violet-700 text-white font-bold text-sm disabled:opacity-60"
                    >
                        {posting ? 'Sending…' : 'Send'}
                    </button>
                </form>
            )}

            <p data-testid="event-chat-notice" className="flex-shrink-0 m-0 px-3 pb-3 pt-2 text-[11px] text-nature-500 dark:text-nature-400 break-words">
                {view.notice}
            </p>
        </div>
    );
}

function ChatHeader({ title, onBack, onOpenEvent }: { title: string; onBack?: () => void; onOpenEvent?: () => void }) {
    return (
        <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 border-b border-nature-200 dark:border-nature-800 min-w-0">
            {onBack && (
                <button
                    type="button"
                    onClick={onBack}
                    aria-label="Back"
                    className="flex-shrink-0 min-h-[48px] px-2 bg-transparent border-0 text-violet-700 dark:text-violet-300 text-base cursor-pointer"
                >
                    ←
                </button>
            )}
            <div className="min-w-0 flex-1">
                <p className="m-0 truncate text-base font-extrabold text-nature-950 dark:text-white">{title}</p>
                <p className="m-0 text-[11px] font-semibold text-violet-700 dark:text-violet-300">Event chat</p>
            </div>
            {onOpenEvent && (
                <button
                    type="button"
                    data-testid="event-chat-open-event"
                    onClick={onOpenEvent}
                    className="flex-shrink-0 min-h-[48px] px-3 rounded-xl border border-violet-300 dark:border-violet-800 bg-transparent text-sm font-bold text-violet-800 dark:text-violet-200 cursor-pointer"
                >
                    View event
                </button>
            )}
        </div>
    );
}
