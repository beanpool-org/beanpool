/**
 * Frozen forum vectors (forum.ts): the proof an Ask to join carries for a public post (slice F11), and public answers that
 * must pass and must fail the list of fields a public answer may hold (slice F7). Shared by core's tests, the node's and the
 * apps', so every runtime is held to the SAME bytes, whichever SHA-256 does the hashing.
 *
 * How the proofs were made: Node's `crypto.createHmac('sha256', secret)` over `FORUM_PROOF_TAG + '\n' + postId + '\n' +
 * writerKey`, run once (14 Nov 2026), and the output pasted here, independently of forum.ts's @noble/hashes. Never
 * regenerate them to make a client pass: a client that no longer makes these proofs has changed what every admin's app checks.
 *
 * Kept out of the main index (import `@beanpool/core/forum-vectors`) so no app bundle carries it unless a test does.
 */

/** The writer's key: the sign-in share vectors' key (sso-share-vectors.ts). */
export const FORUM_VECTOR_KEY = '2c984dac86ce43aef51c4875274d268fa69e14ae8145efdeff99716620edb4e9';
/** Another person's key: RFC 8032's first test key. */
export const FORUM_VECTOR_OTHER_KEY = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
/** The writer's secret: bytes 1 to 32. */
export const FORUM_VECTOR_SECRET = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';
/** Another secret: 0xa0 to 0xbf. */
export const FORUM_VECTOR_OTHER_SECRET = 'a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf';

export interface ForumProofVector {
    postId: string;
    writerKey: string;
    secret: string;
    proof: string;
}

export const FORUM_PROOF_VECTORS: readonly ForumProofVector[] = [
    { postId: 'ft-vector-0001', writerKey: FORUM_VECTOR_KEY, secret: FORUM_VECTOR_SECRET, proof: '6c72670010982819b213e07b136865116bc0f4a7de5c4bb32e83a89c08c6addb' },
    { postId: 'ft-vector-0001', writerKey: FORUM_VECTOR_OTHER_KEY, secret: FORUM_VECTOR_SECRET, proof: '0ad44febcd9bccc36778ace58efecb7da05d45f29d7e6a4367d3d0773da56268' },
    { postId: 'ft-vector-0001', writerKey: FORUM_VECTOR_KEY, secret: FORUM_VECTOR_OTHER_SECRET, proof: '3364df68f416b9db6ec945618104b20c1859230fb9ff08a8d4f45ea87a236146' },
    { postId: 'ft-vector-0002', writerKey: FORUM_VECTOR_KEY, secret: FORUM_VECTOR_SECRET, proof: '27d6d2703391dbd118c4e50b79033e8b98c724866edaccf0b093e47664df01e3' },
];

/** A public topic and a public post holding every allowed field, and nothing else. */
export const FORUM_PUBLIC_TOPIC_OK = Object.freeze({
    id: 'ft-1', sectionId: 'fs-1', title: 'Seed swap ideas', writer: { name: 'Asha', community: null }, createdAt: '2026-11-14T00:00:00.000Z',
    lastActivityAt: '2026-11-14T01:00:00.000Z', replyCount: 3, pinned: false, closed: null, place: 'near Kyogle', lang: 'en', indexable: true,
});
export const FORUM_PUBLIC_POST_OK = Object.freeze({
    id: 'fp-1', topicId: 'ft-1', number: 1, writer: { name: 'Asha', community: 'Byron' }, words: 'Bring seeds.', quotes: null,
    createdAt: '2026-11-14T00:00:00.000Z', edited: false, removed: null, photos: 1, lang: 'en', proof: FORUM_PROOF_VECTORS[0].proof,
});

/**
 * Fields that must never reach a public answer (design §7: never a picture of a person, a key, a profile link, an area, who
 * voted, who follows), each failing the check whether it is put on the topic, the post or the writer.
 */
export const FORUM_PUBLIC_NEVER = Object.freeze([
    'publicKey', 'writerKey', 'writer_pubkey', 'avatar', 'avatarUrl', 'photo', 'profile', 'area', 'lat', 'lng', 'voters', 'followers',
    'hidden', 'waiting', 'sectionGroup', 'email',
] as const);
