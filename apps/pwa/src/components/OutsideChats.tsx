/**
 * Chats with people in other communities on the web (messages across communities X4; the phone's app/outside-chat/[id].tsx and
 * its Chats row, X3): the row in the list, the card behind "Message requests", and the chat itself. Its lines are kept in this
 * browser only (lib/outside-chat-store.ts), and the chat says so above its first line; a chat this browser learned of from the
 * outbox is empty, and says why. A request shows its one line with Accept, Decline and Block, and takes no reply until Accept.
 * The other person's community always shows, on its own line that wraps (joint design §2.6): their name is their own choice,
 * never checked by this community, shown "name not confirmed here". In an open chat a tap on a line offers the chat's
 * reactions and, on a line of mine, Edit message and Delete message (X6: each a sealed item of its own, lib/outside-mail.ts
 * sendOutsideChange). A tap on a line of theirs offers Report message in every state of the chat, a request's included (design
 * §3.5: Accept, Decline, Report; lib/outside-mail.ts reportOutsideLine). One rule, the phone's too: core outsideLineActions.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import {
    ACROSS_FIRST_LINE_NOTE, OUTSIDE_LINE_TEXT_MAX, OUTSIDE_REACTIONS, OUTSIDE_WRITES_STAY_THERE, acrossFirstLineNoteUnder, outsideLineActions, outsideLineShown, t,
    type OutsideChange, type OutsideChangeKind,
} from '@beanpool/core';
import { blockUser } from '../lib/blocklist';
import { ChatConfirmDialog } from './ChatConfirmDialog';
import { ReportModal } from './ReportModal';
import { draftKey, draftSent, keepEdit, keptDraft, takeEdit, useKeptDraft } from '../lib/chat-drafts';
import {
    OUTSIDE_CHATS_EVENT, OUTSIDE_SEND_MS, OutsideMailError, heldReceiptsOn, outsideContext, outsideErrorWords, outsideQuiet, reportOutsideLine, ring, sendFromBox, sendOutsideChange,
    setOutsideQuiet, syncOutsideMailNow,
} from '../lib/outside-mail';
import type { OutsideChat, OutsideLine, OutsideLineState } from '../lib/outside-chat-store';

/** Core's sentence, the phone's too (@beanpool/core outside-devices.ts): my own lines stay where I wrote them (X2b). */
const LINES = { writesStayThere: OUTSIDE_WRITES_STAY_THERE, firstLineNote: ACROSS_FIRST_LINE_NOTE };

/** How often an open chat asks for what waits, while it is on screen. */
const POLL_MS = 15_000;

const button: CSSProperties = {
    minHeight: '44px', padding: '0.5rem 1rem', borderRadius: '10px', fontFamily: 'inherit', fontSize: '0.9rem', fontWeight: 700,
    cursor: 'pointer', flex: '1 1 6rem', border: '1px solid var(--border-primary)', background: 'var(--bg-hover)', color: 'var(--text-primary)',
};
const commit: CSSProperties = { ...button, border: 'none', background: 'var(--bp-commit-fill)', color: 'var(--bp-commit-on)' };
const danger: CSSProperties = { ...button, border: '1px solid var(--bp-chip-danger-ink)', background: 'var(--bp-chip-danger-tint)', color: 'var(--bp-chip-danger-ink)' };
const wrap: CSSProperties = { overflowWrap: 'anywhere', wordBreak: 'break-word' };

/**
 * A round of the mailbox now, for a screen (Chat, an open chat). It never throws, synchronously or later: whatever goes wrong
 * in the round, or before it starts, the page that asked keeps working (it answers null).
 */
export function outsideRoundNow(): Promise<unknown> {
    try {
        return syncOutsideMailNow().catch(() => null);
    } catch {
        return Promise.resolve(null);
    }
}

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

/**
 * The chat itself: kept in this browser only; a request's Accept, Decline and Block; the box once it is open. `onAccepted`: Accept
 * took, so the page's Back lands on the chats, where it now is, and not on the requests it came from (as a community request's).
 */
export function OutsideChatThread({ chatId, onBack, onAccepted }: { chatId: string; onBack: () => void; onAccepted?: () => void }) {
    const [me, setMe] = useState<string | null>(null);
    const [chat, setChat] = useState<OutsideChat | null | undefined>(undefined);
    const [lines, setLines] = useState<OutsideLine[]>([]);
    const [text, setText] = useState('');
    // Changes to lines (X6): each person's newest edit, reaction and delete, kept here; the line tapped; the id of a line of mine
    // being edited.
    const [changes, setChanges] = useState<OutsideChange[]>([]);
    const [picked, setPicked] = useState<string | null>(null);
    const [editing, setEditing] = useState<string | null>(null);
    const [deleting, setDeleting] = useState<OutsideLine | null>(null);
    // A line of theirs being reported (X5): the card asks why; my server blocks them and tells their community.
    const [reporting, setReporting] = useState<OutsideLine | null>(null);
    // What was typed in the box when an edit began: set aside, and back in the box after Save or Cancel, never lost.
    const [typedAside, setTypedAside] = useState('');
    // Words left unsent here wait in the box while the page is open (lib/chat-drafts.ts): Back, or Chat in the menu, keeps them.
    // During an edit the box holds the line's words, so the draft kept is what was set aside, never the line's words (which a
    // Send would post as a new line); the edit itself is kept beside it, and comes back with its Save and Cancel.
    const boxKey = draftKey(me, 'outside', chatId);
    useKeptDraft(boxKey, editing ? typedAside : text, setText);
    const editNow = useRef<{ lineId: string; words: string } | null>(null);
    editNow.current = editing ? { lineId: editing, words: text } : null;
    useLayoutEffect(() => {
        if (!boxKey) return;
        // After useKeptDraft's own effect (declared before it), so the edit's words win the box over the draft.
        const edit = takeEdit(boxKey);
        setEditing(edit?.lineId ?? null);
        setTypedAside(edit ? keptDraft(boxKey) : '');
        if (edit) setText(edit.words);
        return () => keepEdit(boxKey, editNow.current);
    }, [boxKey]);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    // The across mute (slice S4): their lines ring nothing, as this browser keeps it and my server was told.
    const [quiet, setQuiet] = useState(false);
    const alive = useRef(true);
    const endRef = useRef<HTMLDivElement | null>(null);

    const load = useCallback(async () => {
        const ctx = await outsideContext().catch(() => null);
        if (!alive.current) return;
        if (!ctx) { setChat(null); return; }
        setMe(ctx.identity.publicKey);
        const c = await ctx.store.chat(ctx.identity.publicKey, chatId).catch(() => null);
        const l = c ? await ctx.store.lines(ctx.identity.publicKey, c.id).catch(() => []) : [];
        const x = c ? await ctx.store.changes(ctx.identity.publicKey, c.id).catch(() => []) : [];
        const q = c ? await outsideQuiet(ctx, c.peerKey).catch(() => false) : false;
        if (!alive.current) return;
        setChat(c);
        setLines(l);
        setChanges(x);
        setQuiet(q);
        // Opened: a chat whose first line the member-here mark let in straight away lets its held receipts go (core
        // outsideHeldReceipts); a request opened still holds them ("They will not know you saw this unless you accept").
        if (c) await heldReceiptsOn(ctx, c.id, 'open').catch(() => null);
    }, [chatId]);

    useEffect(() => {
        alive.current = true;
        void load();
        void outsideRoundNow().then(load);
        const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void outsideRoundNow().then(load); }, POLL_MS);
        window.addEventListener(OUTSIDE_CHATS_EVENT, load);
        return () => { alive.current = false; clearInterval(timer); window.removeEventListener(OUTSIDE_CHATS_EVENT, load); };
    }, [load]);
    useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }); }, [lines.length]);

    /** An edit, a reaction or a delete of a line, applied here at once and sent (X6); my server's words if it says no. */
    const change = async (c: { kind: OutsideChangeKind; lineId: string; text?: string; emoji?: string }): Promise<boolean> => {
        const ctx = await outsideContext().catch(() => null);
        if (!ctx || !chat) return false;
        setNote(null);
        try {
            await sendOutsideChange(ctx, chat.id, c);
            return true;
        } catch (e) {
            if (alive.current) setNote(outsideErrorWords(e, !(e instanceof OutsideMailError)));
            return false;
        } finally {
            if (alive.current) setPicked(null);
            await load();
        }
    };


    const startEditing = (line: OutsideLine, words: string) => {
        if (!editing) setTypedAside(text);
        setEditing(line.id);
        setText(words);
        setPicked(null);
    };
    const stopEditing = () => { setEditing(null); setText(typedAside); setTypedAside(''); };

    const send = async () => {
        const words = text.trim();
        if (!words || busy || !chat) return;
        if (editing) {
            setBusy(true);
            try {
                if (await change({ kind: 'dm-edit', lineId: editing, text: words }) && alive.current) stopEditing();
            } finally {
                if (alive.current) setBusy(false);
            }
            return;
        }
        // This chat's key, taken now: the member may have left it when the line is kept (lib/chat-drafts.ts draftSent).
        const sentFrom = boxKey;
        setBusy(true);
        setNote(null);
        try {
            const ctx = await outsideContext();
            if (!ctx) return;
            // The box empties once the line is kept here (it shows at once, Sending…), never before; words typed meanwhile stay.
            // By the key taken at Send: the member may have left, or opened this chat again, by then.
            const { kept, error } = await sendFromBox(ctx, chat.id, words, OUTSIDE_SEND_MS, () => {
                draftSent(sentFrom, words);
                if (alive.current) void load();
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
        await heldReceiptsOn(ctx, chat.id, state === 'open' ? 'accept' : 'decline').catch(() => null);
        ring();
        if (state === 'declined') { onBack(); return; }
        onAccepted?.();
        await load();
    };

    /** Their lines ring nothing, or ring again: my server told first, then kept here (lib/outside-mail.ts setOutsideQuiet). */
    const toggleQuiet = async () => {
        const ctx = await outsideContext().catch(() => null);
        if (!ctx || !chat) return;
        try {
            await setOutsideQuiet(ctx, chat.peerKey, !quiet);
            setQuiet(!quiet);
            setNote(null);
        } catch (e) {
            setNote(e instanceof OutsideMailError && e.message && !/^HTTP \d+$/.test(e.message) ? e.message : t('That did not go through. Please try again.'));
        }
    };

    const block = async () => {
        if (!chat) return;
        const name = outsideName(chat);
        if (!window.confirm(t("Block {name}?\n\nThey won't be told. Nothing more from them will reach you.", { name }))) return;
        try {
            await blockUser(chat.peerKey);
        } catch (e) {
            // A BlocklistError, in words: the node didn't take the block, so nothing changes here.
            setNote((e as Error).message);
            return;
        }
        const ctx = await outsideContext().catch(() => null);
        if (ctx) await heldReceiptsOn(ctx, chat.id, 'block').catch(() => null);
        await decide('declined');
    };

    // Report on a line from another community always blocks its sender (the card says so), as on the phone. The line goes to my
    // community's moderators with its sender's signatures; their community is told, never who reported. The card says why a
    // send failed, keeping the choice and the words; once sent, Done takes the member back to the chats.
    const submitReport = async (line: OutsideLine, reason: string) => {
        const ctx = await outsideContext().catch(() => null);
        if (!ctx || !chat) throw new Error(t('That did not go through. Please try again.'));
        try {
            await reportOutsideLine(ctx, chat.id, line.id, reason);
        } catch (e) {
            throw new Error(e instanceof OutsideMailError && e.message && !/^HTTP \d+$/.test(e.message) ? e.message : t('That did not go through. Please try again.'));
        }
        await blockUser(chat.peerKey).catch(() => false);
        await heldReceiptsOn(ctx, chat.id, 'block').catch(() => null);
        await ctx.store.decide(ctx.identity.publicKey, chat.id, 'declined').catch(() => undefined);
        ring();
    };

    if (chat === undefined) return <div className="p-4 max-w-3xl mx-auto w-full" />;
    const name = chat ? outsideName(chat) : '';

    return (
        <div data-testid="outside-chat" className="p-4 max-w-3xl mx-auto w-full" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button type="button" onClick={onBack} style={{ ...button, flex: '0 0 auto', background: 'none', border: 'none', paddingLeft: 0 }}>
                    <span aria-hidden="true">‹ </span>{t('Back to chats')}
                </button>
                {chat && chat.state === 'open' && (
                    <button type="button" data-testid="outside-chat-quiet" aria-pressed={quiet} onClick={() => void toggleQuiet()} style={{ ...button, flex: '0 0 auto', marginLeft: 'auto' }}>
                        {quiet ? t('Unmute') : t('Mute notifications')}
                    </button>
                )}
                {chat && chat.state !== 'request' && (
                    <button type="button" data-testid="outside-chat-block" onClick={() => void block()} style={{ ...danger, flex: '0 0 auto', marginLeft: chat.state === 'open' ? undefined : 'auto' }}>
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
                        {/* Each device for itself (X2b): their lines reach every device; mine stay where I wrote them. */}
                        <p data-testid="outside-chat-writes-stay" style={{ margin: '0.4rem 0 0', color: 'var(--text-secondary)' }}>{t(LINES.writesStayThere)}</p>
                        {chat.restored && lines.length === 0 && (
                            <p data-testid="outside-chat-restored" style={{ margin: '0.4rem 0 0', color: 'var(--text-secondary)' }}>
                                {t("Earlier messages in this chat aren't in this browser. Messages with people in other communities are kept only on the phone or browser that got them.")}
                            </p>
                        )}
                    </div>
                    <div role="log" style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                        {lines.map((l, _i, all) => {
                            // Under my first line while they have written nothing here (slice S5 part 2: core acrossFirstLineNoteUnder).
                            const noteHere = me !== null && acrossFirstLineNoteUnder(all, me, chat.restored) === l.id;
                            const mine = l.author === me;
                            // The line with its changes applied (X6): its writer's newest edit, each person's newest reaction, or deleted.
                            const shown = outsideLineShown(l, changes, me ?? '');
                            // A deleted line has nothing left to deliver: no tick, no why.
                            const tick = mine && !shown.deleted ? stateWords(l.state) : null;
                            const why = mine && !shown.deleted && l.state === 'failed' ? l.note : null;
                            // Only what changes the chat needs it open; Report message is on every line of theirs not deleted (core's rule).
                            const can = outsideLineActions(chat.state, { mine, deleted: shown.deleted });
                            const canPick = can.react || can.edit || can.remove || can.report;
                            const myReaction = shown.reactions.find((r) => r.mine)?.emoji ?? null;
                            const toggle = () => { if (canPick) setPicked((p) => (p === l.id ? null : l.id)); };
                            return (
                                <div key={l.id} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '85%', display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start', gap: '0.25rem' }}>
                                    <div data-testid={mine ? 'outside-line-mine' : 'outside-line-theirs'} role={canPick ? 'button' : undefined} tabIndex={canPick ? 0 : undefined}
                                        aria-expanded={canPick ? picked === l.id : undefined} onClick={toggle}
                                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }} style={{
                                            padding: '0.5rem 0.75rem', borderRadius: '14px', cursor: canPick ? 'pointer' : undefined,
                                            background: mine ? 'var(--bp-sage-fill)' : 'var(--bg-card)', color: mine ? 'var(--bp-sage-on)' : 'var(--text-primary)',
                                            border: mine ? 'none' : '1px solid var(--border-primary)',
                                        }}>
                                        {shown.deleted
                                            ? <span data-testid="outside-line-deleted" style={{ fontStyle: 'italic', opacity: 0.85 }}>{t('This message was deleted')}</span>
                                            : <span dir="auto" style={{ whiteSpace: 'pre-wrap', ...wrap }}>{shown.text}</span>}
                                        {shown.edited && <span data-testid="outside-line-edited" style={{ display: 'block', fontSize: '0.75rem', textAlign: 'right', opacity: 0.9 }}>{t('edited')}</span>}
                                        {tick && <span data-testid="outside-line-state" style={{ display: 'block', fontSize: '0.75rem', textAlign: 'right', opacity: 0.9 }}>{tick}</span>}
                                        {why && <span data-testid="outside-line-why" style={{ display: 'block', fontSize: '0.75rem', opacity: 0.9, ...wrap }}>{why}</span>}
                                    </div>
                                    {noteHere && <span data-testid="outside-first-line-note" style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textAlign: 'right', ...wrap }}>{t(LINES.firstLineNote)}</span>}
                                    {shown.reactions.length > 0 && (
                                        <div data-testid="outside-line-reactions" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                                            {shown.reactions.map((r) => (
                                                <span key={r.emoji} style={{
                                                    display: 'inline-flex', gap: '0.25rem', padding: '0.1rem 0.5rem', borderRadius: '12px', fontSize: '0.85rem',
                                                    background: r.mine ? 'var(--bg-hover)' : 'var(--bg-card)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)',
                                                }}><span>{r.emoji}</span>{r.count > 1 && <span>{r.count}</span>}</span>
                                            ))}
                                        </div>
                                    )}
                                    {picked === l.id && canPick && (
                                        <div data-testid="outside-line-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', justifyContent: mine ? 'flex-end' : 'flex-start' }}>
                                            {can.react && OUTSIDE_REACTIONS.map((emoji) => (
                                                <button key={emoji} type="button" aria-label={t('React with {emoji}', { emoji })} aria-pressed={myReaction === emoji}
                                                    onClick={() => void change({ kind: 'dm-reaction', lineId: l.id, emoji: myReaction === emoji ? '' : emoji })} style={{
                                                        minWidth: '44px', minHeight: '44px', borderRadius: '22px', fontSize: '1.2rem', cursor: 'pointer', color: 'var(--text-primary)',
                                                        border: myReaction === emoji ? '1px solid var(--border-primary)' : '1px solid transparent', background: myReaction === emoji ? 'var(--bg-hover)' : 'none',
                                                    }}>{emoji}</button>
                                            ))}
                                            {can.edit && (
                                                <button type="button" data-testid="outside-line-edit" style={{ ...button, flex: '0 0 auto' }}
                                                    onClick={() => startEditing(l, shown.text)}>{t('Edit message')}</button>
                                            )}
                                            {can.remove && (
                                                <button type="button" data-testid="outside-line-delete" style={{ ...danger, flex: '0 0 auto' }} onClick={() => { setDeleting(l); setPicked(null); }}>{t('Delete message')}</button>
                                            )}
                                            {can.report && (
                                                <button type="button" data-testid="outside-line-report" style={{ ...danger, flex: '0 0 auto' }} onClick={() => { setReporting(l); setPicked(null); }}>
                                                    {t('Report message')}
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                    <ChatConfirmDialog
                        isOpen={!!deleting}
                        title={t('Delete for everyone?')}
                        message={t('It will read "This message was deleted" for both of you.')}
                        cancelLabel={t('Cancel')}
                        confirmLabel={t('Delete')}
                        destructive
                        onCancel={() => setDeleting(null)}
                        onConfirm={() => { const l = deleting; setDeleting(null); if (l) void change({ kind: 'dm-delete', lineId: l.id }); }}
                    />
                    {reporting && (
                        <ReportModal
                            isOpen
                            onClose={() => setReporting(null)}
                            onReported={onBack}
                            reporterPubkey={me ?? ''}
                            targetPubkey={chat.peerKey}
                            targetName=""
                            title={t('Report this message')}
                            note={t("This community's moderators will see this one message and who sent it. Nothing else in this chat is shared with them. Reporting a request blocks its sender too.")}
                            onSubmitReason={(reason) => submitReport(reporting, reason)}
                        />
                    )}
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
                                placeholder={editing ? t('Edit message') : t('Message')}
                                aria-label={editing ? t('Edit message') : t('Message {name}', { name })}
                                maxLength={OUTSIDE_LINE_TEXT_MAX}
                                rows={2}
                                style={{
                                    flex: 1, minWidth: 0, minHeight: '44px', padding: '0.6rem 0.75rem', borderRadius: '12px', border: '1px solid var(--border-input)',
                                    background: 'var(--bg-input)', color: 'var(--text-primary)', font: 'inherit', resize: 'vertical',
                                }}
                            />
                            {editing && (
                                <button type="button" data-testid="outside-chat-edit-cancel" onClick={stopEditing} style={{ ...button, flex: '0 0 auto' }}>{t('Cancel')}</button>
                            )}
                            <button type="submit" data-testid="outside-chat-send" disabled={busy || !text.trim()} style={{ ...commit, flex: '0 0 auto', opacity: busy || !text.trim() ? 0.6 : 1 }}>
                                {editing ? t('Save') : t('Send')}
                            </button>
                        </form>
                    ) : null}
                    {/* The end of the page, under the box or a request's Accept: the chat opens here, its newest line just above
                        them (deciding review of #3285: the end sat inside the lines, so the box and Accept were under the screen).
                        Clear of the bottom bar: <main> pads for it, but a scroll into view goes by the scroll margin, not padding. */}
                    <div ref={endRef} data-testid="outside-chat-end" style={{ scrollMarginBottom: 'var(--bottom-nav-offset)' }} />
                </>
            )}
        </div>
    );
}
