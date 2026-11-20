/**
 * Every field of a conversation's listing (engine messaging.ts `Conversation`, as routes/messaging.ts lists it) that holds an
 * address: a path on the server that listed it, some carrying a key (a member's photo: their key and the community's face
 * key, `k=`). A request card of another community, drawn while the phone is set elsewhere, gets each made whole on that
 * community (db.ts requestsInPlace; #3309 review F2), never left as a path the community in use would be asked for.
 * utils/__tests__/requests-in-place-wrong-file.test.ts reads the engine's listing for every field named like an address,
 * so one added there and not here goes red.
 */
export const LISTED_ADDRESS_FIELDS = Object.freeze(['peerAvatar', 'postPhoto', 'avatarUrl'] as const);
