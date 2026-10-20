/**
 * Community identification for tools on the phone (DESIGN-tool-template-fable.md §1.6, PR #2267 findings 2 + 3).
 *
 * Photos, reminders and documents are all keyed per community, owner and tool. The community key is a filesystem-safe
 * and notification-safe string derived from the community's plain origin (or 'local' when unanchored), matching how
 * each community has its own SQLite file.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { plainOriginOf } from '../utils/node-url';

/** A filesystem-safe, identifier-safe tag for `url`'s community. */
export function communityKey(url: string | null | undefined): string {
    if (!url) return 'local';
    const origin = plainOriginOf(url);
    const host = origin ? origin.replace(/^[a-z]+:\/\//, '').replace(/:\d+$/, '') : 'unplain';
    const readable = host.replace(/[^a-z0-9.-]/g, '_').slice(0, 32);
    const hash = bytesToHex(sha256(utf8ToBytes(origin ?? `unplain:${url}`))).slice(0, 16);
    return `${readable}_${hash}`;
}
