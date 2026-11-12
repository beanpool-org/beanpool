/**
 * Opening a Home chat card's sealed lines on the phone (scratch/fable-design/DESIGN-home-chosen-chat-fable.md §1, §3,
 * slice C2). No new opener: a DM's lines go through db.ts judgeHomeChatDmLines (the DM screen's own key context and core
 * checkDmThread); a locked group's through the line-display rule (group-line-display.ts groupLineView) with a key ONLY if
 * this session already has it open (GroupKeyring.openedKey: nothing is opened, synced, fetched or refused for the card).
 * The card never fetches (frame rule), and what is opened lives in the screen's memory only: never in SQLite, the kept
 * answer (utils/home-store.ts) or any other cache.
 */
import { dmLineKind, dmLineShownText, type HomeChatCard, type HomeChatLine, type HomeChatSettings } from '@beanpool/core';
import type { OpenedChat, OpenedChatLine } from './home-chat';
import { groupLineView, GROUP_LINE_FORMER_MEMBER, type ServedGroupLine } from './group-line-display';
import { openLine } from './group-chat-crypto';
import type { GroupKeyring } from './group-chat-keys';

/** What the opener needs from the phone: db.ts's doors, passed in so the tests can hand fakes. */
export interface HomeChatOpenDeps {
    judgeDm: (conversationId: string, lines: { id: string; author: string; type: string; at?: string | null; sealed: NonNullable<HomeChatLine['sealed']> }[]) =>
        Promise<Map<string, { text: string | null; mark: string | null }> | null>;
    keyring: (groupId: string) => Promise<Pick<GroupKeyring, 'groupId' | 'openedKey' | 'signerSeen' | 'successions' | 'seenLocked' | 'memo'>>;
    /** db.ts isKnownDmConversation: this phone knows the id as a DM (its pins, its DM list, a dm row or an encrypted line). */
    knownDm: (conversationId: string) => Promise<boolean>;
}

/** The DM guard asked once, failing closed as db.ts isDmHere does: a read that throws, or any answer but `false`, is a DM. */
async function isKnownDm(conversationId: string, deps: HomeChatOpenDeps): Promise<boolean> {
    try { return (await deps.knownDm(conversationId)) !== false; } catch { return true; }
}

const sealedOf = (lines: readonly HomeChatLine[]) => lines.filter((l): l is HomeChatLine & { sealed: NonNullable<HomeChatLine['sealed']> } => !!l.sealed);

/** A DM's lines: the sealed ones as the DM screen judges them, a readable one as core dmLineKind places it. */
async function openDm(pick: HomeChatSettings, lines: readonly HomeChatLine[], deps: HomeChatOpenDeps): Promise<OpenedChat> {
    const out = new Map<string, OpenedChatLine>();
    const sealed = sealedOf(lines);
    // With the node's time for each line, so one from before 1.4.0 opens as old, as on the web (conversion code, log row OLDCHAT, remove after 12 Dec 2026).
    const views = sealed.length ? await deps.judgeDm(pick.conversationId, sealed.map(l => ({ id: l.id, author: l.author, type: l.type, at: l.at, sealed: l.sealed }))).catch(() => null) : null;
    for (const l of lines) {
        if (l.type === 'removed' || l.type === 'system' || l.author === 'SYSTEM') continue;
        if (l.sealed) {
            const v = views?.get(l.id);
            // No context on this phone yet (or the judge failed): nothing opens, and the line says it is locked.
            if (!views || !v) { out.set(l.id, { kind: 'waiting' }); continue; }
            if (v.mark === 'not-verified' || v.mark === 'not-encrypted' || v.text == null) out.set(l.id, { kind: 'nobody', text: dmLineShownText(v as Parameters<typeof dmLineShownText>[0]) });
            else out.set(l.id, { kind: 'words', text: v.text, signer: l.author });
            continue;
        }
        if (!('metadata' in l)) continue; // a sealed line too long to carry: home-chat.ts says it is locked
        // A readable line in a DM: only the admin page's message is anyone's words, and it is the admins', never a member's.
        const kind = dmLineKind({ authorPubkey: l.author, nonce: 'plaintext-v1', type: l.type, metadata: l.metadata ?? null });
        out.set(l.id, kind === 'from-admins' && typeof l.text === 'string'
            ? { kind: 'nobody', text: l.text }
            : { kind: 'nobody', text: dmLineShownText({ text: null, format: null, after: null, mark: 'not-encrypted' }) });
    }
    return { lines: out };
}

/** A group's lines: each sealed one by the display rule, with a key only if it is already open in this session. */
async function openGroup(pick: HomeChatSettings, lines: readonly HomeChatLine[], deps: HomeChatOpenDeps): Promise<OpenedChat> {
    const out = new Map<string, OpenedChatLine>();
    let ring: Awaited<ReturnType<HomeChatOpenDeps['keyring']>>;
    // Its key memory unreadable: nothing opens, and the chat is locked, as seenLocked() fails closed below.
    try { ring = await deps.keyring(pick.conversationId); } catch { return { lines: out, locked: true }; }
    // Read from what this phone keeps (no request): a group it has held keys of is locked here whatever the node says.
    const locked = await ring.seenLocked().catch(() => true);
    // The card only reads the verdicts this phone has: it adds none (the chat screen keeps them).
    const memo = { has: (k: string) => ring.memo.has(k), add: () => { } };
    for (const l of sealedOf(lines)) {
        const served = (editedAt: string | null): ServedGroupLine => ({
            id: l.id, authorPubkey: l.author, authorCallsign: l.who, ciphertext: l.sealed.ciphertext, nonce: l.sealed.nonce,
            metadata: l.sealed.metadata, editedAt, type: l.type,
        });
        // The node sent only lines from this member's membership on (fromEpochOf), so their first epoch is any.
        const ctx = {
            groupId: ring.groupId, fromEpoch: 1, keyFor: (e: number) => ring.openedKey(e), open: openLine, memo, roster: [],
            signerSeen: (id: string) => ring.signerSeen(id), successions: ring.successions,
        };
        // The card carries no edit mark: a line that doesn't open as written is tried as an edit (sealed as part 'edit').
        let v = groupLineView(served(null), ctx);
        if (v.unverified) v = groupLineView(served(l.at), ctx);
        if (v.hidden) out.set(l.id, { kind: 'hidden' });
        else if (v.waitingKey) out.set(l.id, { kind: 'waiting' });
        else if (v.unverified || !v.signer) out.set(l.id, { kind: 'nobody', text: v.text });
        else out.set(l.id, { kind: 'words', text: v.text, signer: v.signer, name: v.signer === l.author ? null : (v.name ?? GROUP_LINE_FORMER_MEMBER) });
    }
    return { lines: out, locked };
}

/**
 * What the phone makes of a chat card's lines, in memory. The phone's own pick says what the chat is: a DM pick is always
 * judged as a DM (db.ts judgeHomeChatDmLines), a group pick by the group's rule, and a body the node sent as another kind
 * is no answer (fail closed, as the DM screen judges a chat by what this phone knows: db.ts getMessages). An event's or an
 * enterprise's chat is readable by design: its lines need no opening. Never throws: a line it can't open waits.
 *
 * The layout is stored on the node, so a node can rewrite a pinned DM's pick as another kind together with its body, and
 * pass the check that the two match. So a pick of any other kind is asked of this phone's own DM knowledge first (db.ts
 * isKnownDmConversation, once per open): one it knows as a DM is no answer (`knownDm`), as lib/dm-guard makes it on the
 * web. Nothing of it is judged or opened, and no group key is asked for it.
 */
export async function openHomeChat(pick: HomeChatSettings, card: HomeChatCard | null, deps: HomeChatOpenDeps): Promise<OpenedChat> {
    if (!card || 'gone' in card) return { lines: new Map() };
    if (card.kind !== pick.kind) return pick.kind === 'group' ? { lines: new Map(), locked: true } : { lines: new Map() };
    if (pick.kind === 'dm') return openDm(pick, card.lines, deps);
    if (await isKnownDm(pick.conversationId, deps)) return { lines: new Map(), knownDm: true };
    if (pick.kind === 'group') return openGroup(pick, card.lines, deps);
    return { lines: new Map() };
}

/** A print of what a card asks to open, so the screen opens it again only when its lines change. */
export function homeChatOpenKey(pick: HomeChatSettings, card: HomeChatCard | null): string {
    if (!card || 'gone' in card) return `${pick.conversationId}|${pick.kind}|-`;
    return `${pick.conversationId}|${pick.kind}|${card.kind}|${card.lines.map(l => `${l.id}@${l.at}:${l.sealed ? l.sealed.ciphertext.length : '-'}`).join(',')}`;
}
