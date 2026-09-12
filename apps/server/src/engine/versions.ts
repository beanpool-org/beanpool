/**
 * In-memory monotonic version counters backing the cheap ETags on the list endpoints.
 *
 * These live in their own dependency-free module on purpose. The counters are read at the very
 * top of `GET /api/marketplace/posts` and `GET /api/community/members` to answer a conditional
 * request with a 304 *before* touching SQLite, so every write path that changes one of those
 * responses has to be able to bump them — including low-level engine modules like
 * `engine/members.ts`, which cannot import `state-engine.ts` without a cycle.
 *
 * Seeded from `Date.now()` so a restart cannot hand out a version a client has already cached.
 *
 * The cost of a missed bump is not a stale second — it is a client pinned to stale data
 * indefinitely, because the 304 path never reads the database to notice it was wrong. When
 * adding a write path to `posts` or `members`, bump it here or route it through `broadcast()`.
 */

let postsVersion = Date.now();
let membersVersion = Date.now();

export function getPostsVersion(): number {
    return postsVersion;
}

export function bumpPostsVersion(): number {
    return ++postsVersion;
}

export function getMembersVersion(): number {
    return membersVersion;
}

export function bumpMembersVersion(): number {
    return ++membersVersion;
}
