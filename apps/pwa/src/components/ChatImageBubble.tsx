/**
 * A direct message's photo in its bubble (pages/MessagesPage.tsx), and the bubble a chat photo is drawn in (a group's too).
 * Moved out of the page unchanged but for the retry below, so a test can mount them.
 */
import { useEffect, useState } from 'react';
import { openDmOldPhoto, t } from '@beanpool/core';
import { getMessageAttachmentApi } from '../lib/api';
import { openDmLine } from '../lib/e2e-crypto';

/**
 * Lazily fetch + decrypt an encrypted image attachment, then render it. The photo opens only as part of its message:
 * bound to the author and id the node shows the message under, and signed by that author (format 4), so no other line's
 * photo, and no picture the other person sealed in the author's name, can stand in for it. Words that didn't open
 * (`bodyFormat` null, from the thread check) leave the photo locked too.
 *
 * `old` (conversion code, log row OLDCHAT, remove after 12 Dec 2026): a line from before 1.4.0 the thread check showed old
 * (dmLineIsOld). Its photo opens as part of its words (`words`, the line's own ciphertext and nonce, at the node's `timestamp`
 * for it) under the key, sender, conversation id and format they opened in (core openDmOldPhoto), as 1.2.36 opened it; one
 * that doesn't, or isn't a picture, stays "🔒 Image unavailable".
 *
 * Whatever the photo opens with can arrive after the bubble's first paint: the thread check showing the line old or verified,
 * the chat's key. When any of these props (they are all in the effect's list) change, the bubble starts over: the last answer
 * is cleared and the photo is opened again. Only the latest attempt may answer (an earlier one that comes back late is
 * dropped), and a failure is final until a prop changes: nothing here retries on its own.
 */
export function ChatImageBubble({ messageId, conversationId, authorPubkey, metadata, bodyFormat, peerPubHex, myPrivHex, onOpen, old }:
    {
        messageId: string; conversationId: string; authorPubkey: string; metadata?: string | null; bodyFormat: 4 | null; peerPubHex: string; myPrivHex: string; onOpen?: (uri: string) => void;
        old?: { words: { ciphertext: string; nonce: string }; timestamp: string | null | undefined } | null;
    }) {
    const [uri, setUri] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    // Old chat (conversion code, log row OLDCHAT, remove after 12 Dec 2026): the old line's own sealing, as plain values for the effect.
    const oldCiphertext = old?.words.ciphertext;
    const oldNonce = old?.words.nonce;
    const oldTimestamp = old?.timestamp;
    useEffect(() => {
        // Each run of this effect is one attempt; its cleanup (a prop changed, or the bubble left) ends it, and an ended
        // attempt's answer is ignored, so the latest attempt always wins.
        let active = true;
        setUri(null);
        setFailed(false);
        (async () => {
            try {
                const keys = { myEdPrivHex: myPrivHex, peerEdPubHex: peerPubHex };
                // Old chat (conversion code, log row OLDCHAT, remove after 12 Dec 2026): a line the thread check showed old.
                if (!bodyFormat && oldCiphertext !== undefined && oldNonce !== undefined) {
                    const att = await getMessageAttachmentApi(messageId);
                    const dataUri = openDmOldPhoto({ ciphertext: oldCiphertext, nonce: oldNonce }, { ciphertext: att.data, nonce: att.nonce }, keys,
                        { conversationId, senderPubHex: authorPubkey, messageId, metadata, timestamp: oldTimestamp });
                    if (active) setUri(dataUri);
                    return;
                }
                if (!bodyFormat) throw new Error('not verified');
                const att = await getMessageAttachmentApi(messageId);
                const dataUri = openDmLine({ ciphertext: att.data, nonce: att.nonce }, keys,
                    { conversationId, senderPubHex: authorPubkey, messageId, part: 'attachment', metadata }).text;
                if (active) setUri(dataUri);
            } catch { if (active) setFailed(true); }
        })();
        return () => { active = false; };
    }, [messageId, conversationId, authorPubkey, metadata, bodyFormat, peerPubHex, myPrivHex, oldCiphertext, oldNonce, oldTimestamp]);
    return <ChatPhotoShown uri={uri} failed={failed} onOpen={onOpen} />;
}

/** A chat photo in its bubble: the picture once opened, "Loading image…" until then, or "🔒 Image unavailable". */
export function ChatPhotoShown({ uri, failed, onOpen }: { uri: string | null; failed: boolean; onOpen?: (uri: string) => void }) {
    if (failed) return <span style={{ fontStyle: 'italic', opacity: 0.7 }}>{t('🔒 Image unavailable')}</span>;
    if (!uri) return <span style={{ opacity: 0.6 }}>{t('Loading image…')}</span>;
    return (
        <button
            type="button"
            aria-label={t('View photo full screen')}
            onClick={(e) => {
                e.currentTarget.focus();
                onOpen?.(uri);
            }}
            className="p-0 m-0 border-0 bg-transparent text-left cursor-pointer rounded-xl block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            style={{ maxWidth: '220px', lineHeight: 0 }}
        >
            <img src={uri} alt={t('Photo message')} style={{ maxWidth: '220px', borderRadius: '12px', display: 'block' }} />
        </button>
    );
}
