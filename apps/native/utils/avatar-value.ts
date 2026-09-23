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
 * writes it. So there is no single `publishableAvatar` any more — an explicit edit and a
 * catch-up publish have different rules, and each gets its own function below.
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
 * The avatar the Re-run Setup wizard publishes.
 *
 * The wizard is an explicit edit, so a photo picked here wins outright. Without a pick it may
 * still publish the canonical copy, but ONLY when the node holds no photo for us — which is
 * also the only case in which the wizard displays the canonical copy. That keeps the
 * "finish your profile" gate that sent the member here satisfiable without a re-pick, while
 * making it impossible to put an older photo back over a newer one: when the node has a photo,
 * there is nothing this screen can publish except a fresh pick.
 */
export function profileSetupAvatar(
    sessionPick: string | null | undefined,
    nodeAvatar: string | null | undefined,
    canonical: string | null | undefined,
): string | null {
    return explicitEditAvatar(sessionPick) ?? catchUpAvatar(nodeAvatar, canonical);
}
