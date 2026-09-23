import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Is an avatar value ours to publish, or is it something a node handed us?
 *
 * The phone keeps a member's avatar in two places: the per-node `members` row in SQLite, and
 * the canonical (node-independent) profile that follows the person onto every node they join.
 * Since #725 a node emits photo avatars as `/api/avatar/<pk>?size=thumb` and the members sync
 * writes THAT into the local row. So the local row does not hold the photo — it holds a
 * pointer back at the node.
 *
 * Publishing that pointer as `avatar` (settings Save, pushProfileToServer, Re-run Setup) made
 * the node store a link to itself, after which `GET /api/avatar/<pk>` 404d and the photo was
 * gone from the node. Mirroring it into the canonical profile destroyed the only portable copy
 * the device had, so it was gone from the phone too, and the next node the member joined
 * received the broken string.
 *
 * A PORTABLE value is one that carries the picture itself, or names a shipped asset:
 * a `data:` URI, or `bundled://<id>`. Those are the only two things worth sending anywhere.
 * Everything else — a node URL, a device-local `file://` path, an empty or sentinel string —
 * is not.
 *
 * Portability alone is not enough to decide what to SEND, though: the canonical copy is
 * portable and may still be OLDER than the photo the node holds, because only a local pick ever
 * writes it. So an explicit edit and a catch-up publish weigh their inputs differently, and each
 * weighing gets its own small function below — but there is exactly ONE entry point that
 * publishers call, `resolveProfilePublishAvatar`, at the foot of this file. The screens composing
 * those small functions their own way is what let this defect recur twice.
 */

/**
 * True when `value` is an avatar the phone can publish to any node and store as canonical.
 *
 * Deliberately an allow-list, not "is it a node URL". A `file:///data/user/0/…` cache path is
 * just as useless on another device as a node URL is on another node, and both used to reach
 * the wire.
 */
export function isPortableAvatarValue(value: string | null | undefined): value is string {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return false;
    return /^data:/i.test(trimmed) || trimmed.startsWith('bundled://');
}

/**
 * The avatar an EXPLICIT edit publishes — the settings Save and the Re-run Setup wizard.
 *
 * Only a photo the member picked in THIS session. Anything else is omitted from the payload,
 * which the node reads as "avatar unchanged" (`update.avatar !== undefined ? … : existing`).
 *
 * The rule exists because the phone cannot tell a fresh canonical copy from a stale one. The
 * canonical store is written only by a LOCAL pick; both sync loops write the node's
 * `/api/avatar/…` URL into the `members` row without touching canonical. So after the member
 * changes their photo on the PWA or a paired device, this phone holds local row = the node's
 * URL and canonical = the PREVIOUS photo — and a bio-only Save that fell back to canonical
 * would post that previous photo and silently replace the newer one. A Save the member did not
 * make about their photo must not touch their photo.
 */
export function explicitEditAvatar(sessionPick: string | null | undefined): string | null {
    return isPortableAvatarValue(sessionPick) ? sessionPick.trim() : null;
}

/**
 * Does this node hold no photo for us?
 *
 * The members sync fills the local row from the node: a photo arrives as the node's own
 * `/api/avatar/<pk>?size=thumb` URL, and since decision (c) a node that holds a broken
 * (self-referential) value emits null for it. So a local row with NO avatar at all is the
 * phone's evidence that there is nothing on the node to overwrite.
 *
 * Only sound because `applyDelta` lets a null in the node's COMPLETE member list clear the
 * stored avatar — under the old unconditional COALESCE the row kept a stale URL forever and
 * this would have answered "the node has a photo" about a node that had none.
 */
export function localRowHasNoAvatar(localRow: string | null | undefined): boolean {
    if (typeof localRow !== 'string') return true;
    const trimmed = localRow.trim();
    return !trimmed || trimmed === 'null' || trimmed === 'undefined';
}

/**
 * The avatar a CATCH-UP publish sends — `pushProfileToServer`: the pending-sync retry after an
 * offline save, the publish right after redeeming an invite, and the marketplace photo-gate
 * heal.
 *
 * Unlike an explicit edit there is no session pick to go on, so the canonical copy is sent only
 * when the node is KNOWN to hold no photo for us. `nodeHasNoPhoto` is the node's own answer and
 * has three states, because "the node did not say" and "the node said it has one" are not the
 * same thing:
 *
 *   undefined — the node was not asked. Fall back to the local row: no avatar there is the
 *               phone's evidence that there is nothing on the node to overwrite.
 *   true      — the node just said it holds none ("please set a profile photo", or a redeem
 *               response with no servable avatar). Stronger than any local row, so canonical
 *               goes even over a stale URL.
 *   false     — the node said it HOLDS one. It may be newer than canonical, and the local row
 *               is no longer evidence of anything: an empty row on a node this device has
 *               never synced means unsynced, not empty. Nothing is published.
 *
 * A photo picked during an OFFLINE save is sitting portable in the local row — nothing has
 * reached the node yet, so it is the newest copy anywhere and always goes, whatever the node
 * holds.
 */
export function catchUpAvatar(
    localRow: string | null | undefined,
    canonical: string | null | undefined,
    nodeHasNoPhoto?: boolean,
): string | null {
    if (isPortableAvatarValue(localRow)) return localRow.trim();
    if (nodeHasNoPhoto === false) return null;
    if (nodeHasNoPhoto === true || localRowHasNoAvatar(localRow)) {
        return isPortableAvatarValue(canonical) ? canonical.trim() : null;
    }
    return null;
}

/**
 * ---------------------------------------------------------------------------
 * The ONE rule every profile publish path goes through.
 * ---------------------------------------------------------------------------
 *
 * The functions above each answer one half of the question, and having three screens compose
 * them their own way is what kept this class of defect alive: `fd7e6a8d` taught the catch-up
 * retry to prefer the parked pick, and the two EXPLICIT-edit paths went on ignoring it — an
 * online Save that was not about the photo sent no `avatar` at all and then cleared the parked
 * pick on the 200, so the member's photo reached nothing and nothing ever resent it. The card
 * still showed the pick (it is in the local row), so they had no reason to pick again.
 *
 * So the decision lives here once, and `settings.tsx`, `profile-setup.tsx` and
 * `pushProfileToServer` all call it. There is nowhere left for the paths to disagree.
 */

/**
 * What to publish, and whether publishing it retires the parked pick.
 *
 * `avatar === null` means LEAVE THE FIELD OUT — never send `avatar: null`, which the node reads
 * as "clear it" (`update.avatar !== undefined ? update.avatar : existing`).
 */
export type ProfilePublishAvatar = {
    avatar: string | null;
    /**
     * True when the payload carries the parked pick, or a pick from this session that is NEWER
     * than it. Either way the parked copy has been superseded and may be dropped once the node
     * has answered 2xx — and only then. False means a parked pick (if any) is still unsent.
     */
    clearsParkedPick: boolean;
};

/**
 * Decide the `avatar` field for any profile publish.
 *
 * In order:
 *   1. a photo picked in THIS session — an explicit edit, and the newest copy that exists;
 *   2. otherwise the pick parked by an offline save, re-checked for portability;
 *   3. otherwise, and only for a CATCH-UP caller, what `catchUpAvatar` licenses: the canonical
 *      copy when the node is known to hold no photo for us;
 *   4. otherwise nothing, and the field is left out.
 *
 * NOTE ON THE ORDER OF 1 AND 2 — the fix brief specified the parked pick first. That loses a
 * photo: with pick A parked by an earlier offline save and pick B chosen in this session, it
 * would publish A and clear both keys, so B — the newest photo anywhere, and the one the member
 * is looking at — would never be sent by anything. A session pick can only ever be newer than a
 * parked one, because parking happens from the session pick and the session pick only advances.
 * So the session pick goes first and, because it supersedes it, retires the parked copy with it.
 * Same single rule, same defect closed, without opening the mirror image of it.
 *
 * A caller passes `catchUp` only when it is entitled to step 3: `pushProfileToServer` (the
 * pending-sync retry, the marketplace photo-gate heal, the post-redeem publish) and Re-run
 * Setup, whose whole job is to satisfy the "finish your profile" gate without a re-pick. The
 * settings Save passes none: a Save the member did not make about their photo must never
 * republish a canonical copy that may be older than what the node holds.
 */
export async function resolveProfilePublishAvatar(input: {
    sessionPick?: string | null;
    catchUp?: {
        localRow?: string | null;
        canonical?: string | null;
        nodeHasNoPhoto?: boolean;
    };
}): Promise<ProfilePublishAvatar> {
    const sessionPick = explicitEditAvatar(input.sessionPick);
    if (sessionPick) return { avatar: sessionPick, clearsParkedPick: true };

    // Read only once the session pick has come up empty: the parked key is consulted when this
    // publish has nothing newer of its own to send.
    const parked = await AsyncStorage.getItem('pending_profile_avatar');
    if (isPortableAvatarValue(parked)) return { avatar: parked.trim(), clearsParkedPick: true };

    if (input.catchUp) {
        return {
            avatar: catchUpAvatar(input.catchUp.localRow, input.catchUp.canonical, input.catchUp.nodeHasNoPhoto),
            clearsParkedPick: false,
        };
    }
    return { avatar: null, clearsParkedPick: false };
}

/**
 * Drop the parked pick — and the pending flag that arms its retry — but ONLY after a 2xx whose
 * payload actually carried it (or something newer).
 *
 * Call this instead of removing either key by hand on a publish path. A publish that said
 * nothing about the photo must leave both alone, or it disarms the retry for a pick that has
 * reached nothing: exactly the defect this round fixes. Callers must not call it until the node
 * has answered 2xx AND (where they check) the echo confirmed the avatar stored.
 */
export async function retireParkedPickAfterPublish(decision: ProfilePublishAvatar): Promise<void> {
    if (!decision.clearsParkedPick) return;
    await AsyncStorage.removeItem('pending_profile_avatar');
    await AsyncStorage.removeItem('pending_profile_sync');
}
