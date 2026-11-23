/**
 * A group's or an enterprise's chat lines this account wrote that their node never took (walk-s6, 23 Nov 2026: a "! not
 * delivered" line in a locked group, waiting for the chat's key, was gone at the next relaunch and nothing said so). Kept on
 * this phone, per account and community file (storage-keys.ts groupUnsentStoreKey), by chat, until that node holds the line
 * (each read of the chat retires it: chat-actions.ts pendingAfterRead) or the member discards it. After a relaunch the line
 * shows again as not delivered, with Resend (which goes once the chat's key has arrived) and Discard. Nothing here sends.
 *
 * The words stay on this phone, in the app's own storage, as a draft does; the account leaving the phone takes them
 * (identity.ts wipeIdentityScopedStorage), and a community followed to a new address brings them (community-copy-carry.ts).
 */
import { groupUnsentStoreKey } from './storage-keys';

export interface UnsentLine {
    /** The id the line's POST carries, so a Resend is stored once. */
    clientId: string;
    text: string;
    replyToId: string | null;
    timestamp: string;
}

interface Storage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
}

/** The most lines kept a chat: the newest. */
export const UNSENT_MAX_A_CHAT = 50;

/** A chat's id as a node issues it (a UUID, an enterprise's key): never anything that could name an object's own field. */
const CHAT_ID = /^[A-Za-z0-9_-]{1,128}$/;

function lineOf(v: unknown): UnsentLine | null {
    if (!v || typeof v !== 'object') return null;
    const l = v as Record<string, unknown>;
    if (typeof l.clientId !== 'string' || !l.clientId || typeof l.text !== 'string' || typeof l.timestamp !== 'string') return null;
    return { clientId: l.clientId, text: l.text, replyToId: typeof l.replyToId === 'string' ? l.replyToId : null, timestamp: l.timestamp };
}

/** Each chat's lines, as kept; anything else in the value is none. */
function parse(raw: string | null | undefined): Map<string, UnsentLine[]> {
    const out = new Map<string, UnsentLine[]>();
    try {
        const parsed: unknown = JSON.parse(raw ?? '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
        for (const [chat, lines] of Object.entries(parsed as Record<string, unknown>)) {
            if (!CHAT_ID.test(chat) || !Array.isArray(lines)) continue;
            const kept = lines.map(lineOf).filter((l): l is UnsentLine => l !== null);
            if (kept.length > 0) out.set(chat, kept.slice(-UNSENT_MAX_A_CHAT));
        }
    } catch {
        // Lines that can't be read are none.
    }
    return out;
}

const valueOf = (chats: Map<string, UnsentLine[]>): string | null => (chats.size > 0 ? JSON.stringify(Object.fromEntries(chats)) : null);

let writes: Promise<unknown> = Promise.resolve();

/** `chatId`'s unsent lines kept for `me` in `file`, after any write under way. None when they can't be read. Never throws. */
export async function readUnsent(storage: Pick<Storage, 'getItem'>, me: string, file: string, chatId: string): Promise<UnsentLine[]> {
    await writes;
    if (!CHAT_ID.test(chatId)) return [];
    try {
        return parse(await storage.getItem(groupUnsentStoreKey(me, file))).get(chatId) ?? [];
    } catch {
        return [];
    }
}

/** `chatId`'s unsent lines are `lines` now (none: its entry goes), after any write under way. Never throws. */
export function keepUnsent(storage: Storage, me: string, file: string, chatId: string, lines: readonly UnsentLine[]): Promise<void> {
    const next = writes.then(async () => {
        if (!CHAT_ID.test(chatId)) return;
        const key = groupUnsentStoreKey(me, file);
        const raw = await storage.getItem(key);
        const chats = parse(raw);
        const kept = lines.map(lineOf).filter((l): l is UnsentLine => l !== null).slice(-UNSENT_MAX_A_CHAT);
        if (kept.length > 0) chats.set(chatId, kept);
        else chats.delete(chatId);
        const value = valueOf(chats);
        if (value === raw) return;
        if (value === null) await storage.removeItem(key);
        else await storage.setItem(key, value);
    }).catch((e) => {
        console.warn('[GroupChat] A line not sent could not be kept', e);
    });
    writes = next;
    return next;
}

/** A community followed to a new address (community-copy-carry.ts MERGES): the old name's lines join the new name's, each once. */
export function unsentWithCarried(here: string | null, carried: string): string | null {
    const chats = parse(here);
    for (const [chat, lines] of parse(carried)) {
        const mine = chats.get(chat) ?? [];
        const ids = new Set(mine.map((l) => l.clientId));
        chats.set(chat, [...mine, ...lines.filter((l) => !ids.has(l.clientId))].slice(-UNSENT_MAX_A_CHAT));
    }
    const value = valueOf(chats);
    return value === here ? null : value;
}
