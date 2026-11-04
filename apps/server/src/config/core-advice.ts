/**
 * Advise the owners (scratch/fable-design/DESIGN-core-settings-fable.md §5, §8.5, §8.6; slice C4). An admin reads every Core
 * setting but changes none; this is their voice: up to 200 characters about one Core setting, kept as a line in the Changes
 * log and told to the owners through the alert channel they already watch (`sec.settings`). POST
 * /api/local/admin/community-shape/advice (routes/settings.ts) calls adviseTheOwners.
 *
 * What it does, and all it does: one `community_settings_log` line (`advice.<setting>`, the advice as its `note`, the
 * adviser's role as `actor_role`) and one owner alert. It changes no setting, writes no row of the lock, tells no member
 * and asks for no proof: nothing is being changed. An owner may advise too (a note for the other owners); a moderator, a
 * member and an automation token may not (the route).
 *
 * The advice is a member's words, so it is DATA, never an instruction: it is cleaned once here (control and bidi
 * characters dropped, runs of whitespace one space: config/clean-label.ts) and kept as text. Nothing reads it back to act on
 * it. The page draws it as text; the alert does NOT carry it (nor who wrote it): the alert channel's contract is "this
 * message names no member" and it can leave the server (a webhook, ntfy), so the alert says that advice came, about which
 * setting, and where to read it. Settings' log is where the owners read the words.
 *
 * Bounded: an adviser may leave ADVICE_PER_DAY lines in 24 hours. The Changes log shows its last 50 lines (community-shape.ts
 * LOG_LINES), and the alert channel folds an actor's pushes after a few an hour; without a bound, one key could push every
 * real change out of the page's log.
 */
import { db } from '../db/db.js';
import { getNodeRole } from './node-role.js';
import { readShape, type Shape } from './community-shape.js';
import { ShapeChangeError, SHAPE_STANDBY, SETTING_NAMES, type ShapeActor, type ShapeSettingName } from './community-shape-write.js';
import { isCoreSettingName, CORE_SETTINGS } from './core-settings.js';
import { cleanLabel } from './clean-label.js';
import { noteSecurityEvent, OWNER_ALERT_WORDS } from '../services/security-signal.js';

/** The longest advice, in characters (design §5). */
export const ADVICE_MAX = 200;
/** How many lines one adviser may leave in 24 hours. */
export const ADVICE_PER_DAY = 10;
/** The log's `setting` for advice about `setting`. */
export const ADVICE_PREFIX = 'advice.';

const DAY_MS = 86_400_000;

/** Who may advise, in words, for the route's 403. */
export const ADVICE_ROLE_ONLY = 'Only an owner or admin of this community can advise the owners';
export const ADVICE_TOKEN_REFUSED = 'An automation token never advises the owners: sign in to Settings as an owner or admin';

const bad = (code: string, message: string, setting?: string): never => {
    throw new ShapeChangeError(400, code, message, setting);
};

/** The advice, one clean line, or a 400: text, something left after cleaning, at most ADVICE_MAX characters. */
export function adviceOf(v: unknown): string {
    if (typeof v !== 'string') return bad('bad_advice', 'advice must be a sentence.');
    // A very long string is refused before it is cleaned: the page never sends more than ADVICE_MAX.
    if (v.length > ADVICE_MAX * 8) return bad('bad_advice', `The advice is at most ${ADVICE_MAX} characters.`);
    const cleaned = cleanLabel(v, ADVICE_MAX * 8);
    if (!cleaned) return bad('bad_advice', 'Write what you want the owners to know.');
    if ([...cleaned].length > ADVICE_MAX) return bad('bad_advice', `The advice is at most ${ADVICE_MAX} characters.`);
    return cleaned;
}

/**
 * An admin's (or an owner's) advice about one Core setting, written as one log line and one owner alert. Throws
 * ShapeChangeError (400, 409, 429) with nothing written. `body`: `{ setting, advice }`. `role` is what the line is kept
 * under; `by` is who acted, for the alert's per-actor bound. Answers the shape as it now is, its log with the new line.
 */
export function adviseTheOwners(by: ShapeActor, role: 'owner' | 'admin', body: unknown): { shape: Shape } {
    if (getNodeRole() !== 'primary') throw new ShapeChangeError(409, 'standby', SHAPE_STANDBY);
    const { setting, advice: rawAdvice } = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as { setting?: unknown; advice?: unknown };
    if (typeof setting !== 'string' || !setting) {
        return bad('bad_setting', `Say which core setting: ${CORE_SETTINGS.join(', ')}.`);
    }
    if (!isCoreSettingName(setting)) {
        // Its own names only: `in` would read Object.prototype too (a setting called `constructor`).
        const everyday = Object.prototype.hasOwnProperty.call(SETTING_NAMES, setting);
        return bad(everyday ? 'not_core' : 'bad_setting', everyday
            ? `${SETTING_NAMES[setting as ShapeSettingName]} is an everyday rule, not a core setting: advice is for the core settings (${CORE_SETTINGS.join(', ')}).`
            : `${setting.slice(0, 40)} is not a core setting (${CORE_SETTINGS.join(', ')}).`, everyday ? setting : undefined);
    }
    const advice = adviceOf(rawAdvice);
    // The 12-words door belongs to the open-door kind only: no owner there can be advised about a setting that isn't.
    if (setting === 'wordsDoor' && !readShape().settings.wordsDoor) {
        return bad('not_changeable', '12 words at the door are only for a community whose door is open (the global kind).', setting);
    }
    const at = new Date().toISOString();
    const sent = (db.prepare(`SELECT COUNT(*) AS n FROM community_settings_log WHERE actor_pubkey = ? AND substr(setting, 1, ?) = ? AND at > ?`)
        .get(by.actor, ADVICE_PREFIX.length, ADVICE_PREFIX, new Date(Date.now() - DAY_MS).toISOString()) as { n: number }).n;
    if (sent >= ADVICE_PER_DAY) {
        throw new ShapeChangeError(429, 'advice_limit',
            `That is ${ADVICE_PER_DAY} pieces of advice in a day. Send the next one tomorrow, or tell the owners another way. Nothing was saved.`, setting);
    }
    db.prepare(`INSERT INTO community_settings_log (actor_pubkey, actor_role, setting, old_value, new_value, note, at)
                VALUES (?, ?, ?, NULL, NULL, ?, ?)`).run(by.actor, role, `${ADVICE_PREFIX}${setting}`, advice, at);
    console.log(`💬 Core settings: ${role} ${by.actor.slice(0, 8)} advised the owners about ${setting}.`);
    noteSecurityEvent({
        key: 'sec.settings',
        detail: OWNER_ALERT_WORDS.coreAdvice(role, SETTING_NAMES[setting]),
        actor: by.actor,
        actorRole: by.actorRole,
    });
    return { shape: readShape() };
}
