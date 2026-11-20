/**
 * The community's welcome for new members (scratch/fable-design/DESIGN-onboarding-home-landing-fable.md §4.5, slice S6): a
 * few lines in the owners' own words, which members read on Home under BeanPool's welcome. The rule on what it may hold is
 * core's (community-welcome.ts): plain text, at most 280 characters and three line breaks, never machine-translated.
 *
 * - Written by an owner only, in Settings (routes/settings.ts POST /api/local/admin/community-welcome, the manager's
 *   "Welcome for new members"). An admin reads it there; neither an admin nor an automation token changes it.
 * - Read by members only: the signed Home read (routes/home-answer.ts, `cards.community.welcome`). Never on the public
 *   community card (routes/community-card.ts), /api/community/info, the directory or the global community: an owner's
 *   words might name people, and the card names no one.
 * - A node_config row (`community_welcome`), one of the community's own settings (config/community-settings.ts): a standby
 *   keeps the main server's, and a take-over installs it. The default, no welcome, is no row, so only an owner's words
 *   are stored.
 */
import { cleanCommunityWelcome, isKeptCommunityWelcome, wordsFor, COMMUNITY_WELCOME_WORDS, type CommunityWelcomeProblem } from '@beanpool/core';
import { db } from '../db/db.js';

export const COMMUNITY_WELCOME_KEY = 'community_welcome';

/** The welcome a `community_welcome` row's value holds: the text when it is one as kept, else none. */
export function communityWelcomeFromRow(value: string | null | undefined): string | null {
    return isKeptCommunityWelcome(value) ? value : null;
}

/** This community's welcome for new members, or null where its owners have written none. */
export function readCommunityWelcome(): string | null {
    const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(COMMUNITY_WELCOME_KEY) as { value: string | null } | undefined;
    return communityWelcomeFromRow(row?.value);
}

/**
 * What the owner is told when a welcome can't be kept: core's words (COMMUNITY_WELCOME_WORDS), the same sentence Settings shows
 * beside the count before Save is pressed. In English, as operators' Settings is for launch.
 */
const { t } = wordsFor('en');
export function communityWelcomeRefusal(problem: CommunityWelcomeProblem): string {
    return t(COMMUNITY_WELCOME_WORDS[problem]);
}

export type SetCommunityWelcome = { ok: true; welcome: string | null } | { ok: false; problem: CommunityWelcomeProblem; error: string };

/** Keep the welcome as core cleans it; an empty one removes the row. Nothing is stored for a welcome that is refused. */
export function setCommunityWelcome(raw: unknown): SetCommunityWelcome {
    const clean = cleanCommunityWelcome(raw);
    if (!clean.ok) return { ok: false, problem: clean.problem, error: communityWelcomeRefusal(clean.problem) };
    if (clean.text === '') db.prepare('DELETE FROM node_config WHERE key = ?').run(COMMUNITY_WELCOME_KEY);
    else db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(COMMUNITY_WELCOME_KEY, clean.text);
    return { ok: true, welcome: clean.text || null };
}
