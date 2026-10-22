/**
 * An enterprise's shopfront on the server (slice E2 of scratch/tools/DESIGN-shops-round3-enterprise-shopfront-fable.md §4,
 * §5; Marty's answers of 23 Oct 2026): its page is its shop's front window, so its face is its keepers' to dress, and its
 * page says who keeps it with what a member's own profile already shows.
 *
 * - The face (changeEnterpriseFace, PUT /api/treasury/:t/profile in routes/treasury.ts): its name and its purpose, the
 *   lead's (or a node admin's); its About (members.bio) and its logo (its avatar, the picture it was made with), any
 *   keeper's. About is theirs alone: a crowdfund's and a Commons proposal's own create and edit (db.ts
 *   createCrowdfundProject, updateCrowdfundProject; state-engine.ts createProject, updateProject) write the name and
 *   the purpose, never About. The banner is its shop's one photo (round 3 §0 row 4),
 *   not here. Every column it writes is in the members row a standby copies whole (members_touch_updated_at lists each,
 *   and the photo travels in the row: engine/replication-manifest.ts), and its shop's name is read from that row
 *   (engine/shops.ts), so the shop follows a rename on every copy.
 * - The shopfront's data (shopfrontOf, on GET /api/treasury/:t): each keeper's tier, stars, trades and the categories of
 *   their own live Offers for everyone here, and the enterprise's categories, the union with its own. To a member of this
 *   node only (passesReadGate, the listings' gate), whatever ENFORCE_READ_AUTH says: a visitor sees the keepers' names and
 *   roles (§5). A category is one of the listings the reader may list with `author=`, never more (getPosts as that
 *   reader), and only of a listing for everyone here, never one for a group or one person.
 *
 * The refusals are sentences with a code, each marked with word('…') so the server's catalog (apps/server/words) holds it;
 * a node writes them in English (core words.test N11), and the apps show the sentence.
 */
import {
    ENTERPRISE_ABOUT_LIMIT, ENTERPRISE_NAME_LIMIT, ENTERPRISE_PURPOSE_LIMIT, fitsTextLimit, replaceLoneSurrogates, textTooLongMessage,
    tierForCredit, word, type TierName,
} from '@beanpool/core';
import { getAverageRating, getMemberTrustProfile, getPosts, passesReadGate, setMemberPhoto } from '@beanpool/engine';
import { db } from '../db/db.js';
import { isCallsignAvailable } from './members.js';
import { AVATAR_FORMAT_ERROR, isSelfPhotoPath, photoRefusalText, routePhotoValueRefusal } from './avatar.js';
import { assertMayStorePhotoBytes, incomingPhotoBytes, recordStoredPhotoBytes } from './photo-upload-budget.js';
import { stripImageValue } from '../storage/image-metadata.js';
import { ENTERPRISE_NAME_TOO_LONG, ENTERPRISE_PURPOSE_TOO_LONG } from './enterprise-text.js';

/** A refusal meant for the keeper, in a sentence, with its status and code. */
export class EnterpriseFaceRefusal extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
        super(message);
        this.name = 'EnterpriseFaceRefusal';
    }
}

export const FACE_LEAD_ONLY = word("Only the lead keeper can change the enterprise's name or what it is for.");
export const FACE_NAME_TOO_SHORT = word("An enterprise's name needs at least 2 characters.");
export const FACE_NAME_TAKEN = word('That name is already taken here. Pick another.');
export const FACE_PURPOSE_REQUIRED = word('Say in a line what the enterprise is for.');
export const FACE_ABOUT_TOO_LONG = textTooLongMessage("An enterprise's About", ENTERPRISE_ABOUT_LIMIT);
export const FACE_LOGO_REQUIRED = word('An enterprise keeps a picture. Send a new one to change it.');
export const FACE_NOTHING = word('Send a new name, purpose, About or picture to change.');
export const FACE_NOT_TEXT = word('The name, what it is for and About must each be text.');

/** What a PUT may change. Every field is optional; at least one must be sent. */
export interface FaceChanges {
    name?: unknown;
    purpose?: unknown;
    about?: unknown;
    avatar?: unknown;
}

/** The face as the route answers it. */
export interface EnterpriseFace {
    publicKey: string;
    name: string;
    purpose: string | null;
    about: string | null;
    profileUpdatedAt: string | null;
}

interface FaceRow { callsign: string; purpose: string | null; bio: string | null; profile_updated_at: string | null; photo: string | null }

const faceRowOf = (treasury: string) => db.prepare(`SELECT m.callsign, m.purpose, m.bio, m.profile_updated_at, mp.photo
    FROM members m LEFT JOIN member_photos mp ON mp.public_key = m.public_key WHERE m.public_key = ? AND m.is_treasury = 1`).get(treasury) as FaceRow | undefined;

/** Text as it would be stored: trimmed, lone surrogates replaced. Refused when it is not text. */
function textOf(raw: unknown): string {
    if (typeof raw !== 'string') throw new EnterpriseFaceRefusal(400, 'not_text', FACE_NOT_TEXT);
    return replaceLoneSurrogates(raw).trim();
}

/**
 * Changes what the PUT names of an enterprise's face, all of it or nothing, for `actor`, a keeper of it or a node admin
 * (the route has asked). `lead`: the actor is its lead keeper, its sole keeper or a node admin (isLeadOrSoleKeeperOrAdmin),
 * who alone may change its name or purpose. A field sent back as it is changes nothing and needs no say: a form that sends
 * every field is no rename. Refused, before anything is written, in this order: nothing named (400 nothing_to_change); a
 * field that is not text (400 not_text); a new name or purpose from a keeper who doesn't lead (403 lead_only), so only the
 * lead hears whether a name is taken; a name under 2 characters (400 name_too_short) or over its limit (400 text_too_long),
 * or another account's by the one name rule (409 name_taken: isCallsignAvailable, a member's or an enterprise's); an empty
 * purpose (400 purpose_required) or one over its limit; About over 600 characters; a logo that is none (400 logo_required:
 * an enterprise keeps its picture) or no picture the node stores (400 photo_refused, the photo rule's own words, #2082);
 * a logo past the sender's day of photos (the budget's 429, charged to the keeper who sends it). Its own photo address sent
 * back is no new picture. Returns the face, and whether anything was written; a write stamps profile_updated_at, and a
 * new name renames its chat with it.
 */
export function changeEnterpriseFace(treasury: string, actor: string, changes: FaceChanges, opts: { lead: boolean }, now: number = Date.now()): { face: EnterpriseFace; changed: boolean } {
    const row = faceRowOf(treasury);
    if (!row) throw new EnterpriseFaceRefusal(404, 'not_an_enterprise', 'Not a treasury');
    const { name: rawName, purpose: rawPurpose, about: rawAbout, avatar: rawAvatar } = changes;
    if (rawName === undefined && rawPurpose === undefined && rawAbout === undefined && rawAvatar === undefined) {
        throw new EnterpriseFaceRefusal(400, 'nothing_to_change', FACE_NOTHING);
    }

    const name = rawName === undefined ? undefined : textOf(rawName);
    const purpose = rawPurpose === undefined ? undefined : textOf(rawPurpose);
    const about = rawAbout === undefined ? undefined : rawAbout === null ? '' : textOf(rawAbout);
    const newName = name !== undefined && name !== row.callsign ? name : undefined;
    const newPurpose = purpose !== undefined && purpose !== (row.purpose ?? '') ? purpose : undefined;
    const newAbout = about !== undefined && about !== (row.bio ?? '') ? about : undefined;

    if ((newName !== undefined || newPurpose !== undefined) && !opts.lead) throw new EnterpriseFaceRefusal(403, 'lead_only', FACE_LEAD_ONLY);
    if (newName !== undefined) {
        if (newName.length < 2) throw new EnterpriseFaceRefusal(400, 'name_too_short', FACE_NAME_TOO_SHORT);
        if (!fitsTextLimit(newName, ENTERPRISE_NAME_LIMIT)) throw new EnterpriseFaceRefusal(400, 'text_too_long', ENTERPRISE_NAME_TOO_LONG);
        if (!isCallsignAvailable(newName, treasury)) throw new EnterpriseFaceRefusal(409, 'name_taken', FACE_NAME_TAKEN);
    }
    if (newPurpose !== undefined) {
        if (newPurpose === '') throw new EnterpriseFaceRefusal(400, 'purpose_required', FACE_PURPOSE_REQUIRED);
        if (!fitsTextLimit(newPurpose, ENTERPRISE_PURPOSE_LIMIT)) throw new EnterpriseFaceRefusal(400, 'text_too_long', ENTERPRISE_PURPOSE_TOO_LONG);
    }
    if (newAbout !== undefined && !fitsTextLimit(newAbout, ENTERPRISE_ABOUT_LIMIT)) throw new EnterpriseFaceRefusal(400, 'text_too_long', FACE_ABOUT_TOO_LONG);

    // The logo: a new picture, or its own address sent back, which is the picture it has.
    let photo: string | undefined;
    let incomingBytes = 0;
    if (rawAvatar !== undefined) {
        if (rawAvatar === null || rawAvatar === '') throw new EnterpriseFaceRefusal(400, 'logo_required', FACE_LOGO_REQUIRED);
        if (!(typeof rawAvatar === 'string' && isSelfPhotoPath(rawAvatar))) {
            const refusal = routePhotoValueRefusal(rawAvatar);
            if (refusal) throw new EnterpriseFaceRefusal(400, 'photo_refused', photoRefusalText(refusal, AVATAR_FORMAT_ERROR));
            const stripped = stripImageValue(rawAvatar as string);
            if (stripped !== row.photo) {
                photo = stripped;
                incomingBytes = incomingPhotoBytes(rawAvatar);
                if (incomingBytes > 0) assertMayStorePhotoBytes(actor, incomingBytes, now);
            }
        }
    }

    const changed = newName !== undefined || newPurpose !== undefined || newAbout !== undefined || photo !== undefined;
    if (changed) {
        const stamp = new Date(now).toISOString();
        db.transaction(() => {
            db.prepare('UPDATE members SET callsign = ?, purpose = ?, bio = ?, profile_updated_at = ? WHERE public_key = ? AND is_treasury = 1').run(
                newName ?? row.callsign,
                newPurpose ?? row.purpose,
                newAbout === undefined ? row.bio : (newAbout === '' ? null : newAbout),
                stamp,
                treasury,
            );
            // Its chat is titled by its name (engine/enterprise-thread.ts ensureEnterpriseThread): a rename carries over, as
            // a group's does (state-engine.ts updateGroup), and reaches a standby the same way (replication-manifest.ts).
            if (newName !== undefined) db.prepare("UPDATE conversations SET name = ? WHERE id = ? AND type = 'enterprise_thread'").run(newName, treasury);
            // The photo, with its reference in the row, by its one writer.
            if (photo !== undefined) setMemberPhoto(db, treasury, photo);
        })();
        if (incomingBytes > 0) recordStoredPhotoBytes(actor, incomingBytes, now);
    }
    const after = faceRowOf(treasury)!;
    return {
        face: { publicKey: treasury, name: after.callsign, purpose: after.purpose, about: after.bio, profileUpdatedAt: after.profile_updated_at },
        changed,
    };
}

// ── The shopfront's data ─────────────────────────────────────────────────────────────────────────

/** What the page shows of a keeper beside their name and role (round 3 §0 row 6): recognition, which gates nothing. */
export interface KeeperBadges {
    tier: TierName;
    rating: { average: number; count: number };
    trades: number;
    /** The categories of their own live Offers for everyone here, once each, in order. */
    offerCategories: string[];
}

/**
 * The categories of `author`'s live Offers for everyone here, as `reader` may list them (getPosts with `author=`, the
 * public ones only): on the board, out on loan or in a deal; never a paused one, even to its author.
 */
function liveOfferCategories(author: string, reader: string): string[] {
    const posts = getPosts(db, { authorPubkey: author, type: 'offer', excludeEvents: true, audienceScope: 'public', viewerPubkey: reader, guest: true });
    const live = posts.filter(p => p.type === 'offer' && (p.status === 'active' || p.status === 'pending'));
    return [...new Set(live.map(p => p.category).filter((c): c is string => typeof c === 'string' && c !== ''))].sort();
}

/**
 * The shopfront's data for `reader`: the keepers as given, each with their KeeperBadges, and the enterprise's
 * `offerCategories` (its keepers' and its own); or, to anyone but a member of this node (passesReadGate: no key, a key
 * that is no member, a visitor's row), the keepers as given and nothing else.
 */
export function shopfrontOf<K extends { publicKey: string }>(treasury: string, keepers: K[], reader: string | undefined): { keepers: Array<K & Partial<KeeperBadges>>; offerCategories?: string[] } {
    if (!reader || !passesReadGate(db, reader)) return { keepers };
    const rows = keepers.map(k => {
        const profile = getMemberTrustProfile(db, k.publicKey);
        const rating = getAverageRating(db, k.publicKey);
        return {
            ...k,
            tier: tierForCredit(profile.tierCredit).name,
            rating: { average: rating.average, count: rating.count },
            trades: profile.stats.tradeCount,
            offerCategories: liveOfferCategories(k.publicKey, reader),
        };
    });
    const offerCategories = [...new Set([...rows.flatMap(k => k.offerCategories), ...liveOfferCategories(treasury, reader)])].sort();
    return { keepers: rows, offerCategories };
}
