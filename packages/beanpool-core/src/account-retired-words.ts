/**
 * What a member's own app says when its community refuses this key with 403 `account_retired` (apps/server
 * https-server.ts): an owner retired the account as an empty duplicate (server engine/retire-duplicate.ts). It is an
 * answer about the account, never a lost connection, so neither app may read it as "trouble connecting".
 *
 * One line, the same on the phone (the not-recognised screen's closed page: apps/native utils/membership-answer.ts reads
 * the code) and on the web (in place of "Offline" or "couldn't reach": apps/pwa lib/standing-refusal.ts), saying who did
 * it and what to do. Shown through t() where it is drawn.
 */
import { word } from './words.js';

/** The node's refusal code for a retired empty duplicate's key (https-server.ts signature gate). */
export const ACCOUNT_RETIRED_CODE = 'account_retired';

export const ACCOUNT_RETIRED_LINE = word("An owner retired this account as an empty duplicate. Sign in with your other account. If that's wrong, ask an owner to bring it back.");
