/**
 * A report of one direct-message line (R0: scratch/fable-design/DESIGN-reaching-across-fable.md §1 row 2, §3 and §6 item 5,
 * on the group line's pattern, engine/group-chat-report.ts). What a reporter hands over: the line as the node carries it
 * (its ciphertext column holds the sealed bytes and, beside them, the sender's signature: dm-crypto.ts format 4) and the
 * words the reporter says it opens to. Never a key, never another line.
 *
 * The signature: a line's seal uses one key for the two people, so it can't say which of them wrote it. So the sender also
 * signs the sealed bytes with their member key, plus who it was to, which part and when (dm-crypto.ts dmLineSigDigest). It
 * names no words: anyone holding the line can check who wrote it to whom without opening it, and nobody can tell what it
 * says. An edit is new sealed bytes with a new signature of its own.
 *
 * What it proves: the sender wrote these sealed bytes to the reporter, then. What it does not: that they open to the
 * reporter's words. With the static key the only proof of that is the conversation's key, which would open every line, so
 * the words are the reporter's word and read as that (the design's v1). S2.6's ratchet gives one key per message: a
 * disclosure of `v: 2` adds it (`mk`), and the words read as proven. The report needs no stored row once its signature
 * verifies, so a sender's delete can't take it back, and S2.5's lines, which no node keeps, report the same way.
 */
import { dmConversationIdsToTry, dmLineSigVerifies, isDmEncryptedNonce, type DmPart, type DmPayload } from './dm-crypto.js';
import { VOICE_SEALED_MAX_BYTES } from './voice.js';

/** What the `kind` of a stored disclosure says, beside a group line's `{ epoch, mk }`, which has none. */
export const DM_LINE_DISCLOSURE_KIND = 'dm-line';
/** The most characters of the reporter's words one report carries: a line's own limit, in the phone's longest text. */
export const DM_REPORT_WORDS_MAX = 8000;
/** The most characters of sealed line one report keeps: a line's own limit (the node's writer-bounds, 64 KB of base64), and room. */
export const DM_REPORT_SEALED_MAX = 96_000;

/** What a reporter hands over for one line. */
export interface DmLineDisclosure {
    v: 1;
    /** The line's ciphertext column: the sealed bytes, and the sender's signature beside them. */
    ciphertext: string;
    nonce: string;
    /** The conversation it was sealed under, as this reporter holds it. */
    conversationId: string;
    /** The words the reporter says it opens to: their word, until a message key can prove them. */
    words: string;
    /**
     * A voice message's sealed part (voice.ts), as the reporter's app fetched it beside the line: optional, and only on a
     * voice line. Its signature is checked as the words' is, under the part name `voice` (dmLineSignedBy's `part`), and it
     * is kept with the report, so the server deleting it after VOICE_SERVER_KEEP_DAYS, or its sender deleting the line,
     * takes nothing back. Like the words' seal it proves who sent it to whom and when, never what it says.
     */
    voice?: DmPayload;
}

/**
 * The most conversation ids a signature is checked under: the line's own, and one older id. Its sender writes a line's
 * metadata and only the length is limited, each id is an Ed25519 verify on the node's main thread, and a report checks the
 * signature before its duplicate and hourly limits. With no cap one report held a node for 20.6 s, and a moderator opening it
 * for 10.3 s (measured, the deciding review of #2705).
 *
 * Two, because a fold adds one id to a signed line. A send to a folded id, and a withheld conversation made real, each
 * name the id it was sealed under in `originalConversationId` (engine/messaging.ts sendMessage), and so did the per-post fold.
 * `originalConversationIds` holds more, but only repairConsolidatedMessagesMetadata writes it: one id for each per-post thread
 * a pair had, on lines that name no id of their own. Those threads ended before the first public release and signatures
 * began after it, so no signature was made under one, and such a line's own id, tried first, is the one it verifies under.
 *
 * So a line that names too many still verifies under its own id. A signature that only an id past the cap would verify reads
 * as not verified, as any that fails does, and no sender gains by that: they can always send a signature that fails. The
 * two people's former keys multiply this, up to (KEY_SUCCESSION_MAX + 1) each, but only an admin completes a re-key.
 */
export const DM_LINE_SIG_IDS_MAX = 2;

/**
 * Which of the line's conversation ids and signers its words' signature verifies under, or null. A line may have been signed
 * under an older id its metadata names, as it may have been sealed (dmConversationIdsToTry, at most DM_LINE_SIG_IDS_MAX
 * here); and by or to a key someone had before a re-key, which the caller lists in `signers` and `recipients`.
 */
export function dmLineSignedBy(
    line: DmPayload,
    to: { conversationId: string; metadata?: unknown; recipients: readonly string[]; messageId: string },
    signers: readonly string[],
    part: Extract<DmPart, 'body' | 'voice'> = 'body',
): { conversationId: string; signer: string } | null {
    for (const conversationId of dmConversationIdsToTry(to.conversationId, to.metadata).slice(0, DM_LINE_SIG_IDS_MAX)) {
        for (const senderPubHex of signers) {
            for (const recipientPubHex of to.recipients) {
                if (dmLineSigVerifies(line, { conversationId, senderPubHex, recipientPubHex, messageId: to.messageId, part })) {
                    return { conversationId, signer: senderPubHex };
                }
            }
        }
    }
    return null;
}

/** A sealed part in an encrypted line's form, its ciphertext at most `max` characters: the part, or null. */
function sealedPartOf(v: unknown, max: number): DmPayload | null {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const { ciphertext, nonce } = v as Record<string, unknown>;
    if (typeof ciphertext !== 'string' || !ciphertext || ciphertext.length > max) return null;
    if (typeof nonce !== 'string' || nonce.length > 100 || !isDmEncryptedNonce(nonce)) return null;
    return { ciphertext, nonce };
}

/**
 * The disclosure's shape, as the node takes it and as it reads one back: null for anything else. The line must be in an
 * encrypted line's form, and only the words the report keeps; a voice part, when there is one, in that form too and at most
 * VOICE_SEALED_MAX_BYTES.
 */
export function dmLineDisclosureOf(v: unknown): DmLineDisclosure | null {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const d = v as Record<string, unknown>;
    if (d.v !== 1) return null;
    const line = sealedPartOf(d, DM_REPORT_SEALED_MAX);
    if (!line) return null;
    if (typeof d.conversationId !== 'string' || !d.conversationId || typeof d.words !== 'string' || d.words.length > DM_REPORT_WORDS_MAX) return null;
    const out: DmLineDisclosure = { v: 1, ciphertext: line.ciphertext, nonce: line.nonce, conversationId: d.conversationId, words: d.words };
    if (d.voice === undefined || d.voice === null) return out;
    const voice = sealedPartOf(d.voice, VOICE_SEALED_MAX_BYTES);
    return voice ? { ...out, voice } : null;
}

/**
 * What a reporter's app hands over for a line it holds, with the words it reads there, and a voice line's sealed voice part
 * as it fetched it. Long words are cut, never refused.
 */
export function dmLineDisclosureFor(line: { ciphertext: string; nonce: string; conversationId: string }, words: string, voice?: DmPayload): DmLineDisclosure {
    const out: DmLineDisclosure = { v: 1, ciphertext: line.ciphertext, nonce: line.nonce, conversationId: line.conversationId, words: words.slice(0, DM_REPORT_WORDS_MAX) };
    return voice ? { ...out, voice: { ciphertext: voice.ciphertext, nonce: voice.nonce } } : out;
}
