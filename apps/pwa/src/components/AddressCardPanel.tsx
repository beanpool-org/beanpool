/**
 * The address card and its door on the web (messages across communities X4; the phone's app/address-card.tsx, X3:
 * scratch/fable-design/DESIGN-cross-chat-voice-fable.md §3.5, §3.6).
 *
 * **My card.** Showing it the first time opens the member's door in this browser, after the words that say what that means:
 * people in other communities who have the card can send one message request. `{key, home, name}` signed here (core
 * outside-chat.ts), as a QR code and a link. A switch closes the door again: a stranger's line is then dropped here.
 *
 * **Someone's card.** Pasted, or read from a photo of its QR code where the browser can read one (BarcodeDetector: Chrome
 * and Edge on Android, ChromeOS and macOS); elsewhere the paste box alone, and it says so. A card its key did not sign is no
 * card. Then one line, sent as a message request: on into the chat once it is kept here; the words stay when it isn't.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { OUTSIDE_LINE_TEXT_MAX, addressCardFromText, addressCardLink, relayConversationId, t, type AddressCard } from '@beanpool/core';
import {
    OUTSIDE_SEND_MS, doorOpen, myAddressCard, myHome, outsideContext, outsideErrorWords, outsideMessagesHere, ring, sendFromBox, setDoor,
} from '../lib/outside-mail';

const card: CSSProperties = {
    padding: '1rem', borderRadius: '14px', background: 'var(--bg-card)', border: '1px solid var(--border-primary)',
    display: 'flex', flexDirection: 'column', gap: '0.65rem',
};
const primary: CSSProperties = {
    minHeight: '44px', padding: '0.5rem 1rem', borderRadius: '10px', border: 'none', background: 'var(--bp-commit-fill)',
    color: 'var(--bp-commit-on)', fontFamily: 'inherit', fontSize: '0.95rem', fontWeight: 700, cursor: 'pointer',
};
const plain: CSSProperties = { ...primary, border: '1px solid var(--border-primary)', background: 'var(--bg-hover)', color: 'var(--text-primary)' };
const input: CSSProperties = {
    minHeight: '44px', padding: '0.6rem 0.75rem', borderRadius: '10px', border: '1px solid var(--border-input)', background: 'var(--bg-input)',
    color: 'var(--text-primary)', font: 'inherit', width: '100%', boxSizing: 'border-box',
};
const words: CSSProperties = { margin: 0, fontSize: '0.9rem', lineHeight: 1.45, color: 'var(--text-secondary)', overflowWrap: 'anywhere' };

// The React types this app builds against read qrcode.react's forwardRef as no JSX component (as BringToPhone.tsx says).
const QRCode = QRCodeSVG as unknown as (p: { value: string; size: number; bgColor: string; fgColor: string }) => ReactElement;

/** The browser's own QR reader, where it has one. */
type Detector = { detect: (image: ImageBitmapSource) => Promise<Array<{ rawValue?: string }>> };
function qrReader(): Detector | null {
    const D = (globalThis as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
    try { return D ? new D({ formats: ['qr_code'] }) : null; } catch { return null; }
}

export function AddressCardPanel({ onBack, onOpenChat }: { onBack: () => void; onOpenChat: (chatId: string) => void }) {
    const [here, setHere] = useState<boolean | null>(null);
    const [mine, setMine] = useState<AddressCard | null>(null);
    const [open, setOpen] = useState<boolean | null>(null);
    const [pasted, setPasted] = useState('');
    const [theirs, setTheirs] = useState<AddressCard | null>(null);
    const [cardNote, setCardNote] = useState<string | null>(null);
    const [first, setFirst] = useState('');
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState(false);
    const reader = useRef<Detector | null>(qrReader());
    const photo = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        let alive = true;
        void (async () => {
            const ctx = await outsideContext();
            const on = ctx ? await outsideMessagesHere() : false;
            if (!alive) return;
            setHere(on === true);
            if (ctx && on) setOpen(await doorOpen(ctx).catch(() => false));
        })();
        return () => { alive = false; };
    }, []);

    /** Show my card: the first time, this is what opens the door. */
    const showMine = async () => {
        const ctx = await outsideContext();
        if (!ctx) return;
        try {
            const c = await myAddressCard(ctx);
            if (!c) { setCardNote(t("This community's server knows none of its own names yet, so it can't send to another community.")); return; }
            await setDoor(ctx, true);
            setOpen(true);
            setMine(c);
        } catch (e) {
            setCardNote(outsideErrorWords(e));
        }
    };

    const switchDoor = async (next: boolean) => {
        const ctx = await outsideContext();
        if (!ctx) return;
        await setDoor(ctx, next);
        setOpen(next);
        if (!next) setMine(null);
    };

    /** A scanned or pasted text: their card, or why not. */
    const readCard = async (text: string) => {
        const c = addressCardFromText(text);
        if (!c) { setCardNote(t("That isn't an address card, or it was changed after it was made.")); return; }
        const ctx = await outsideContext();
        if (!ctx) return;
        if (c.key === ctx.identity.publicKey) { setCardNote(t("That's your own card.")); return; }
        if (c.home === await myHome(ctx).catch(() => null)) { setCardNote(t('{name} is in this community: write to them here.', { name: c.name })); return; }
        setCardNote(null);
        setTheirs(c);
    };

    const readPhoto = async (file: File | undefined) => {
        if (!file || !reader.current) return;
        try {
            const found = await reader.current.detect(await createImageBitmap(file));
            const text = found.map((f) => f.rawValue ?? '').find((v) => addressCardFromText(v));
            if (text) await readCard(text);
            else setCardNote(t("That isn't an address card, or it was changed after it was made."));
        } catch {
            setCardNote(t('Ask them to send you the link, and paste it here.'));
        }
    };

    const copy = async () => {
        if (!mine) return;
        try { await navigator.clipboard.writeText(addressCardLink(mine)); setCopied(true); } catch { setCopied(false); }
    };

    const sendRequest = async () => {
        const w = first.trim();
        if (!theirs || !w || busy) return;
        setBusy(true);
        try {
            const ctx = await outsideContext();
            if (!ctx) return;
            const chatId = relayConversationId(ctx.identity.publicKey, theirs.key);
            await ctx.store.openChat(ctx.identity.publicKey, chatId, { key: theirs.key, home: theirs.home, name: theirs.name });
            // The words stay in this box while the line goes. Kept here: on to the chat, which shows it. Not kept: they stay.
            const { kept, error } = await sendFromBox(ctx, chatId, w, OUTSIDE_SEND_MS, () => {});
            ring();
            if (error) setCardNote(outsideErrorWords(error, kept));
            if (kept) onOpenChat(chatId);
        } catch (e) {
            setCardNote(outsideErrorWords(e, false));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div data-testid="address-card" className="p-4 max-w-xl mx-auto w-full" style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button type="button" onClick={onBack} style={{ ...plain, background: 'none', border: 'none', paddingLeft: 0 }}>
                    <span aria-hidden="true">‹ </span>{t('Back to chats')}
                </button>
                <h2 style={{ margin: 0, fontSize: '1.2rem', overflowWrap: 'anywhere' }}>{t('People in other communities')}</h2>
            </div>
            {here === false ? (
                <p style={words}>{t("This community doesn't take messages from other communities.")}</p>
            ) : here === null ? null : (
                <>
                    <section data-testid="my-address-card" style={card}>
                        <h3 style={{ margin: 0, fontSize: '1rem' }}>{t('My address card')}</h3>
                        {mine ? (
                            <>
                                {/* Its own white quiet zone in both themes: a scanner needs dark modules on a light ground. */}
                                <div role="img" aria-label={t('Your address card as a QR code')} style={{ alignSelf: 'center', padding: '12px', background: '#ffffff', borderRadius: '12px', lineHeight: 0 }}>
                                    <QRCode value={addressCardLink(mine)} size={200} bgColor="#ffffff" fgColor="#000000" />
                                </div>
                                <p style={{ margin: 0, fontWeight: 600, overflowWrap: 'anywhere' }}>{t('{name} · {community}', { name: mine.name, community: mine.home })}</p>
                                <p data-testid="my-card-link" style={{ ...words, fontSize: '0.75rem', userSelect: 'all' }}>{addressCardLink(mine)}</p>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                                    <button type="button" style={{ ...plain, flex: '1 1 8rem' }} onClick={() => void copy()}>{copied ? t('Copied') : t('Copy the link')}</button>
                                    {typeof navigator !== 'undefined' && typeof navigator.share === 'function' && (
                                        <button type="button" style={{ ...plain, flex: '1 1 8rem' }} onClick={() => void navigator.share({ url: addressCardLink(mine) }).catch(() => {})}>
                                            {t('Share my card')}
                                        </button>
                                    )}
                                </div>
                            </>
                        ) : (
                            <>
                                <p style={words}>
                                    {t('Anyone you show your card to can send you one message request from their own community. You choose whether to accept. Your community keeps no copy of these chats: each message is kept only on the phone or browser that gets it.')}
                                </p>
                                <button type="button" data-testid="show-my-card" style={primary} onClick={() => void showMine()}>{t('Show my card')}</button>
                            </>
                        )}
                        {open !== null && (open || mine) && (
                            <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minHeight: '44px', fontSize: '0.9rem', overflowWrap: 'anywhere' }}>
                                <input type="checkbox" data-testid="door-switch" checked={!!open} onChange={(e) => void switchDoor(e.target.checked)}
                                    style={{ width: '22px', height: '22px', flexShrink: 0 }} />
                                <span>{t('People in other communities can send me a message request')}</span>
                            </label>
                        )}
                    </section>
                    <section data-testid="their-address-card" style={card}>
                        <h3 style={{ margin: 0, fontSize: '1rem' }}>{t("Someone else's card")}</h3>
                        {theirs ? (
                            <>
                                <p style={{ margin: 0, fontWeight: 600, overflowWrap: 'anywhere' }}>{theirs.name}</p>
                                <p style={words}>{t('{community} · name not confirmed here', { community: theirs.home })}</p>
                                <textarea data-testid="first-message" value={first} onChange={(e) => setFirst(e.target.value)} rows={3}
                                    placeholder={t('Your first message')} aria-label={t('Your first message')} maxLength={OUTSIDE_LINE_TEXT_MAX} style={{ ...input, resize: 'vertical' }} />
                                <button type="button" data-testid="send-request" style={{ ...primary, opacity: busy || !first.trim() ? 0.6 : 1 }} disabled={busy || !first.trim()} onClick={() => void sendRequest()}>
                                    {t('Send a message request')}
                                </button>
                            </>
                        ) : (
                            <>
                                <p style={words}>{reader.current ? t('Scan their card, or paste the link they sent you.') : t('Ask them to send you the link, and paste it here.')}</p>
                                {reader.current && (
                                    <>
                                        <button type="button" data-testid="scan-card" style={primary} onClick={() => photo.current?.click()}>{t('Scan a card')}</button>
                                        <input ref={photo} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void readPhoto(e.target.files?.[0]); e.target.value = ''; }} />
                                    </>
                                )}
                                <input data-testid="paste-card" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder={t('Paste a card link')}
                                    aria-label={t('Paste a card link')} autoCapitalize="none" autoCorrect="off" spellCheck={false} style={input} />
                                <button type="button" data-testid="read-card" style={{ ...plain, opacity: pasted.trim() ? 1 : 0.6 }} disabled={!pasted.trim()} onClick={() => void readCard(pasted)}>
                                    {t('Read the card')}
                                </button>
                            </>
                        )}
                        {cardNote && <p role="status" style={{ ...words, color: 'var(--text-primary)', fontWeight: 600 }}>{cardNote}</p>}
                    </section>
                </>
            )}
        </div>
    );
}
