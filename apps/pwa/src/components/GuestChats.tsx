/**
 * Group chats hosted by other communities, as a guest, in the web app (slice G2: DESIGN-cross-chat-voice-fable.md §4.2; the
 * phone's app/guest-chat/[id].tsx). Kept in this browser only (lib/guest-chat-live.ts). An invitation waits behind the one
 * "Message requests" row, naming who invited, the group and its community; nothing of the group's reaches this browser before
 * Accept. In the chat a guest reads, writes and sees the names in it, nothing else of the group (core guestAccess). A closed
 * chat keeps what was here and says why, with no box to write in. Also the convenor's side: the group's guests and Add
 * someone from another community (GroupGuestsPanel).
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import {
    GUEST_CHAT_WORDS, GUEST_LINE_TEXT_MAX, addressCardFromText, guestAccess, guestChatAuthorName, guestClosedWords, guestNameLine, guestViewerOf, t,
    type GuestChat, type GuestLineState,
} from '@beanpool/core';
import { outsideErrorWords } from '../lib/outside-mail';
import { loadIdentity } from '../lib/identity';
import type { OutsideChat } from '../lib/outside-chat-store';
import {
    GUEST_CHATS_EVENT, answerInvitation, fetchGroupGuests, inviteGroupGuest, leaveGuestChatNow, loadGuestChats, removeGroupGuest, sendGuestLineNow,
    syncGuestMailNow, type GroupGuest,
} from '../lib/guest-chat-live';
import { ChatConfirmDialog } from './ChatConfirmDialog';

const W = GUEST_CHAT_WORDS;
const POLL_MS = 15_000;

const button: CSSProperties = {
    minHeight: '44px', padding: '0.5rem 1rem', borderRadius: '10px', fontFamily: 'inherit', fontSize: '0.9rem', fontWeight: 700,
    cursor: 'pointer', flex: '1 1 6rem', border: '1px solid var(--border-primary)', background: 'var(--bg-hover)', color: 'var(--text-primary)',
};
const commit: CSSProperties = { ...button, border: 'none', background: 'var(--bp-commit-fill)', color: 'var(--bp-commit-on)' };
const wrap: CSSProperties = { overflowWrap: 'anywhere', wordBreak: 'break-word' };

/** A line of mine, as its tick reads. */
function stateWords(state: GuestLineState | undefined): string | null {
    switch (state) {
        case 'waiting': return t(W.waiting);
        case 'sending': return t('Sending…');
        case 'queued': return t('Waiting for their community');
        case 'sent': return t('Sent', undefined, 'a message');
        case 'failed': return t('Not delivered');
        default: return null;
    }
}

/** The guest chats in this browser, read again at each change, and a round now and every half minute while seen. */
export function useGuestChats(publicKey: string): GuestChat[] {
    const [chats, setChats] = useState<GuestChat[]>([]);
    useEffect(() => {
        let alive = true;
        const read = () => { void loadGuestChats().then((all) => { if (alive) setChats(Object.values(all)); }, () => {}); };
        read();
        // syncGuestMailNow never throws: the guests' mail can never take Chat down.
        void syncGuestMailNow().then(read);
        const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void syncGuestMailNow().then(read); }, 30_000);
        window.addEventListener(GUEST_CHATS_EVENT, read);
        return () => { alive = false; clearInterval(timer); window.removeEventListener(GUEST_CHATS_EVENT, read); };
    }, [publicKey]);
    return chats;
}

/**
 * A guest chat as the chat list orders an outside chat (lib/chat-list-order.ts): by its newest line. Its id is the guest
 * chat's, so the list draws a GuestChatRow for it.
 */
export function guestChatAsListed(c: GuestChat): OutsideChat {
    const last = c.lines[c.lines.length - 1];
    return { id: c.id, peerKey: c.id, peerHome: c.host, peerName: c.name, state: 'open', restored: false, updatedAt: c.updatedAt, lastText: last?.text ?? null, lastAt: last?.at ?? null };
}

/** A group chat elsewhere, in the chat list: the group's name, its community under it. */
export function GuestChatRow({ chat, onOpen }: { chat: GuestChat; onOpen: () => void }) {
    const last = chat.lines[chat.lines.length - 1];
    return (
        <button type="button" data-testid="guest-chat-row" onClick={onOpen} style={{
            display: 'block', width: '100%', textAlign: 'left', padding: '0.75rem 1rem', minHeight: '44px', background: 'none', border: 'none',
            color: 'var(--text-primary)', font: 'inherit', cursor: 'pointer',
        }}>
            <span style={{ display: 'block', fontWeight: 600, fontSize: '0.95rem', ...wrap }}>{chat.name || t('Group chat')}</span>
            <span data-testid="guest-chat-row-home" style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-secondary)', ...wrap }}>
                <span aria-hidden="true">👥 </span>{chat.host}
            </span>
            {last && <span style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{last.text}</span>}
        </button>
    );
}

/** An invitation behind "Message requests": the group, its community, who invited, and the way in to decide. */
export function GuestInvitationCard({ chat, onOpen }: { chat: GuestChat; onOpen: () => void }) {
    return (
        <li data-testid="guest-invitation-card" style={{
            listStyle: 'none', background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: '12px', padding: '0.85rem 1rem', marginBottom: '0.75rem',
        }}>
            <p style={{ margin: 0, fontWeight: 700, fontSize: '1rem', ...wrap }}>{t(W.invitedCard, { group: chat.name, community: chat.host })}</p>
            <p style={{ margin: '0.15rem 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)', ...wrap }}>
                {t(W.invitedYou, { name: chat.invitedBy?.name || t('Someone'), group: chat.name, community: chat.host })}
            </p>
            <button type="button" onClick={onOpen} data-testid="guest-invitation-open" style={{ ...button, display: 'block', width: '100%', textAlign: 'left', margin: '0.6rem 0 0' }}>
                {t('Open to accept or decline')}
            </button>
        </li>
    );
}

/** The chat itself, or its invitation (the file's header). */
export function GuestChatThread({ chatId, onBack }: { chatId: string; onBack: () => void }) {
    const [chat, setChat] = useState<GuestChat | null | undefined>(undefined);
    const [me, setMe] = useState<string | null>(null);
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const [askLeave, setAskLeave] = useState(false);
    const alive = useRef(true);

    const load = useCallback(async () => {
        const all = await loadGuestChats().catch(() => ({}) as Record<string, GuestChat>);
        if (!alive.current) return;
        setChat(all[chatId] ?? null);
    }, [chatId]);

    useEffect(() => {
        alive.current = true;
        void loadIdentity().then((id) => { if (alive.current) setMe(id?.publicKey ?? null); }, () => {});
        void load();
        void syncGuestMailNow().then(load);
        const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void syncGuestMailNow().then(load); }, POLL_MS);
        window.addEventListener(GUEST_CHATS_EVENT, load);
        return () => { alive.current = false; clearInterval(timer); window.removeEventListener(GUEST_CHATS_EVENT, load); };
    }, [load]);

    const send = async () => {
        const words = text.trim();
        if (!words || busy || !chat) return;
        setBusy(true);
        setNote(null);
        try {
            const kept = await sendGuestLineNow(chat.id, words);
            if (kept) setText((now) => (now.trim() === words ? '' : now));
        } catch (e) {
            setNote(outsideErrorWords(e));
        } finally {
            setBusy(false);
            void load();
        }
    };

    const answer = async (yes: boolean) => {
        if (!chat || busy) return;
        setBusy(true);
        setNote(null);
        try {
            await answerInvitation(chat.id, yes ? 'yes' : 'no');
            if (!yes) { onBack(); return; }
            void syncGuestMailNow().then(load);
        } catch (e) {
            setNote(outsideErrorWords(e, false));
        } finally {
            setBusy(false);
            void load();
        }
    };

    /** Leave, once confirmed: the chat closes here at once (core leaveGuestChat), and my leave goes. */
    const leave = async () => {
        setAskLeave(false);
        if (!chat || busy) return;
        setBusy(true);
        setNote(null);
        try {
            await leaveGuestChatNow(chat.id);
        } catch (e) {
            setNote(outsideErrorWords(e, false));
        } finally {
            setBusy(false);
            void load();
        }
    };

    if (chat === undefined) return <div data-testid="guest-chat" />;
    const viewer = chat ? guestViewerOf(chat) : null;
    const canWrite = !!chat && chat.state === 'in' && viewer !== null && guestAccess(viewer, 'chat') === 'shown';
    // Leave while joining or in; once out there is nothing to leave.
    const canLeave = !!chat && (chat.state === 'in' || chat.state === 'joining');
    // Why it is closed: core's one sentence for each reason the host gives, the same on the phone.
    const closed = chat ? guestClosedWords(chat) : null;
    const names = chat?.roster && viewer !== null && guestAccess(viewer, 'roster') === 'shown'
        ? [...chat.roster.members.map((m) => m.name), ...chat.roster.guests.map((g) => guestNameLine(g.name, g.home))].join(', ')
        : null;

    return (
        <div data-testid="guest-chat" className="p-4 max-w-3xl mx-auto w-full" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div>
                <button type="button" onClick={onBack} style={{ ...button, flex: '0 0 auto', background: 'none', border: 'none', paddingLeft: 0 }}>
                    <span aria-hidden="true">‹ </span>{t('Back to chats')}
                </button>
            </div>
            {!chat ? (
                <p style={{ color: 'var(--text-secondary)' }}>{t('This chat is not in this browser.')}</p>
            ) : (
                <>
                    <div>
                        <h2 style={{ margin: 0, fontSize: '1.2rem', ...wrap }}>{chat.name || t('Group chat')}</h2>
                        <p data-testid="guest-chat-from" style={{ margin: '0.15rem 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)', ...wrap }}>{chat.host}</p>
                        {names && <p data-testid="guest-chat-names" style={{ margin: '0.15rem 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)', ...wrap }}>{names}</p>}
                    </div>
                    {chat.state === 'invited' ? (
                        <div data-testid="guest-invitation" style={{ padding: '0.85rem', borderRadius: '12px', background: 'var(--bg-card)', border: '1px solid var(--border-primary)' }}>
                            <p style={{ margin: '0 0 0.4rem', fontSize: '0.9rem', ...wrap }}>
                                {t(W.invitedYou, { name: chat.invitedBy?.name || t('Someone'), group: chat.name, community: chat.host })}
                            </p>
                            <p style={{ margin: '0 0 0.6rem', fontSize: '0.85rem', color: 'var(--text-secondary)', ...wrap }}>{t(W.youAreGuest)}</p>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                                <button type="button" data-testid="guest-invitation-accept" disabled={busy} style={{ ...commit, flex: '1 1 100%' }} onClick={() => void answer(true)}>
                                    {t('Accept', undefined, 'button: accept a message request')}
                                </button>
                                <button type="button" data-testid="guest-invitation-decline" disabled={busy} style={button} onClick={() => void answer(false)}>
                                    {t('Decline', undefined, 'button: decline a message request')}
                                </button>
                            </div>
                        </div>
                    ) : (
                        <>
                            <div data-testid="guest-chat-banner" style={{ padding: '0.75rem', borderRadius: '12px', background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', fontSize: '0.85rem' }}>
                                <p style={{ margin: 0, fontWeight: 600, color: 'var(--text-primary)' }}>{t(W.youAreGuest)}</p>
                                <p style={{ margin: '0.4rem 0 0', color: 'var(--text-secondary)' }}>{t('Kept in this browser only. Your community keeps no copy.')}</p>
                                <p style={{ margin: '0.4rem 0 0', color: 'var(--text-secondary)' }}>{t(W.newDevice)}</p>
                                {chat.state === 'joining' && <p data-testid="guest-chat-joining" style={{ margin: '0.4rem 0 0', fontWeight: 600 }}>{t(W.joining)}</p>}
                                {closed && <p data-testid="guest-chat-closed" style={{ margin: '0.4rem 0 0', fontWeight: 600 }}>{closed}</p>}
                            </div>
                            <div role="log" style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                                {chat.lines.map((l, i) => {
                                    const mine = l.author === me;
                                    const tick = mine ? stateWords(l.state) : null;
                                    const who = mine ? null : guestChatAuthorName(chat, l.author);
                                    const showWho = !mine && chat.lines[i - 1]?.author !== l.author;
                                    return (
                                        <div key={l.id} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
                                            {showWho && <span data-testid="guest-line-author" style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', margin: '0.3rem 0 0.1rem', ...wrap }}>{who}</span>}
                                            <div data-testid={mine ? 'guest-line-mine' : 'guest-line-theirs'} style={{
                                                padding: '0.5rem 0.75rem', borderRadius: '14px',
                                                background: mine ? 'var(--bp-sage-fill)' : 'var(--bg-card)', color: mine ? 'var(--bp-sage-on)' : 'var(--text-primary)',
                                                border: mine ? 'none' : '1px solid var(--border-primary)',
                                            }}>
                                                <span dir="auto" style={{ whiteSpace: 'pre-wrap', ...wrap }}>{l.text}</span>
                                                {tick && <span data-testid="guest-line-state" style={{ display: 'block', fontSize: '0.75rem', textAlign: 'right', opacity: 0.9 }}>{tick}</span>}
                                                {mine && l.state === 'failed' && l.note && <span style={{ display: 'block', fontSize: '0.75rem', opacity: 0.9, ...wrap }}>{l.note}</span>}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </>
                    )}
                    {note && <p role="alert" style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)', ...wrap }}>{note}</p>}
                    {canWrite && (
                        <form onSubmit={(e) => { e.preventDefault(); void send(); }} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
                            <textarea
                                data-testid="guest-chat-input"
                                value={text}
                                onChange={(e) => setText(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
                                placeholder={t('Message')}
                                aria-label={t('Message {name}', { name: chat.name })}
                                maxLength={GUEST_LINE_TEXT_MAX}
                                rows={2}
                                style={{
                                    flex: 1, minWidth: 0, minHeight: '44px', padding: '0.6rem 0.75rem', borderRadius: '12px', border: '1px solid var(--border-input)',
                                    background: 'var(--bg-input)', color: 'var(--text-primary)', font: 'inherit', resize: 'vertical',
                                }}
                            />
                            <button type="submit" data-testid="guest-chat-send" disabled={busy || !text.trim()} style={{ ...commit, flex: '0 0 auto', opacity: busy || !text.trim() ? 0.6 : 1 }}>
                                {t('Send')}
                            </button>
                        </form>
                    )}
                    {canLeave && (
                        <button type="button" data-testid="guest-chat-leave" disabled={busy} style={{ ...button, width: '100%', flex: '0 0 auto', opacity: busy ? 0.6 : 1 }}
                            onClick={() => setAskLeave(true)}>
                            {t(W.leave)}
                        </button>
                    )}
                    <ChatConfirmDialog
                        isOpen={askLeave && canLeave}
                        title={t(W.leaveAsk)}
                        message={t(W.leaveWhat)}
                        cancelLabel={t('Cancel')}
                        confirmLabel={t(W.leaveYes)}
                        destructive
                        onCancel={() => setAskLeave(false)}
                        onConfirm={() => void leave()}
                    />
                </>
            )}
        </div>
    );
}

/**
 * "Guests from other communities", under a group's members: each as core's guest line, and for a convenor those asked and
 * not answered yet, with Add someone from another community by their card. The community's server decides who sees what.
 */
export function GroupGuestsPanel({ groupId, isConvenor }: { groupId: string; isConvenor: boolean }) {
    const [guests, setGuests] = useState<GroupGuest[]>([]);
    const [on, setOn] = useState(false);
    const [adding, setAdding] = useState(false);
    const [pasted, setPasted] = useState('');
    const [note, setNote] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    // The guest whose Remove was tapped: asked under their row (inside the group's page, which sits above any dialog of the chat's).
    const [asking, setAsking] = useState<string | null>(null);

    const load = useCallback(async () => {
        const next = await fetchGroupGuests(groupId).catch(() => null);
        if (!next) return;
        setGuests(next.guests);
        setOn(next.on);
    }, [groupId]);
    useEffect(() => { void load(); }, [load]);

    /** Remove, once confirmed: the host takes them out (an invitation withdrawn) and tells their community. */
    const remove = async (g: GroupGuest) => {
        setAsking(null);
        if (busy) return;
        setBusy(true);
        setNote(null);
        try {
            await removeGroupGuest(groupId, g.key);
            setNote(t(W.removedNote));
            await load();
        } catch (e) {
            setNote(outsideErrorWords(e, false));
        } finally {
            setBusy(false);
        }
    };

    const add = async () => {
        const card = addressCardFromText(pasted);
        if (!card) { setNote(t(W.notACard)); return; }
        setBusy(true);
        try {
            await inviteGroupGuest(groupId, card);
            setPasted('');
            setAdding(false);
            setNote(t(W.guestAdded));
            await load();
        } catch (e) {
            setNote(outsideErrorWords(e, false));
        } finally {
            setBusy(false);
        }
    };

    const mayInvite = isConvenor && on && guestAccess('convenor', 'invite') === 'shown';
    if (guests.length === 0 && !mayInvite) return null;
    return (
        <div data-testid="group-guests" style={{ marginTop: '1rem' }}>
            <p style={{ margin: '0 0 0.4rem', fontSize: '0.75rem', fontWeight: 800, letterSpacing: '0.04em', color: 'var(--text-secondary)' }}>{t(W.guestsTitle)}</p>
            {guests.map((g) => (
                <div key={g.key} data-testid="group-guest-row" style={{
                    display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 0', borderBottom: '1px solid var(--border-primary)',
                }}>
                    <div style={{ flex: '1 1 10rem', minWidth: 0 }}>
                        <span style={{ display: 'block', fontWeight: 700, fontSize: '0.9rem', ...wrap }}>{guestNameLine(g.name, g.home)}</span>
                        <span style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{g.state === 'in' ? t(W.guestIn) : t(W.guestAsked)}</span>
                    </div>
                    {/* A convenor's Remove (the host refuses anyone else), asked first. */}
                    {isConvenor && (g.state === 'in' || g.state === 'invited') && asking !== g.key && (
                        <button type="button" data-testid="group-guest-remove" disabled={busy} aria-label={t(W.removeLabel, { name: guestNameLine(g.name, g.home) })}
                            style={{ ...button, flex: '0 0 auto', opacity: busy ? 0.6 : 1 }} onClick={() => { setAsking(g.key); setNote(null); }}>
                            {t(W.remove)}
                        </button>
                    )}
                    {isConvenor && asking === g.key && (
                        <div role="group" data-testid="group-guest-remove-ask" aria-label={t(W.removeAsk, { name: guestNameLine(g.name, g.home) })} style={{ flex: '1 1 100%' }}>
                            <p style={{ margin: 0, fontWeight: 700, fontSize: '0.9rem', ...wrap }}>{t(W.removeAsk, { name: guestNameLine(g.name, g.home) })}</p>
                            <p style={{ margin: '0.2rem 0 0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)', ...wrap }}>
                                {g.state === 'invited' ? t(W.removeWhatAsked) : t(W.removeWhatIn)}
                            </p>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                                <button type="button" data-testid="group-guest-remove-cancel" style={button} onClick={() => setAsking(null)}>{t('Cancel')}</button>
                                <button type="button" data-testid="group-guest-remove-yes" disabled={busy}
                                    style={{ ...button, border: 'none', background: 'var(--bp-danger-fill)', color: 'var(--bp-danger-on)', opacity: busy ? 0.6 : 1 }}
                                    onClick={() => void remove(g)}>
                                    {t(W.remove)}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            ))}
            {mayInvite && !adding && (
                <button type="button" data-testid="group-guest-add" style={{ ...button, width: '100%', marginTop: '0.5rem' }} onClick={() => { setAdding(true); setNote(null); }}>
                    {t(W.addGuest)}
                </button>
            )}
            {mayInvite && adding && (
                <div data-testid="group-guest-add-form" style={{ marginTop: '0.5rem' }}>
                    <p style={{ margin: '0 0 0.4rem', fontSize: '0.85rem', color: 'var(--text-secondary)', ...wrap }}>{t(W.addGuestHint)}</p>
                    <textarea data-testid="group-guest-card" value={pasted} onChange={(e) => setPasted(e.target.value)} rows={3} aria-label={t('Paste their card here')}
                        placeholder={t('Paste their card here')} style={{
                            width: '100%', minHeight: '44px', padding: '0.6rem 0.75rem', borderRadius: '10px', border: '1px solid var(--border-input)',
                            background: 'var(--bg-input)', color: 'var(--text-primary)', font: 'inherit', boxSizing: 'border-box',
                        }} />
                    <button type="button" data-testid="group-guest-read" disabled={busy || !pasted.trim()} style={{ ...commit, width: '100%', marginTop: '0.5rem', opacity: busy || !pasted.trim() ? 0.6 : 1 }}
                        onClick={() => void add()}>
                        {t(W.readCard)}
                    </button>
                </div>
            )}
            {note && <p role="status" data-testid="group-guest-note" style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', ...wrap }}>{note}</p>}
        </div>
    );
}
