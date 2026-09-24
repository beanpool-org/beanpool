/**
 * What a backup or a restore did NOT bring, in one sentence, for whichever screen is looking.
 *
 * A node ships every image object its store holds and says how many it could not (storage design §7,
 * confirmation round 4). A missing object never stops a backup any more — the refusal it replaced made a node
 * with one lost photo un-backupable from every screen — so "short" is now something that arrives as a
 * SUCCESSFUL response, and the only place an operator can learn of it is the UI that made the request. Hiding
 * it turns a labelled shortfall back into the silent one the whole design exists to prevent.
 *
 * Two readings, because the shortfall arrives two ways:
 *
 *   - a download answers 200 with the counts in headers ({@link downloadShortfall});
 *   - a restore answers 200 with them in the body ({@link restoreShortfall}), measured off the restored
 *     database rather than read off the archive's label.
 *
 * Both return '' when there is nothing to say, so a caller can append unconditionally.
 */

/** `X-Backup-Images: <staged>/<referenced>` and `X-Backup-Missing-Images`, when the response is short. */
export function downloadShortfall(res: {
    headers: { get(name: string): string | null };
}): string {
    const counts = res.headers.get('X-Backup-Images') || '';
    const [staged, referenced] = counts.split('/').map(Number);
    const stated = Number(res.headers.get('X-Backup-Missing-Images'));
    const missing = Number.isFinite(stated) && stated > 0
        ? stated
        : (Number.isFinite(staged) && Number.isFinite(referenced) && referenced > staged ? referenced - staged : 0);
    if (missing <= 0) return '';
    const of = Number.isFinite(referenced) && referenced > 0 ? ` of ${referenced}` : '';
    return `This backup is missing ${missing}${of} photo(s) or attachment(s): the node no longer holds those `
        + 'objects, and the archive lists which ones. Everything else is in the file.';
}

/**
 * The restore answer: `warning` when the server wrote one, otherwise built from what it measured.
 *
 * The server's `warning` is the sentence to prefer — it knows whether the objects were already gone when the
 * backup was taken or were lost on the way here. `complete`/`images.missing` are the fallback for a server
 * that answered before it said either.
 */
export function restoreShortfall(body: unknown): string {
    const b = (body ?? {}) as {
        warning?: unknown;
        complete?: unknown;
        images?: { missing?: unknown; referenced?: unknown; error?: unknown } | null;
    };
    if (typeof b.warning === 'string' && b.warning) return b.warning;
    const missing = Number(b.images?.missing);
    if (Number.isFinite(missing) && missing > 0) {
        const referenced = Number(b.images?.referenced);
        const of = Number.isFinite(referenced) && referenced > 0 ? ` of ${referenced}` : '';
        return `The database was restored, but ${missing}${of} photo(s) or attachment(s) it references are not `
            + 'on this node.';
    }
    if (typeof b.images?.error === 'string' && b.images.error) {
        return `The database was restored, but the image store was not put back in full: ${b.images.error}`;
    }
    // `complete: false` with nothing else said: the node could not check. Still not a clean success.
    if (b.complete === false) {
        return 'The database was restored, but this node could not confirm its photos and attachments came with it.';
    }
    return '';
}

/** The same sentence as a suffix for a success message: ' ⚠️ …', or '' when there is nothing short. */
export function shortfallSuffix(text: string): string {
    return text ? ` ⚠️ ${text}` : '';
}
