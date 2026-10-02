// An enterprise's (and a crowdfund's) name and purpose, on the way in (#1493).
//
// The name is the enterprise's callsign and the purpose its words: the enterprises list, its map, the crowdfund list and the
// Commons projects list send both for every enterprise they hold, none of them paged, and "your groups" and every listing
// an enterprise posts carry the name. Until #1493 a name had a floor (2 characters) and no ceiling, and a purpose had
// nothing but the 2 MB request body. Held here to their limits (@beanpool/core text-limits.ts) by every route a member
// starts or edits one through: POST /api/enterprise and /api/treasury, and the crowdfund create and edit. The text an
// enterprise already holds, sent back unchanged by an edit, is not new and is kept, however long it was stored.

import { ENTERPRISE_NAME_LIMIT, ENTERPRISE_PURPOSE_LIMIT, fitsTextLimit, replaceLoneSurrogates, textTooLongMessage } from '@beanpool/core';

export const ENTERPRISE_NAME_TOO_LONG = textTooLongMessage("An enterprise's name", ENTERPRISE_NAME_LIMIT);
export const ENTERPRISE_PURPOSE_TOO_LONG = textTooLongMessage("An enterprise's purpose", ENTERPRISE_PURPOSE_LIMIT);

/**
 * Refuses a name or a purpose over its limit, in the words both apps show. `stored`: what the enterprise holds now, for an
 * edit; its own text sent back is not held to the limit. Anything that is not text is left to the caller's own checks.
 */
export function assertEnterpriseText(name: unknown, purpose: unknown, stored: { name?: unknown; purpose?: unknown } = {}): void {
    if (typeof name === 'string' && name !== stored.name && !fitsTextLimit(replaceLoneSurrogates(name.trim()), ENTERPRISE_NAME_LIMIT)) {
        throw new Error(ENTERPRISE_NAME_TOO_LONG);
    }
    if (typeof purpose === 'string' && purpose !== stored.purpose && !fitsTextLimit(replaceLoneSurrogates(purpose.trim()), ENTERPRISE_PURPOSE_LIMIT)) {
        throw new Error(ENTERPRISE_PURPOSE_TOO_LONG);
    }
}
