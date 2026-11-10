/**
 * Conversion code, log row CUT3, remove in the first phone build after Play Console shows no device below 1.4.0 for 30
 * days (Marty's yes, 10 Nov 2026: DESIGN-clean-slate-cutover-fable.md §2 and §7 Q1).
 *
 * Keys older builds left on the phone that nothing reads any more, deleted at every start: absent ones cost nothing, so
 * there is no flag of its own to mark it done. Never read, never moved, never converted: only deleted.
 *   - `bp_trust_sync_v3`: the old one-off "read every sync cursor again" flag (audit C7). The standing rule replaces it: a
 *     copy below the build's schema number is cleared and read again (utils/db.ts COPY_SCHEMA).
 *   - `bp_legacy_post_conv_cleaned_v1`: the old one-off "listing-keyed chats cleaned" flag (audit C8), the same.
 *   - `beanpool_pending_claim`: a claim code a build of 23 Oct 2026 (#2412) kept at rest for an account made elsewhere
 *     (audit C12). That detour is gone: the claim makes the account (app/claim-community.tsx). A wipe deletes it too.
 *   - `beanpool_light_palette`: the retired Classic / Earth / Slate choice (audit C11; lane 910 removed its reader and the
 *     sweep that deleted it, #3026).
 * The other half of CUT3 is the secure store's kept break-glass code (utils/break-glass.ts sweepKeptBreakGlassCode, audit
 * C13), which needs the community and the key to name it.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const RETIRED_KEYS = ['bp_trust_sync_v3', 'bp_legacy_post_conv_cleaned_v1', 'beanpool_pending_claim', 'beanpool_light_palette'] as const;

/** Delete every retired key (RETIRED_KEYS). Never throws. */
export async function forgetRetiredKeys(): Promise<void> {
    try {
        await AsyncStorage.multiRemove([...RETIRED_KEYS]);
    } catch {
        // The store unavailable: tried again at the next start.
    }
}
