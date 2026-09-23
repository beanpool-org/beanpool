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
 * The avatar to PUBLISH, given what the local per-node row holds and what the canonical store
 * holds.
 *
 * Prefers the local row when it is portable — it is the freshest thing the user picked on this
 * node — and otherwise falls back to the canonical copy. Returns null when neither is portable,
 * which callers must treat as "leave `avatar` out of the payload entirely", never as
 * `avatar: null`: the server reads an explicit null as "clear it" (engine/members.ts), so
 * sending one would finish the job the round-trip started.
 */
export function publishableAvatar(
    local: string | null | undefined,
    canonical: string | null | undefined,
): string | null {
    if (isPortableAvatarValue(local)) return local.trim();
    if (isPortableAvatarValue(canonical)) return canonical.trim();
    return null;
}
