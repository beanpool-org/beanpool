/**
 * Settings → "Your community's admins" (vault rethink VR3, community-held placement; DESIGN-vault-rethink-fable.md §4.3,
 * §4.5): the web app can turn it on, as the phone can. Shown where the community keeps copies itself and this is not
 * the global community (`offered`), or wherever this server already keeps this member's copy (a rule moved since: the
 * copy is the member's until they remove it). On is said only on the server's own answer. The flow is
 * lib/community-copy.ts.
 */
import { useEffect, useState } from 'react';
import { t, word } from '@beanpool/core';
import type { BeanPoolIdentity } from '../lib/identity';
import {
    webCommunityCopyStatus, webRemoveCommunityCopy, webTurnOnCommunityCopy, WEB_COMMUNITY_COPY_TEXT, type WebCommunityCopyStatus,
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
    /** The community keeps copies itself (`recoveryCopies: 'server'`) and is not the global community. */
    offeredHere: boolean;
}

export function CommunityAdminsSection({ identity, offeredHere }: Props) {
    const [status, setStatus] = useState<WebCommunityCopyStatus | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [justOn, setJustOn] = useState(false);

    useEffect(() => {
        let live = true;
        if (identity) webCommunityCopyStatus().then((s) => { if (live) setStatus(s); });
        return () => { live = false; };
    }, [identity]);

    if (!identity) return null;
    const kept = status?.kept === true;
    if (!offeredHere && !kept) return null;

    const turnOn = async () => {
        setBusy(true);
        setError(null);
        setJustOn(false);
        try {
            await webTurnOnCommunityCopy(identity);
            setStatus(await webCommunityCopyStatus());
            setJustOn(true);
        } catch (e) {
            setError(said(e instanceof Error ? e.message : String(e)));
        } finally {
            setBusy(false);
        }
    };
    const remove = async () => {
        if (!window.confirm(t(COMMUNITY_ADMINS_WEB.removeAsk))) return;
        setBusy(true);
        setError(null);
        setJustOn(false);
        try {
            await webRemoveCommunityCopy();
            setStatus(await webCommunityCopyStatus());
        } catch (e) {
            setError(said(e instanceof Error ? e.message : String(e)));
        } finally {
            setBusy(false);
        }
    };

    const since = status?.since ? new Date(status.since) : null;
    return (
        <div className="rounded-2xl border border-nature-200 dark:border-nature-700 p-4 space-y-2" data-testid="community-admins-section">
            <div className="text-[15px] font-bold">{t(COMMUNITY_ADMINS_WEB.title)}</div>
            <p className="text-xs text-nature-500 dark:text-nature-300 leading-relaxed m-0">{t(COMMUNITY_ADMINS_WEB.body)}</p>
            {kept && (
                <p className="text-sm font-semibold m-0" data-testid="community-admins-on">
                    {t(COMMUNITY_ADMINS_WEB.on, { date: since && Number.isFinite(since.getTime()) ? since.toLocaleDateString() : '…' })}
                </p>
            )}
            {kept && !offeredHere && <p className="text-xs text-nature-500 dark:text-nature-300 m-0">{t(COMMUNITY_ADMINS_WEB.noLongerOffered)}</p>}
            {justOn && kept && <p role="status" className="text-xs m-0">{t(COMMUNITY_ADMINS_WEB.turnedOn)}</p>}
            {error && <p role="alert" className="text-xs text-red-600 dark:text-red-400 m-0">{error}</p>}
            {kept ? (
                <button type="button" disabled={busy} onClick={remove} className="px-4 py-2 rounded-xl border border-nature-300 dark:border-nature-600 text-sm font-semibold disabled:opacity-50" data-testid="community-admins-remove">
                    {t(COMMUNITY_ADMINS_WEB.remove)}
                </button>
            ) : (
                <button type="button" disabled={busy} onClick={turnOn} className="px-4 py-2 rounded-xl bg-bp-commit-fill text-bp-commit-on text-sm font-semibold disabled:opacity-50" data-testid="community-admins-turn-on">
                    {t(COMMUNITY_ADMINS_WEB.turnOn)}
                </button>
            )}
        </div>
    );
}
