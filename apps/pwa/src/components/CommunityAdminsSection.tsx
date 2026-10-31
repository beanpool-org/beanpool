/**
 * Settings → "Your community's admins" (vault rethink VR3, community-held placement; DESIGN-vault-rethink-fable.md §4.3,
 * §4.5): the web app can turn it on, as the phone can. Shown where the server says it offers it (its status answer's
 * `offered`: its rule is "this server" and anyone can't walk in; the page's reading of the rule only until it answers,
 * or when it couldn't be asked), or wherever this server already keeps this member's copy (a rule moved since: the copy
 * is the member's until they remove it). On is said only on the server's own answer that it keeps the copy and can open
 * it; one it keeps but can't open (the key it locks copies with gone, or another in its place) is said as that, with what
 * can be done, never On. SettingsPage asks, and shares the answer with "Where your account can be brought back from" (it
 * lists and removes the copy too), so the two always say the same. The flow is lib/community-copy.ts.
 *
 * The shared placement (vault rethink VR4) is the phone's: half at this community's server, half at BeanPool's key vault, which
 * the web app can't reach yet (design VR6). So under the default rule the web offers nothing here, as before, and a copy a
 * phone made is said as that, with no button: Remove here would leave the vault's half behind.
 */
import { useState } from 'react';
import { formatDate, t, word } from '@beanpool/core';
import type { BeanPoolIdentity } from '../lib/identity';
import {
    webRemoveCommunityCopy, webTurnOnCommunityCopy, WEB_COMMUNITY_COPY_TEXT, type WebCommunityCopyStatus,
} from '../lib/community-copy';

export const COMMUNITY_ADMINS_WEB = {
    title: word("👥 Your community's admins"),
    body: word("Go and see an admin in person and they can bring your account back: the same key, Beans and all. No Google or Apple needed. Your community's server keeps the locked copy. The people who run it can open it; nobody else."),
    turnOn: word('Turn on'),
    on: word('On since {date}.'),
    remove: word('Remove'),
    removeAsk: word("Remove this way back? This community's server deletes its copy of your account. Your admins can no longer bring you back; your 12 words still work."),
    noLongerOffered: word('This community no longer offers this to new members. Your copy here still works until you remove it.'),
    turnedOn: word('On. If you lose this device, go and see one of your admins with your new phone or browser.'),
    // A copy this server keeps but can't open now (its status answer's `unopenable`): never On.
    cantOpen: word("Kept since {date}, but this community's server can't open it now, so your admins can't bring you back with it."),
    cantOpenKeyMissing: word('The server is missing the key it locks these copies with. The people who run it can put that key back. Until then, your 12 words still work.'),
    cantOpenTurnOnAgain: word('It was locked with a key the server no longer has. Turn it on again to make a copy it can open.'),
    cantOpenNotOffered: word('It was locked with a key the server no longer has, and this community no longer makes new copies. You can remove it; your 12 words still work.'),
    // A shared copy, made on a phone (VR4).
    sharedOnPhone: word("On since {date}, from your phone. This community's server and BeanPool's key vault each keep half of a locked copy. Manage it in the phone app."),
    turnOnAgain: word('Turn on again'),
    removeCopyAsk: word("Remove this copy? This community's server deletes the copy it can't open. Your 12 words still work."),
} as const;

/** The sentences lib/community-copy.ts throws, said in the reader's language; anything else (the server's) as given. */
function said(message: string): string {
    if (message === WEB_COMMUNITY_COPY_TEXT.unreachable) return t('Couldn’t reach your community, so nothing changed. Try again in a moment.');
    if (message === WEB_COMMUNITY_COPY_TEXT.notKept) return t('Your community didn’t keep the copy, so this isn’t on yet. Try again.');
    if (message === WEB_COMMUNITY_COPY_TEXT.noKey) return t('This browser can’t read its own key, so no copy was made.');
    return message;
}

interface Props {
    identity: BeanPoolIdentity | null;
    /**
     * The page's reading of the rule: the community keeps copies itself (`recoveryCopies: 'server'`) and is not the global
     * community. Used only until the server answers, or when it couldn't be asked: its answer's `offered` decides.
     */
    offeredHere: boolean;
    /** The server's answer about this member's copy (SettingsPage asks): undefined while asking, null when it couldn't be asked. */
    status: WebCommunityCopyStatus | null | undefined;
    /** After a turn-on or a removal: the page asks the server again, and the answer comes back as `status`. */
    onChanged: () => Promise<unknown>;
}

export function CommunityAdminsSection({ identity, offeredHere, status, onChanged }: Props) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [justOn, setJustOn] = useState(false);

    if (!identity) return null;
    const kept = status?.kept === true;
    const unopenable = kept ? null : status?.unopenable ?? null;
    // The server's own word on whether it offers this (a door anyone can walk through is refused there, whatever the rule).
    const offered = status ? status.offered : offeredHere;
    if (!offered && !kept && !unopenable) return null;
    // Turning it on again makes a copy the server can open, where it has its key and offers it; with its key gone, it
    // can't keep one (the server refuses), so only Remove is offered.
    const canTurnOn = offered && !kept && unopenable?.reason !== 'recovery_seal_key_missing';
    const dayOf = (iso: string | null | undefined): string => {
        const d = iso ? new Date(iso) : null;
        return d && Number.isFinite(d.getTime()) ? formatDate(d, 'day-month-year') : '…';
    };
    if (status?.shared) {
        return (
            <div className="w-full p-4 rounded-2xl bg-white dark:bg-nature-900 text-nature-900 dark:text-white border border-nature-200 dark:border-nature-800 shadow-sm space-y-2 break-words" data-testid="community-admins-section">
                <div className="text-[15px] font-bold">{t(COMMUNITY_ADMINS_WEB.title)}</div>
                <p className="text-sm m-0" data-testid="community-admins-shared">{t(COMMUNITY_ADMINS_WEB.sharedOnPhone, { date: dayOf(status.since) })}</p>
            </div>
        );
    }

    const turnOn = async () => {
        setBusy(true);
        setError(null);
        setJustOn(false);
        try {
            await webTurnOnCommunityCopy(identity);
            await onChanged();
            setJustOn(true);
        } catch (e) {
            setError(said(e instanceof Error ? e.message : String(e)));
        } finally {
            setBusy(false);
        }
    };
    const remove = async () => {
        // A copy the server can't open is no way back now: removing it takes none away, and the ask says so.
        if (!window.confirm(unopenable ? t(COMMUNITY_ADMINS_WEB.removeCopyAsk) : t(COMMUNITY_ADMINS_WEB.removeAsk))) return;
        setBusy(true);
        setError(null);
        setJustOn(false);
        try {
            await webRemoveCommunityCopy();
            await onChanged();
        } catch (e) {
            setError(said(e instanceof Error ? e.message : String(e)));
        } finally {
            setBusy(false);
        }
    };

    return (
        // The card the Ways back section above draws in (WaysBackSection CARD): white under its words, as their 4.5:1 needs
        // (on the page's own cream, nature-600 is 4.27:1: e2e/signin-recovery-check.mjs measured it).
        <div className="w-full p-4 rounded-2xl bg-white dark:bg-nature-900 text-nature-900 dark:text-white border border-nature-200 dark:border-nature-800 shadow-sm space-y-2 break-words" data-testid="community-admins-section">
            <div className="text-[15px] font-bold">{t(COMMUNITY_ADMINS_WEB.title)}</div>
            {/* nature-600 on white is 4.9:1 (WaysBackSection measured the pair); 500 is under 4.5:1. */}
            <p className="text-xs text-nature-600 dark:text-nature-300 leading-relaxed m-0">{t(COMMUNITY_ADMINS_WEB.body)}</p>
            {kept && (
                <p className="text-sm font-semibold m-0" data-testid="community-admins-on">
                    {t(COMMUNITY_ADMINS_WEB.on, { date: dayOf(status?.since) })}
                </p>
            )}
            {/* The warn chip's tint and ink (core brand colours): a pair held at 4.5:1 in light and in dark. */}
            {unopenable && (
                <div className="p-3 rounded-xl bg-bp-chip-warn-tint text-bp-chip-warn-ink space-y-1" data-testid="community-admins-cant-open">
                    <p className="text-sm font-semibold m-0">{t(COMMUNITY_ADMINS_WEB.cantOpen, { date: dayOf(unopenable.since) })}</p>
                    <p className="text-xs m-0">
                        {unopenable.reason === 'recovery_seal_key_missing'
                            ? t(COMMUNITY_ADMINS_WEB.cantOpenKeyMissing)
                            : offered
                                ? t(COMMUNITY_ADMINS_WEB.cantOpenTurnOnAgain)
                                : t(COMMUNITY_ADMINS_WEB.cantOpenNotOffered)}
                    </p>
                </div>
            )}
            {kept && !offered && <p className="text-xs text-nature-600 dark:text-nature-300 m-0">{t(COMMUNITY_ADMINS_WEB.noLongerOffered)}</p>}
            {justOn && kept && <p role="status" className="text-xs m-0">{t(COMMUNITY_ADMINS_WEB.turnedOn)}</p>}
            {error && <p role="alert" className="text-xs text-red-600 dark:text-red-300 m-0">{error}</p>}
            <div className="flex flex-wrap gap-2">
                {canTurnOn && (
                    <button type="button" disabled={busy} onClick={turnOn} className="min-h-[44px] px-4 py-2 rounded-xl bg-bp-commit-fill text-bp-commit-on text-sm font-semibold disabled:opacity-50" data-testid="community-admins-turn-on">
                        {unopenable ? t(COMMUNITY_ADMINS_WEB.turnOnAgain) : t(COMMUNITY_ADMINS_WEB.turnOn)}
                    </button>
                )}
                {(kept || unopenable) && (
                    <button type="button" disabled={busy} onClick={remove} className="min-h-[44px] px-4 py-2 rounded-xl border border-nature-300 dark:border-nature-600 text-sm font-semibold disabled:opacity-50" data-testid="community-admins-remove">
                        {t(COMMUNITY_ADMINS_WEB.remove)}
                    </button>
                )}
            </div>
        </div>
    );
}
