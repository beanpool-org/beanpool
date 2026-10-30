/**
 * A community's rule for where members' copies go, as this phone knows it (vault rethink VR2,
 * scratch/fable-design/DESIGN-vault-rethink-fable.md §5.3; the rule itself: utils/vault-config.ts RecoveryCopiesRule,
 * apps/server config/recovery-copies.ts).
 *
 * The phone reads it from the community's /api/community/info, kept with the rest of that answer (utils/node-profile.ts):
 * - {@link knownCopiesRule}: the kept answer, no network. Null when this phone never heard the rule from that community:
 *   no answer kept, or one an app from before the rule kept (which is not the default: it never asked).
 * - {@link copiesRuleNow}: asked of the community now, for the moment a copy is made ("honours it at the moment of
 *   connecting"), else the kept answer. Null when neither: then no copy is made (utils/sso-sheet-connect.ts), since the
 *   phone can't tell the community wants one.
 *
 * And the card (design §5.3, "Changing the rule"): when the rule differs from the one this account last saw there, Home
 * says so once ({@link copiesRuleChange}, components/CopiesRuleCard.tsx). Nothing moves by itself: the card says what the
 * change means for a copy the member already has, and where to move or remove it. The first rule the phone hears for a
 * community is only remembered: nothing changed for this member there. Compared as where a copy goes from this phone
 * (utils/vault-config.ts signInCopiesAt), so a build without a vault, where `vault` and `server` both keep copies at the
 * community, is never told of a change it can't see.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchNodeProfile, getCachedNodeProfile, nodeProfileIsFresh } from './node-profile';
import { copiesRuleSeenStoreKey } from './storage-keys';
import { signInCopiesAt, type RecoveryCopiesRule, type SignInCopies } from './vault-config';

/** How long a connect waits for the community's answer before it goes by the kept one. */
export const COPIES_RULE_TIMEOUT_MS = 8_000;

/** One spelling of a community's address, whichever this phone was given. */
function communityKey(url: string): string {
    return url.trim().replace(/\/+$/, '').toLowerCase();
}

/** The rule `url` said, as this phone kept it; null when it never heard one there. No network. Never throws. */
export async function knownCopiesRule(url: string | null | undefined): Promise<RecoveryCopiesRule | null> {
    if (!url) return null;
    try {
        return (await getCachedNodeProfile(url))?.recoveryCopies ?? null;
    } catch {
        return null;
    }
}

/**
 * The rule asked of `url` now, or, when it doesn't answer in `timeoutMs`, the one this phone kept; null when it has
 * neither. Never throws.
 */
export async function copiesRuleNow(url: string, timeoutMs: number = COPIES_RULE_TIMEOUT_MS): Promise<RecoveryCopiesRule | null> {
    try {
        const fresh = await fetchNodeProfile(url, fetch, timeoutMs);
        if (fresh?.recoveryCopies) return fresh.recoveryCopies;
    } catch {
        // As no answer: the kept one decides.
    }
    return knownCopiesRule(url);
}

/** The rule as a screen reads it: kept within the hour, else asked now (falling back to the kept one). Never throws. */
export async function copiesRuleForScreen(url: string | null | undefined): Promise<RecoveryCopiesRule | null> {
    if (!url) return null;
    try {
        const kept = await getCachedNodeProfile(url);
        if (kept?.recoveryCopies && nodeProfileIsFresh(kept)) return kept.recoveryCopies;
    } catch {
        // Asked below.
    }
    return copiesRuleNow(url);
}

/** Where a copy made from `url`'s screens goes, by its rule as a screen reads it; never heard: this build's place. */
export async function copiesAtFor(url: string | null | undefined): Promise<SignInCopies> {
    return signInCopiesAt(await copiesRuleForScreen(url));
}

// ── The "rule changed" card ─────────────────────────────────────────────────────────────────

async function seenRules(publicKey: string): Promise<Record<string, RecoveryCopiesRule>> {
    try {
        const raw = await AsyncStorage.getItem(copiesRuleSeenStoreKey(publicKey));
        const parsed = raw ? JSON.parse(raw) as unknown : {};
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, RecoveryCopiesRule> : {};
    } catch {
        return {};
    }
}

/** This account has seen `rule` at `url`: the card for it is put away, and the next change shows it again. */
export async function copiesRuleSeen(publicKey: string, url: string, rule: RecoveryCopiesRule): Promise<void> {
    try {
        const all = await seenRules(publicKey);
        all[communityKey(url)] = rule;
        await AsyncStorage.setItem(copiesRuleSeenStoreKey(publicKey), JSON.stringify(all));
    } catch {
        // Not kept: the card shows again next time, which says nothing untrue.
    }
}

/** A change this account hasn't seen: where a copy from this phone went before (`from`), and goes now (`to`). */
export interface CopiesRuleChange {
    url: string;
    rule: RecoveryCopiesRule;
    from: SignInCopies;
    to: SignInCopies;
}

/**
 * The change Home's card tells of at `url` for `publicKey`, or null. From the community's answer this phone kept, never
 * asked here: Home makes one request for the whole screen, and the tab strip asks the community afresh as the app starts
 * (components/CopiesRuleCard.tsx looks again when that answer is kept). The first rule heard there is remembered without
 * a card, and a change that doesn't move where this phone's copies go is remembered without one too. Never throws.
 */
export async function copiesRuleChange(publicKey: string, url: string | null | undefined): Promise<CopiesRuleChange | null> {
    if (!url) return null;
    const rule = await knownCopiesRule(url);
    if (!rule) return null;
    const seen = (await seenRules(publicKey))[communityKey(url)];
    if (!seen) {
        await copiesRuleSeen(publicKey, url, rule);
        return null;
    }
    if (seen === rule) return null;
    const from = signInCopiesAt(seen);
    const to = signInCopiesAt(rule);
    if (from === to) {
        await copiesRuleSeen(publicKey, url, rule);
        return null;
    }
    return { url, rule, from, to };
}
