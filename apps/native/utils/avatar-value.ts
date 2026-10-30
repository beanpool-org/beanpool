import { clearPendingProfileChange } from './pending-profile-sync';

/**
 * Is an avatar value ours to publish, or is it something a node handed us?
 *
 * The phone keeps a member's avatar in two places: the per-node `members` row in SQLite, and
 * the canonical (node-independent) profile that used to follow the person onto every node they
 * join (no publish and no screen reads it for a picture any more: Profile S2, see catchUpAvatar).
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
 * Unlike an explicit edit there is no session pick to go on, so the one thing it can send is a
 * photo picked during an OFFLINE save here: it is sitting portable in this community's row —
 * nothing has reached the node yet, so it is the newest copy anywhere and always goes. A row
 * that holds the node's own URL, or no photo, sends nothing: the field is left out, which is how
 * the node is told "unchanged".
 *
 * It no longer sends the phone's last choice anywhere else (the copy of it kept for every
 * community, utils/canonical-profile.ts), to a community whose row holds no photo. That was a
 * picture chosen in one community appearing in every other the member joined, unasked — a preset
 * included (Profile S2, scratch/fable-design/DESIGN-per-community-profile-fable.md §3: nothing is
 * published to community B from a choice made in community A). A fresh community has no photo for
 * the member until they choose one there, and the marketplace's photo gate says so (utils/
 * profile-status.ts), as it does in any community without one.
 */
export function catchUpAvatar(localRow: string | null | undefined): string | null {
    return isPortableAvatarValue(localRow) ? localRow.trim() : null;
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
 *   2. otherwise the pick an offline save parked for THIS community (`parked`, from its
 *      pending-profile-sync.ts entry), re-checked for portability;
 *   3. otherwise, and only for a CATCH-UP caller, what `catchUpAvatar` licenses: a photo picked
 *      offline in this community that is still sitting portable in its row;
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
 * Setup. The settings Save passes none: a Save the member did not make about their photo must
 * never republish a copy that may be older than what the node holds.
 *
 * `parked` is the caller's to read, from the change waiting for the community it publishes to
 * (pending-profile-sync.ts `pendingProfileChange`), never one for the phone: a photo parked in
 * one community and read here for another was published there.
 */
export async function resolveProfilePublishAvatar(input: {
    sessionPick?: string | null;
    parked?: string | null;
    catchUp?: {
        localRow?: string | null;
    };
}): Promise<ProfilePublishAvatar> {
    const sessionPick = explicitEditAvatar(input.sessionPick);
    if (sessionPick) return { avatar: sessionPick, clearsParkedPick: true };

    // Only once the session pick has come up empty: the parked pick goes when this publish has
    // nothing newer of its own to send.
    const parked = input.parked;
    if (isPortableAvatarValue(parked)) return { avatar: parked.trim(), clearsParkedPick: true };

    if (input.catchUp) {
        return {
            avatar: catchUpAvatar(input.catchUp.localRow),
            clearsParkedPick: false,
        };
    }
    return { avatar: null, clearsParkedPick: false };
}

/**
 * Drop the parked pick — and the change it waits in, which arms its retry — but ONLY after a
 * 2xx from `community` whose payload actually carried it (or something newer).
 *
 * Call this instead of clearing the change by hand on a publish path. A publish that said
 * nothing about the photo must leave it alone, or it disarms the retry for a pick that has
 * reached nothing: exactly the defect this round fixes. Callers must not call it until the node
 * has answered 2xx AND (where they check) the echo confirmed the avatar stored. Only
 * `community`'s change goes (pending-profile-sync.ts): one waiting for another community waits.
 */
export async function retireParkedPickAfterPublish(decision: ProfilePublishAvatar, community: string | null): Promise<void> {
    if (!decision.clearsParkedPick) return;
    await clearPendingProfileChange(community);
}
