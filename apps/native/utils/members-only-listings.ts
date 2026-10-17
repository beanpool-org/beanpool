/**
 * A local community's listings are its members' (Marty, 2026-09-28). The node refuses them to anyone else, a phone
 * visiting a community its key is no member of included (utils/nodes.ts guest nodes), with `code: 'members_only'`
 * (apps/server https-server.ts LISTINGS_MEMBERS_ONLY). The sync notes that refusal for the community it asked, so the
 * Market can say what it is, with the way to the global community, instead of "Having trouble connecting".
 *
 * Two more refusals are noted the same way (design scratch/global-node/DESIGN-global-entry-fable.md §1.3, §C.3, P3): a
 * community in a private preview refuses every read by a non-member with its own sentence (403 `private_preview`, apps/
 * server config/private-preview.ts), and a community refuses every signed request by a key whose account there was closed
 * (403 `account_closed`, https-server.ts). Each is an answer, not a lost connection, and the Market says so.
 *
 * The note is kept per community address and cleared by the next posts answer that is no refusal. A members-only note is
 * stored as `'1'`, as builds before the other two wrote it; the others as JSON.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { communityName } from './community-name';
import { SAVED_NODES_STORE_KEY } from './storage-keys';

const KEY_PREFIX = 'beanpool_members_only_';
/** The most of a node's own sentence the Market shows: a node's words, so bounded. */
const SENTENCE_MAX = 300;

/**
 * A community's refusal of this phone's read of its listings. `sentence`: the preview's own words, as the node sent
 * them (null if it sent none). `community`: the name the phone shows for it, filled in by {@link refusalHere}.
 */
export type Refusal =
    | { code: 'members_only' }
    | { code: 'private_preview'; sentence: string | null }
    | { code: 'account_closed'; community?: string };

const codeOf = (body: unknown): unknown => (body && typeof body === 'object' ? (body as { code?: unknown }).code : undefined);

/**
 * Which refusal a posts answer is, keeping its code: members-only (401 or 403), a private preview or a closed account
 * (403). Null for anything else: another code, another status, no body.
 */
export function refusalOf(status: number, body: unknown): Refusal | null {
    const code = codeOf(body);
    if (code === 'members_only' && (status === 401 || status === 403)) return { code };
    if (status !== 403) return null;
    if (code === 'private_preview') {
        const said = (body as { error?: unknown }).error;
        const sentence = typeof said === 'string' && said.trim() ? said.trim().slice(0, SENTENCE_MAX) : null;
        return { code, sentence };
    }
    if (code === 'account_closed') return { code };
    return null;
}

/** Whether a posts answer is the node refusing its listings to a non-member: 401 or 403 with that code. */
export function isMembersOnlyAnswer(status: number, body: unknown): boolean {
    return refusalOf(status, body)?.code === 'members_only';
}

/**
 * A preview's refusal is the same sentence for an unsigned read as for a stranger's (the gate refuses a request that
 * names no member's key), and a member's phone reads unsigned when it can't reach its key (a locked iPhone). So what it
 * notes is the membership probe's word, signed with this phone's key:
 * - no member here (200 `isMember: false`), or the probe itself refused with the preview's code by a node from before the
 *   probe was opened to visitors (signed by this key, that too says it is no member): the preview;
 * - this key's account here was closed (403 `account_closed`, answered once the signature checks out; in a preview a
 *   closed key's reads meet the preview first): the closed account;
 * - anything else (a member, whose read went unsigned; no clear answer): undefined, the note left as it was.
 */
export function noteAfterPreview(preview: Refusal & { code: 'private_preview' }, probeStatus: number, probeBody: unknown): Refusal | undefined {
    if (probeStatus === 200) {
        return probeBody && typeof probeBody === 'object' && (probeBody as { isMember?: unknown }).isMember === false ? preview : undefined;
    }
    if (probeStatus !== 403) return undefined;
    const code = codeOf(probeBody);
    if (code === 'private_preview') return preview;
    if (code === 'account_closed') return { code };
    return undefined;
}

/** Records, for this community's address, the refusal of its last posts answer (null: none). Never throws. */
export async function noteRefusal(anchorUrl: string, refusal: Refusal | null): Promise<void> {
    try {
        if (!refusal) await AsyncStorage.removeItem(KEY_PREFIX + anchorUrl);
        else if (refusal.code === 'members_only') await AsyncStorage.setItem(KEY_PREFIX + anchorUrl, '1');
        else await AsyncStorage.setItem(KEY_PREFIX + anchorUrl, JSON.stringify(
            refusal.code === 'private_preview' ? { code: refusal.code, sentence: refusal.sentence } : { code: refusal.code }));
    } catch { /* storage unavailable: the Market reads as before */ }
}

function readNote(raw: string | null): Refusal | null {
    if (raw === '1') return { code: 'members_only' };
    if (!raw) return null;
    try {
        const note = JSON.parse(raw);
        if (note?.code === 'private_preview') return { code: 'private_preview', sentence: typeof note.sentence === 'string' && note.sentence ? note.sentence : null };
        if (note?.code === 'account_closed') return { code: 'account_closed' };
    } catch { /* not a note */ }
    return null;
}

/**
 * The refusal the community this phone is looking at gave it on the last sync, or null. A closed account's carries the
 * community's name as the BeanPool sheet shows it (utils/community-name.ts). Never throws.
 */
export async function refusalHere(): Promise<Refusal | null> {
    try {
        const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
        if (!anchorUrl) return null;
        const refusal = readNote(await AsyncStorage.getItem(KEY_PREFIX + anchorUrl));
        if (refusal?.code !== 'account_closed') return refusal;
        let alias: string | null = null;
        try {
            const saved = JSON.parse((await AsyncStorage.getItem(SAVED_NODES_STORE_KEY)) ?? '[]');
            const here = Array.isArray(saved) ? saved.find((n: { url?: unknown }) => n?.url === anchorUrl) : null;
            alias = typeof here?.alias === 'string' ? here.alias : null;
        } catch { /* no saved list: the address's host names it */ }
        return { code: 'account_closed', community: communityName({ url: anchorUrl, alias }) };
    } catch {
        return null;
    }
}
