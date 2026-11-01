/**
 * A report of one direct-message line (R0: scratch/fable-design/DESIGN-reaching-across-fable.md §1 row 2, §3 and §6 item 5,
 * on the group line's pattern, engine/group-chat-report.ts). What a reporter hands over: the sealed line, the sender's
 * signature over it, and the words the reporter says it opens to. Never a key, never another line.
 *
 * The signature: a line's seal (dm-crypto.ts) uses one key for the two people, so it can't say which of them wrote it. So
 * the sender also signs the sealed bytes with their member key, the shape the chat design calls format 4
 * (DESIGN-cross-community-chat-fable.md §2.4), plus who it was to and when. It is detached (metadata `lineSig`): the sealed
 * bytes stay format 3, so an app of any version opens the line, and a line from before this change has none. It names no
 * words: anyone holding the sealed line can check who wrote it to whom without opening it, and nobody can tell what it says.
 * An edit is new sealed bytes, so it carries a new signature (or the node drops the old one: engine/messaging.ts editMessage).
 *
 * What it proves: the sender wrote these sealed bytes to the reporter, then. What it does not: that they open to the
 * reporter's words. With the static key the only proof of that is the conversation's key, which would open every line, so
 * the words are the reporter's word and read as that (the design's v1). S2.6's ratchet gives one key per message: a
 * disclosure of `v: 2` adds it (`mk`), and the words read as proven. The report needs no stored row once its signature
 * verifies, so a sender's delete can't take it back, and S2.5's lines, which no node keeps, report the same way.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { Buffer } from 'buffer';
import { dmConversationIdsToTry, dmPublicKeyOf, isDmEncryptedNonce, type DmPayload } from './dm-crypto.js';
import { toEd25519Seed } from './ed25519-key.js';

/** First word of what a sender signs: this use's own name, so no other signature by the key can be taken for it. */
export const DM_LINE_SIG_TAG = 'beanpool-dm-line-sig/1';
/** The key in a line's metadata that holds its signature. */
export const DM_LINE_SIG_KEY = 'lineSig';
/** What the `kind` of a stored disclosure says, beside a group line's `{ epoch, mk }`, which has none. */
export const DM_LINE_DISCLOSURE_KIND = 'dm-line';
/** The most characters of the reporter's words one report carries: a line's own limit, in the phone's longest text. */
export const DM_REPORT_WORDS_MAX = 8000;
/** The most characters of sealed line one report keeps: a line's own limit (the node's writer-bounds, 64 KB of base64), and room. */
export const DM_REPORT_SEALED_MAX = 96_000;

/** What a sender signs besides the sealed bytes. */
export interface DmLineSigBinding {
    conversationId: string;
    senderPubHex: string;
    /** Who it was written to: the other person's key the line is sealed to. */
    recipientPubHex: string;
    messageId: string;
    /** When, by the sender's own clock (ISO 8601). */
    at: string;
}

/** The signature as a line's metadata carries it. */
export interface DmLineSig {
    /** Ed25519 over dmLineSigDigest, base64. */
    sig: string;
    at: string;
}

/** What a reporter hands over for one line. */
export interface DmLineDisclosure {
    v: 1;
    /** The sealed line. */
    ciphertext: string;
    nonce: string;
    /** The conversation it was sealed under, as this reporter holds it. */
    conversationId: string;
    /** The sender's signature, null for a line from before signatures or an app that had none. */
    lineSig: DmLineSig | null;
    /** The words the reporter says it opens to: their word, until a message key can prove them. */
    words: string;
}

/**
 * The digest a sender signs: SHA-256 of the UTF-8 of a JSON array of strings, one spelling for one list of values, as format
 * 3's associated data is (dm-crypto.ts dmLineAad).
 */
export function dmLineSigDigest(line: DmPayload, b: DmLineSigBinding): Uint8Array {
    const sealed = bytesToHex(sha256(utf8ToBytes(line.ciphertext)));
    return sha256(utf8ToBytes(JSON.stringify([DM_LINE_SIG_TAG, b.conversationId, b.senderPubHex, b.recipientPubHex, b.messageId, b.at, line.nonce, sealed])));
}

/** Sign a sealed line as its sender. `myEdPrivHex` in either spelling (toEd25519Seed); refuses to sign as anyone else. */
export function signDmLine(line: DmPayload, myEdPrivHex: string, binding: DmLineSigBinding): DmLineSig {
    if (binding.senderPubHex !== dmPublicKeyOf(myEdPrivHex)) throw new Error('A line is signed only as its sender.');
    const sig = ed25519.sign(dmLineSigDigest(line, binding), toEd25519Seed(hexToBytes(myEdPrivHex)));
    return { sig: Buffer.from(sig).toString('base64'), at: binding.at };
}

/** Whether `lineSig` is `binding.senderPubHex`'s signature over this sealed line, to this person, under this id. */
export function dmLineSigVerifies(line: DmPayload, lineSig: DmLineSig, binding: Omit<DmLineSigBinding, 'at'>): boolean {
    try {
        const sig = Buffer.from(lineSig.sig, 'base64');
        if (sig.length !== 64 || sig.toString('base64') !== lineSig.sig) return false;
        // Strict RFC 8032, as every verifier here: one signature for one key and message.
        return ed25519.verify(new Uint8Array(sig), dmLineSigDigest(line, { ...binding, at: lineSig.at }), hexToBytes(binding.senderPubHex), { zip215: false });
    } catch {
        return false;
    }
}

/** A signature's shape, from a line's metadata or a disclosure: null for anything else. */
export function dmLineSigOf(v: unknown): DmLineSig | null {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const { sig, at } = v as { sig?: unknown; at?: unknown };
    return typeof sig === 'string' && sig.length <= 100 && typeof at === 'string' && at.length <= 40 ? { sig, at } : null;
}

/** The signature in a line's metadata as stored (a JSON string or the parsed object), or null. */
export function dmLineSigInMetadata(metadata: unknown): DmLineSig | null {
    try {
        const meta = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
        return dmLineSigOf(meta?.[DM_LINE_SIG_KEY]);
    } catch {
        return null;
    }
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
 * Which of the line's conversation ids and signers its signature verifies under, or null. A line may have been signed under
 * an older id its metadata names, as it may have been sealed (dmConversationIdsToTry, at most DM_LINE_SIG_IDS_MAX here); and
 * by or to a key someone had before a re-key, which the caller lists in `signers` and `recipients`.
 */
export function dmLineSignedBy(
    line: DmPayload,
    lineSig: DmLineSig | null,
    to: { conversationId: string; metadata?: unknown; recipients: readonly string[]; messageId: string },
    signers: readonly string[],
): { conversationId: string; signer: string } | null {
    if (!lineSig) return null;
    for (const conversationId of dmConversationIdsToTry(to.conversationId, to.metadata).slice(0, DM_LINE_SIG_IDS_MAX)) {
        for (const senderPubHex of signers) {
            for (const recipientPubHex of to.recipients) {
                if (dmLineSigVerifies(line, lineSig, { conversationId, senderPubHex, recipientPubHex, messageId: to.messageId })) {
                    return { conversationId, signer: senderPubHex };
                }
            }
        }
    }
    return null;
}

/**
 * The disclosure's shape, as the node takes it and as it reads one back: null for anything else. The sealed line must be in
 * an encrypted line's form, and only the words the report keeps.
 */
export function dmLineDisclosureOf(v: unknown): DmLineDisclosure | null {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const d = v as Record<string, unknown>;
    if (d.v !== 1 || typeof d.ciphertext !== 'string' || !d.ciphertext || d.ciphertext.length > DM_REPORT_SEALED_MAX) return null;
    if (typeof d.nonce !== 'string' || d.nonce.length > 100 || !isDmEncryptedNonce(d.nonce)) return null;
    if (typeof d.conversationId !== 'string' || !d.conversationId || typeof d.words !== 'string' || d.words.length > DM_REPORT_WORDS_MAX) return null;
    if (d.lineSig !== null && d.lineSig !== undefined && !dmLineSigOf(d.lineSig)) return null;
    return { v: 1, ciphertext: d.ciphertext, nonce: d.nonce, conversationId: d.conversationId, lineSig: dmLineSigOf(d.lineSig), words: d.words };
}

/** What a reporter's app hands over for a line it holds, with the words it reads there. Long words are cut, never refused. */
export function dmLineDisclosureFor(
    line: { ciphertext: string; nonce: string; conversationId: string; metadata?: unknown },
    words: string,
): DmLineDisclosure {
    return {
        v: 1, ciphertext: line.ciphertext, nonce: line.nonce, conversationId: line.conversationId,
        lineSig: dmLineSigInMetadata(line.metadata), words: words.slice(0, DM_REPORT_WORDS_MAX),
    };
}
