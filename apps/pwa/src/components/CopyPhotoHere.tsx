/**
 * Settings → "Use the photo from <community> here?" (Profile S4, scratch/fable-design/DESIGN-per-community-profile-fable.md §4;
 * Marty, 28-29 Oct 2026): copy on request, on the web.
 *
 * A browser talks to ONE community, so it cannot read another's name or photo and cannot copy OUT to one. The only direction a
 * copy can go here is INTO the community it is on, from the one picture this browser kept from another (lib/last-photo.ts), and
 * only the picture: this browser holds no other community's name, and the bio and contact here are never part of it. That is a
 * deliberate difference from the phone, which holds every community it has joined (apps/native components/CopyProfileCard.tsx).
 *
 * Nothing is applied by showing the card. The tap on the button sends the one photo, to this community's address and no other
 * (lib/api updateMemberProfile), and the line after it says what happened.
 */
import { useState } from 'react';
import { t } from '@beanpool/core';
import { nodeAddress, updateMemberProfile } from '../lib/api';
import { resolveAvatarUrl } from '../lib/avatar';
import { lastPhotoFrom, lastPhotoToCopy } from '../lib/last-photo';

export function CopyPhotoHere({ publicKey }: { publicKey: string }) {
    // Read once as the card opens: the browser's kept photo, from another community than this one.
    const [offer] = useState(() => lastPhotoToCopy(nodeAddress()));
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(false);
    const [error, setError] = useState<string | null>(null);

    if (!offer) return null;
    const from = lastPhotoFrom(offer);
    const heading = from ? t('Use the photo from {community} here?', { community: from }) : t('Use the photo you chose last here?');

    async function copy() {
        if (!offer || busy) return;
        if (!navigator.onLine) { setError(t('You need to be online to save your profile.')); return; }
        setBusy(true);
        setError(null);
        try {
            // The photo and nothing else: not the name, not the bio, not the contact.
            await updateMemberProfile(publicKey, { avatar: offer.avatar });
            setDone(true);
        } catch (err) {
            setError((err instanceof Error && err.message) || t('Could not save your profile. Try again.'));
        } finally {
            setBusy(false);
        }
    }

    return (
        <section
            aria-label={heading}
            data-testid="copy-photo-here"
            className="w-full p-4 rounded-2xl bg-white dark:bg-nature-900 text-nature-900 dark:text-white border border-nature-200 dark:border-nature-800 shadow-sm"
        >
            <div className="flex items-center gap-3">
                <span
                    aria-hidden="true"
                    className="w-12 h-12 rounded-full shrink-0 overflow-hidden bg-oat-100 dark:bg-nature-700"
                    style={{ background: `url("${resolveAvatarUrl(offer.avatar) || ''}") center/cover` }}
                />
                <div className="flex-1 min-w-0">
                    <div className="text-[15px] font-bold break-words">{heading}</div>
                    <div className="text-xs font-normal text-nature-600 dark:text-nature-300 break-words">
                        {t('Only the photo is copied. Your name and the rest of your profile here stay as they are.')}
                    </div>
                </div>
            </div>
            {done ? (
                <p role="status" className="mt-3 text-sm text-nature-800 dark:text-nature-100 break-words">{t('Done. This is now your photo here.')}</p>
            ) : (
                <button
                    onClick={copy}
                    disabled={busy}
                    className={`w-full mt-3 min-h-[44px] py-3 rounded-xl font-bold text-[15px] transition-all ${busy ? 'bg-nature-400 text-white cursor-not-allowed' : 'bg-nature-900 dark:bg-white text-white dark:text-nature-900 hover:opacity-90 cursor-pointer'}`}
                >
                    {busy ? t('Saving...') : t('Use this photo here')}
                </button>
            )}
            {error && <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300 break-words">{error}</p>}
        </section>
    );
}

export default CopyPhotoHere;
