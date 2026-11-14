/**
 * Chats with people in other communities on the web (messages across communities X4; the phone's app/outside-chat/[id].tsx and
 * its Chats row, X3): the row in the list, the card behind "Message requests", and the chat itself. Its lines are kept in this
 * browser only (lib/outside-chat-store.ts), and the chat says so above its first line; a chat this browser learned of from the
 * outbox is empty, and says why. A request shows its one line with Accept, Decline and Block, and takes no reply until Accept.
 * The other person's community always shows, on its own line that wraps (joint design §2.6): their name is their own choice,
 * never checked by this community, shown "name not confirmed here".
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { OUTSIDE_LINE_TEXT_MAX, t } from '@beanpool/core';
import { blockUser } from '../lib/blocklist';
import {
    OUTSIDE_CHATS_EVENT, OUTSIDE_SEND_MS, outsideContext, outsideErrorWords, ring, sendFromBox, syncOutsideMailNow,
} from '../lib/outside-mail';
import type { OutsideChat, OutsideLine, OutsideLineState } from '../lib/outside-chat-store';

/** How often an open chat asks for what waits, while it is on screen. */
const POLL_MS = 15_000;

const button: CSSProperties = {
    minHeight: '44px', padding: '0.5rem 1rem', borderRadius: '10px', fontFamily: 'inherit', fontSize: '0.9rem', fontWeight: 700,
    cursor: 'pointer', flex: '1 1 6rem', border: '1px solid var(--border-primary)', background: 'var(--bg-hover)', color: 'var(--text-primary)',
};
const commit: CSSProperties = { ...button, border: 'none', background: 'var(--bp-commit-fill)', color: 'var(--bp-commit-on)' };
const danger: CSSProperties = { ...button, border: '1px solid var(--bp-chip-danger-ink)', background: 'var(--bp-chip-danger-tint)', color: 'var(--bp-chip-danger-ink)' };
const wrap: CSSProperties = { overflowWrap: 'anywhere', wordBreak: 'break-word' };

/** Their name as shown: the one they gave, else who they are in words. */
export function outsideName(chat: Pick<OutsideChat, 'peerName'>): string {
    return chat.peerName ?? t('Someone in another community');
}

/** Their community, as its own line: with "name not confirmed here" when a name is shown. */
function fromLine(chat: Pick<OutsideChat, 'peerName' | 'peerHome'>): string {
    return chat.peerName ? t('{community} · name not confirmed here', { community: chat.peerHome }) : chat.peerHome;
}

function stateWords(state: OutsideLineState | null): string | null {
    switch (state) {
        case 'sending': return t('Sending…');
        case 'queued': return t('Waiting for their community');
        case 'sent': return t('Sent', undefined, 'a message');
        case 'delivered': return t('Delivered', undefined, 'a message');
        case 'failed': case 'expired': return t('Not delivered');
        default: return null;
    }
}

/** A chat in the list: their name, their community on its own line, the newest line. */
export function OutsideChatRow({ chat, onOpen }: { chat: OutsideChat; onOpen: () => void }) {
    return (
        <button type="button" data-testid="outside-chat-row" onClick={onOpen} style={{
            display: 'block', width: '100%', textAlign: 'left', padding: '0.75rem 1rem', minHeight: '44px', background: 'none', border: 'none',
            color: 'var(--text-primary)', font: 'inherit', cursor: 'pointer',
        }}>
            <span style={{ display: 'block', fontWeight: 600, fontSize: '0.95rem', ...wrap }}>{outsideName(chat)}</span>
            <span data-testid="outside-chat-row-home" style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-secondary)', ...wrap }}>
                <span aria-hidden="true">🌐 </span>{chat.peerHome}
            </span>
            {chat.lastText && (
                <span style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{chat.lastText}</span>
            )}
        </button>
    );
}

/** A request from another community, behind "Message requests": who, from where, and the way into the chat to decide. */
export function OutsideRequestCard({ chat, onOpen }: { chat: OutsideChat; onOpen: () => void }) {
    const name = outsideName(chat);
    return (
        <li data-testid="outside-request-card" style={{
            listStyle: 'none', background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: '12px',
            padding: '0.85rem 1rem', marginBottom: '0.75rem',
        }}>
            <p style={{ margin: 0, fontWeight: 700, fontSize: '1rem', ...wrap }}>{name}</p>
            <p style={{ margin: '0.15rem 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)', ...wrap }}>{fromLine(chat)}</p>
            <button type="button" onClick={onOpen} data-testid="outside-request-open" style={{
                display: 'block', width: '100%', textAlign: 'left', margin: '0.6rem 0 0', padding: '0.6rem 0.75rem', minHeight: '44px',
                background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', borderRadius: '10px', color: 'var(--text-primary)',
                font: 'inherit', fontSize: '0.95rem', cursor: 'pointer', ...wrap,
            }}>
                <span dir="auto" style={{ display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden', whiteSpace: 'pre-wrap' }}>
                    {chat.lastText ?? t('Open the chat to read it.')}
                </span>
            </button>
        </li>
    );
}

/** The chat itself: kept in this browser only; a request's Accept, Decline and Block; the box once it is open. */
export function OutsideChatThread({ chatId, onBack }: { chatId: string; onBack: () => void }) {
    const [me, setMe] = useState<string | null>(null);
    const [chat, setChat] = useState<OutsideChat | null | undefined>(undefined);
    const [lines, setLines] = useState<OutsideLine[]>([]);
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const alive = useRef(true);
    const endRef = useRef<HTMLDivElement | null>(null);

    const load = useCallback(async () => {
        const ctx = await outsideContext();
        if (!alive.current) return;
        if (!ctx) { setChat(null); return; }
        setMe(ctx.identity.publicKey);
        const c = await ctx.store.chat(ctx.identity.publicKey, chatId).catch(() => null);
        const l = c ? await ctx.store.lines(ctx.identity.publicKey, c.id).catch(() => []) : [];
        if (!alive.current) return;
        setChat(c);
        setLines(l);
    }, [chatId]);

    useEffect(() => {
        alive.current = true;
        void load();
        void syncOutsideMailNow().then(load);
        const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void syncOutsideMailNow().then(load); }, POLL_MS);
        window.addEventListener(OUTSIDE_CHATS_EVENT, load);
        return () => { alive.current = false; clearInterval(timer); window.removeEventListener(OUTSIDE_CHATS_EVENT, load); };
    }, [load]);
    useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }); }, [lines.length]);

    const send = async () => {
        const words = text.trim();
        if (!words || busy || !chat) return;
        setBusy(true);
        setNote(null);
        try {
            const ctx = await outsideContext();
            if (!ctx) return;
            // The box empties once the line is kept here (it shows at once, Sending…), never before; words typed meanwhile stay.
            const { kept, error } = await sendFromBox(ctx, chat.id, words, OUTSIDE_SEND_MS, () => {
                setText((now) => (now.trim() === words ? '' : now));
                void load();
            });
            if (error && alive.current) setNote(outsideErrorWords(error, kept));
            await load();
        } finally {
            if (alive.current) setBusy(false);
        }
    };

    const decide = async (state: 'open' | 'declined') => {
        const ctx = await outsideContext();
        if (!ctx || !chat) return;
        await ctx.store.decide(ctx.identity.publicKey, chat.id, state);
        ring();
        if (state === 'declined') { onBack(); return; }
        await load();
    };

    const block = async () => {
        if (!chat) return;
        const name = outsideName(chat);
        if (!window.confirm(`${t('Block {name}?', { name })}\n\n${t("They won't be told. Nothing more from them will reach you.")}`)) return;
        try {
            await blockUser(chat.peerKey);
        } catch (e) {
            // A BlocklistError, in words: the node didn't take the block, so nothing changes here.
            setNote((e as Error).message);
            return;
        }
        await decide('declined');
    };

    if (chat === undefined) return <div className="p-4 max-w-3xl mx-auto w-full" />;
    const name = chat ? outsideName(chat) : '';

    return (
        <div data-testid="outside-chat" className="p-4 max-w-3xl mx-auto w-full" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button type="button" onClick={onBack} style={{ ...button, flex: '0 0 auto', background: 'none', border: 'none', paddingLeft: 0 }}>
                    <span aria-hidden="true">‹ </span>{t('Back to chats')}
                </button>
                {chat && chat.state !== 'request' && (
                    <button type="button" data-testid="outside-chat-block" onClick={() => void block()} style={{ ...danger, flex: '0 0 auto', marginLeft: 'auto' }}>
                        {t('Block')}
                    </button>
                )}
            </div>
            {!chat ? (
                <p style={{ color: 'var(--text-secondary)' }}>{t('This chat is not in this browser.')}</p>
            ) : (
                <>
                    <div>
                        <h2 style={{ margin: 0, fontSize: '1.2rem', ...wrap }}>{name}</h2>
                        <p data-testid="outside-chat-home" style={{ margin: '0.15rem 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)', ...wrap }}>{fromLine(chat)}</p>
                    </div>
                    <div data-testid="outside-chat-kept-here" style={{
                        padding: '0.75rem', borderRadius: '12px', background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', fontSize: '0.85rem',
                    }}>
                        <p style={{ margin: 0, fontWeight: 600, color: 'var(--text-primary)' }}>{t('Kept in this browser only. Your community keeps no copy.')}</p>
                        {chat.restored && lines.length === 0 && (
                            <p data-testid="outside-chat-restored" style={{ margin: '0.4rem 0 0', color: 'var(--text-secondary)' }}>
                                {t("Earlier messages in this chat aren't in this browser. Messages with people in other communities are kept only on the phone or browser that got them.")}
                            </p>
                        )}
                    </div>
                    <div role="log" style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                        {lines.map((l) => {
                            const mine = l.author === me;
                            const tick = mine ? stateWords(l.state) : null;
                            const why = mine && l.state === 'failed' ? l.note : null;
                            return (
                                <div key={l.id} data-testid={mine ? 'outside-line-mine' : 'outside-line-theirs'} style={{
                                    alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '85%', padding: '0.5rem 0.75rem', borderRadius: '14px',
                                    background: mine ? 'var(--bp-sage-fill)' : 'var(--bg-card)', color: mine ? 'var(--bp-sage-on)' : 'var(--text-primary)',
                                    border: mine ? 'none' : '1px solid var(--border-primary)',
                                }}>
                                    <span dir="auto" style={{ whiteSpace: 'pre-wrap', ...wrap }}>{l.text}</span>
                                    {tick && <span data-testid="outside-line-state" style={{ display: 'block', fontSize: '0.75rem', textAlign: 'right', opacity: 0.9 }}>{tick}</span>}
                                    {why && <span data-testid="outside-line-why" style={{ display: 'block', fontSize: '0.75rem', opacity: 0.9, ...wrap }}>{why}</span>}
                                </div>
                            );
                        })}
                        <div ref={endRef} />
                    </div>
                    {note && <p role="alert" style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)', ...wrap }}>{note}</p>}
                    {chat.state === 'request' ? (
                        <div data-testid="outside-request" style={{ padding: '0.85rem', borderRadius: '12px', background: 'var(--bg-card)', border: '1px solid var(--border-primary)' }}>
                            <p style={{ margin: '0 0 0.6rem', fontSize: '0.9rem', ...wrap }}>
                                {t('{name} from {community} wants to message you. They will not know you saw this unless you accept.', { name, community: chat.peerHome })}
                            </p>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                                <button type="button" data-testid="outside-request-accept" style={{ ...commit, flex: '1 1 100%' }} onClick={() => void decide('open')}>
                                    {t('Accept', undefined, 'button: accept a message request')}
                                </button>
                                <button type="button" data-testid="outside-request-decline" style={button} onClick={() => void decide('declined')}>
                                    {t('Decline', undefined, 'button: decline a message request')}
                                </button>
                                <button type="button" data-testid="outside-request-block" style={danger} onClick={() => void block()}>{t('Block')}</button>
                            </div>
                        </div>
                    ) : chat.state === 'open' ? (
                        <form onSubmit={(e) => { e.preventDefault(); void send(); }} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
                            <textarea
                                data-testid="outside-chat-input"
                                value={text}
                                onChange={(e) => setText(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
                                placeholder={t('Message')}
                                aria-label={t('Message {name}', { name })}
                                maxLength={OUTSIDE_LINE_TEXT_MAX}
                                rows={2}
                                style={{
                                    flex: 1, minWidth: 0, minHeight: '44px', padding: '0.6rem 0.75rem', borderRadius: '12px', border: '1px solid var(--border-input)',
                                    background: 'var(--bg-input)', color: 'var(--text-primary)', font: 'inherit', resize: 'vertical',
                                }}
                            />
                            <button type="submit" data-testid="outside-chat-send" disabled={busy || !text.trim()} style={{ ...commit, flex: '0 0 auto', opacity: busy || !text.trim() ? 0.6 : 1 }}>
                                {t('Send')}
                            </button>
                        </form>
                    ) : null}
                </>
            )}
        </div>
    );
}
