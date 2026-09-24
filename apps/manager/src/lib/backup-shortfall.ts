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

/**
 * `X-Backup-Images: <staged>/<referenced>` and `X-Backup-Missing-Images`, when the response is short.
 *
 * The sentence claims only what the counts establish, because this reads two sources that are short for
 * different reasons. A node's own backup is short by objects its store no longer holds, and lists them in
 * `missing-images.json` inside the archive. A copy the fleet manager holds (`/api/manager/backups/…`) is
 * measured off its own database, and can be short by objects the MANAGER never kept — a harvester older than
 * the image store kept only `state.db` — with no manifest in the archive at all. "The node no longer holds
 * them, and the archive lists which ones" is false for that second kind, so it is not said for either; a
 * restore says why, off the manifest when the archive carries one.
 *
 * A file labelled `database+images-partial` with no counts that parse was never measured. The fleet manager
 * sends one when it cannot read a copy's database: it serves the copy and claims no count it did not take. The
 * label alone still has to reach the operator, so that case gets a sentence of its own. It says nothing about
 * how much is missing, and does not call the rest of the file whole.
 */
export function downloadShortfall(res: {
    headers: { get(name: string): string | null };
}): string {
    if (res.headers.get('X-Backup-Images') === 'in-bucket') return inBucketSentence(res);
    const counts = res.headers.get('X-Backup-Images') || '';
    const [staged, referenced] = counts.split('/').map(Number);
    const measured = Number.isFinite(staged) && Number.isFinite(referenced);
    const unchecked = !measured && res.headers.get('X-Backup-Contents') === 'database+images-partial';
    const stated = Number(res.headers.get('X-Backup-Missing-Images'));
    const missing = Number.isFinite(stated) && stated > 0
        ? stated
        : (measured && referenced > staged ? referenced - staged : 0);
    if (missing <= 0) {
        return unchecked
            ? 'This backup is marked incomplete, but its photos and attachments could not be checked against its '
                + 'database, so how many are missing is not known.'
            : '';
    }
    const of = Number.isFinite(referenced) && referenced > 0 ? ` of ${referenced}` : '';
    return `This backup is missing ${missing}${of} photo(s) or attachment(s) its database references: the file `
        + 'does not carry those objects. '
        + (unchecked
            ? 'The rest of its photos and attachments could not be checked against its database, so more may be missing.'
            : 'Everything else is in the file.');
}

/**
 * A backup from a node that keeps its photos in an S3 bucket (`IMAGE_STORE=s3`): the file is the database, and
 * the photos are in the bucket, by design. Never '' — whoever downloads it must not think the photos are
 * inside it — and never "missing N of N", which would read as a node that lost every photo. What CAN be short
 * is the bucket, which the node counted when it took the backup and sends as `X-Backup-Missing-Images`.
 */
function inBucketSentence(res: { headers: { get(name: string): string | null } }): string {
    const bucket = res.headers.get('X-Backup-Images-Bucket') || '';
    const missing = Number(res.headers.get('X-Backup-Missing-Images'));
    const referenced = Number(res.headers.get('X-Backup-Images-Referenced'));
    let text = 'This file holds the database only: the node keeps its photos and attachments in its S3 bucket'
        + `${bucket ? ` "${bucket}"` : ''}, not inside the backup.`;
    if (Number.isFinite(missing) && missing > 0) {
        const of = Number.isFinite(referenced) && referenced > 0 ? ` of the ${referenced}` : '';
        text += ` ${missing}${of} photo(s) or attachment(s) its database references were not in the bucket when it was taken.`;
    } else if (res.headers.get('X-Backup-Images-Checked') === 'no') {
        text += ' The bucket could not be checked when the backup was taken.';
    }
    return text;
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
