/**
 * Shared minimal valid photo for test fixtures (Marty, 26 Oct: market-photo-required).
 * Passes validatePostPhotos (base64 PNG data URL, valid image).
 */
export const TEST_PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';
export const TEST_PHOTOS = [TEST_PHOTO];

/**
 * Wraps createPost so test fixtures creating mock Offers/Needs/Events without photos
 * supply the shared test photo fixture. Polls stay photo-less.
 */
export function wrapCreatePost<T extends (...args: any[]) => any>(rawCreatePost: T): T {
    return ((type: string, category: string, title: string, description: string, credits: number,
             priceType: string, authorPublicKey: string, lat?: number, lng?: number,
             photos?: string[], repeatable?: boolean, id?: string, cashAlsoNeeded?: boolean,
             options?: any) => {
        const p = (type === 'poll' || options?.allowNoPhoto) ? photos : (!photos || photos.length === 0 ? TEST_PHOTOS : photos);
        return rawCreatePost(type, category, title, description, credits, priceType, authorPublicKey, lat, lng, p, repeatable, id, cashAlsoNeeded, options);
    }) as unknown as T;
}

/** The part of better-sqlite3's Database a fixture needs here, so this file stays free of the engine's imports. */
interface PollRows { prepare(sql: string): { run(...params: unknown[]): unknown } }

/**
 * A week passes for a member's polls: each poll `authorPublicKey` started (every author's when none is named) is moved
 * `days` back (8 by default, past the week a member waits between polls, engine/poll-week.ts). For a fixture that needs a
 * member to start a second poll after their first, as a real community would a week later. It moves only `created_at`:
 * the poll's status, closing time and votes are as they were.
 */
export function aWeekPasses(db: PollRows, authorPublicKey?: string, days = 8): void {
    const shift = `-${days} days`;
    if (authorPublicKey) db.prepare(`UPDATE posts SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, ?) WHERE type = 'poll' AND author_pubkey = ?`).run(shift, authorPublicKey);
    else db.prepare(`UPDATE posts SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, ?) WHERE type = 'poll'`).run(shift);
}
