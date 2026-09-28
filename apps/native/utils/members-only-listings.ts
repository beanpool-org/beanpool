/**
 * A local community's listings are its members' (Marty, 2026-09-28). The node refuses them to anyone else, a phone
 * visiting a community its key is no member of included (utils/nodes.ts guest nodes), with `code: 'members_only'`
 * (apps/server https-server.ts LISTINGS_MEMBERS_ONLY). The sync notes that refusal for the community it asked, so the
 * Market can say what it is, with the way to the global community, instead of "Having trouble connecting".
 *
 * The note is kept per community address and cleared by the next posts answer that is not a refusal.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_PREFIX = 'beanpool_members_only_';

/** Whether a posts answer is the node refusing its listings to a non-member: 401 or 403 with that code. */
export function isMembersOnlyAnswer(status: number, body: unknown): boolean {
    return (status === 401 || status === 403)
        && !!body && typeof body === 'object' && (body as { code?: unknown }).code === 'members_only';
}

/** Records, for this community's address, whether its last posts answer was a members-only refusal. Never throws. */
export async function noteMembersOnly(anchorUrl: string, refused: boolean): Promise<void> {
    try {
        if (refused) await AsyncStorage.setItem(KEY_PREFIX + anchorUrl, '1');
        else await AsyncStorage.removeItem(KEY_PREFIX + anchorUrl);
    } catch { /* storage unavailable: the Market reads as before */ }
}

/** Whether the community this phone is looking at refused it its listings on the last sync. Never throws. */
export async function membersOnlyHere(): Promise<boolean> {
    try {
        const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
        if (!anchorUrl) return false;
        return (await AsyncStorage.getItem(KEY_PREFIX + anchorUrl)) === '1';
    } catch {
        return false;
    }
}
