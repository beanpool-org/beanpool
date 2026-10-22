/**
 * The List sheet's "Put this in your shop" (scratch/tools/DESIGN-tool-template-fable.md §1.5, slice S4′), carried to the
 * Offer the map's composer posts. The sheet hands its draft to the composer (tools/doors.ts), which is map.tsx's: it saves
 * its own fields as the member types and never carries one it doesn't know, and map.tsx is not edited for this. So the
 * choice rides beside the draft, under its own key, and the one call the composer makes to post (utils/db.ts createPost)
 * reads it there.
 *
 * It holds for one Offer only: in the community the sheet was opened in, with the title the sheet showed (spaces and case
 * aside), for everyone here (a shop shows what everyone can see), and for a day. Anything else posts as the composer says,
 * outside the shop; the member can put it in afterwards from Your shop ("Add my live Offers") or the Offer's edit toggle.
 * createPost forgets it once the Offer is posted. No network here, so utils/db.ts can import it.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const SHOP_CHOICE_KEY = 'beanpool_offer_shop_choice';
/** How long the choice waits for its Offer: a member may leave the composer to set a profile photo and come back. */
export const SHOP_CHOICE_HOLDS_MS = 24 * 60 * 60 * 1000;
/**
 * How long createPost waits for the member's shop (read, and opened if they have none) before it gives up and keeps the
 * draft: as long as the post itself waits. Without it, a link that takes the request and never answers (a captive portal,
 * a stalled 2G line) holds the composer's Post greyed, with no word, until the phone's network stack gives up. The Offer
 * edit's Save waits no longer for the shop it opens first (components/shop/ShopToggle.tsx shopIdForEdit).
 */
export const SHOP_COMPOSER_WAIT_MS = 10_000;

export interface ShopChoice {
    anchorUrl: string | null;
    title: string;
    savedAt: number;
}

/** What the composer is posting, as far as the choice goes (createPost's argument). */
export interface ComposerPost {
    type?: unknown;
    title?: unknown;
    audienceScope?: unknown;
    audience_scope?: unknown;
    targetGroupId?: unknown;
    target_group_id?: unknown;
    targetPubkey?: unknown;
    target_pubkey?: unknown;
}

const sameTitle = (a: string, b: string) => a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();

/** Whether a choice the sheet left holds for this Offer, posted from this community at `now`. */
export function shopChoiceHolds(choice: unknown, post: ComposerPost, anchorUrl: string | null, now: number): boolean {
    if (!choice || typeof choice !== 'object') return false;
    const c = choice as Partial<ShopChoice>;
    if (typeof c.title !== 'string' || !c.title.trim() || typeof c.savedAt !== 'number' || !Number.isFinite(c.savedAt)) return false;
    if (now < c.savedAt || now - c.savedAt > SHOP_CHOICE_HOLDS_MS) return false;
    if ((c.anchorUrl ?? null) !== (anchorUrl ?? null)) return false;
    if (post.type !== 'offer' || typeof post.title !== 'string' || !sameTitle(post.title, c.title)) return false;
    const scope = post.audienceScope ?? post.audience_scope;
    if (scope !== undefined && scope !== null && scope !== 'public') return false;
    return !(post.targetGroupId || post.target_group_id || post.targetPubkey || post.target_pubkey);
}

/** The sheet's choice, kept for the Offer titled `title` (on), or forgotten (off). */
export async function rememberShopChoice(anchorUrl: string | null, title: string, inShop: boolean, now: number = Date.now()): Promise<void> {
    try {
        if (inShop) await AsyncStorage.setItem(SHOP_CHOICE_KEY, JSON.stringify({ anchorUrl, title, savedAt: now } satisfies ShopChoice));
        else await AsyncStorage.removeItem(SHOP_CHOICE_KEY);
    } catch { /* best-effort, as the composer's own draft is */ }
}

/** The choice as kept, or null. */
export async function peekShopChoice(): Promise<ShopChoice | null> {
    try {
        const raw = await AsyncStorage.getItem(SHOP_CHOICE_KEY);
        return raw ? JSON.parse(raw) as ShopChoice : null;
    } catch {
        return null;
    }
}

export async function clearShopChoice(): Promise<void> {
    try { await AsyncStorage.removeItem(SHOP_CHOICE_KEY); } catch { /* nothing to forget */ }
}
