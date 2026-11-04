/**
 * ProfileSetup — the re-runnable Name → Avatar → "how BeanPool works" wizard for
 * the EXISTING identity. Reached from Settings ("Re-run Setup") and from the
 * "finish your profile" gates on listing/accepting. Name + avatar are mandatory;
 * bio/contact/visibility (edited on the full Profile screen) are preserved here
 * so saving the avatar never wipes them.
 */
import { useState, useEffect, useRef } from 'react';
import { AVATAR_PICTURE, t } from '@beanpool/core';
import { updateMemberProfile, getMemberProfile, registerMember, nodeAddress } from '../lib/api';
import { updateCallsign, type BeanPoolIdentity } from '../lib/identity';
import { adoptNodeName, nodeNameFor } from '../lib/member-name';
import { resolveAvatarUrl } from '../lib/avatar';
import { lastPhotoToOffer, lastPhotoFrom } from '../lib/last-photo';
import { AvatarPresetPicker } from './AvatarPresetPicker';
import { OnboardingGuide } from './OnboardingGuide';
import { usePictureCrop } from './PictureCropDialog';

type Step = 'name' | 'avatar' | 'guide';
const ORDER: Step[] = ['name', 'avatar', 'guide'];

interface Props {
    identity: BeanPoolIdentity;
    onDone: () => void;
    onIdentityUpdated?: (identity: BeanPoolIdentity) => void;
}

type Contact = { value: string; visibility: 'hidden' | 'trade_partners' | 'community' | 'friends' } | null;

export function ProfileSetup({ identity, onDone, onIdentityUpdated }: Props) {
    const [step, setStep] = useState<Step>('name');
    const [callsign, setCallsign] = useState(identity.callsign ?? '');
    const [avatar, setAvatar] = useState<string | null>(null);
    // The photo the member used last, in another community, offered while this one holds none for them (Profile S3,
    // lib/last-photo.ts). A tickbox that starts OFF: ticking it makes it the pick, and only then is it shown as the photo or sent (left off, the offer row shows it small).
    const [photoOffer, setPhotoOffer] = useState<{ avatar: string; from: string | null } | null>(null);
    // Preserved so saving the avatar doesn't blank an existing bio/contact.
    const [bio, setBio] = useState('');
    const [contact, setContact] = useState<Contact>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const cameraInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        (async () => {
            try {
                const p = await getMemberProfile(identity.publicKey, identity.publicKey);
                // Only once this community has said what it holds: an answer that never came offers nothing.
                setPhotoOffer(lastPhotoToOffer(nodeAddress(), p?.avatar ?? null));
                if (!p) return;

                setAvatar(p.avatar);
                setBio(p.bio || '');
                if (p.contact) setContact(p.contact);
                // Open at the first missing step so someone who only needs a
                // photo isn't walked back through their name.
                const nameOk = (identity.callsign?.trim().length ?? 0) >= 2;
                if (nameOk && !resolveAvatarUrl(p.avatar)) setStep('avatar');
            } catch { /* first time / offline — start at name */ } finally {
                setLoading(false);
            }
        })();
        // eslint-disable-next-line
    }, []);

    const nameOk = callsign.trim().length >= 2;
    const avatarOk = !!resolveAvatarUrl(avatar);
    // Ticked exactly while the offered photo is the pick: choosing another photo un-ticks it, and un-ticking takes it back
    // out (this community held none when it was offered, so none comes back).
    const offerTicked = photoOffer !== null && avatar === photoOffer.avatar;
    const offerFrom = photoOffer ? lastPhotoFrom(photoOffer) : null;
    const offerLabel = offerFrom ? t('Use the photo from {community}?', { community: offerFrom }) : t('Use the photo you chose last?');
    const idx = ORDER.indexOf(step);

    // A photo opens the crop dialog: the part the member chooses in the circle is their avatar, 512 px
    // (components/PictureCropDialog.tsx). Cancel there keeps what they had.
    const cropper = usePictureCrop();
    function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        setError(null);
        cropper.crop(file, AVATAR_PICTURE)
            .then((cropped) => { if (cropped) setAvatar(cropped); })
            .catch(() => setError(t("That picture couldn't be read. Try another.")));
    }

    async function syncCallsign(trimmedCallsign: string) {
        if (!trimmedCallsign || trimmedCallsign === identity.callsign) return;
        const updated = await updateCallsign(trimmedCallsign);
        if (!updated) return;
        const answer = await registerMember(updated.publicKey, updated.callsign);
        // The node may keep another name than the one sent (a name another member holds is numbered): the member goes by
        // the node's, here as everywhere (lib/member-name.ts).
        const named = await adoptNodeName(updated, nodeNameFor(updated, answer?.member));
        onIdentityUpdated?.(named ?? updated);
    }

    async function handleFinish() {
        if (!navigator.onLine) { setError(t('You need to be online to save your profile.')); return; }
        if (!nameOk) return;
        setSaving(true);
        setError(null);
        try {
            await updateMemberProfile(identity.publicKey, { avatar, bio, contact });
            await syncCallsign(callsign.trim());
            onDone();
        } catch (err: any) {
            setError(err?.message || t('Could not save your profile. Try again.'));
        } finally {
            setSaving(false);
        }
    }

    if (loading) {
        return (
            <div className="min-h-full bg-white dark:bg-nature-900 p-8 text-center text-nature-500 dark:text-nature-300 font-medium animate-pulse">
                {t('Loading profile...')}
            </div>
        );
    }

    const resolvedAvatar = resolveAvatarUrl(avatar);

    return (
        <div className="min-h-full bg-white dark:bg-nature-900 p-6">
            <div className="max-w-[480px] mx-auto">
                {/* Step indicator */}
                <div className="flex items-center gap-2 mb-6">
                    {ORDER.map((s, i) => (
                        <div
                            key={s}
                            className={`h-1.5 rounded-full flex-1 transition-colors ${i <= idx ? 'bg-nature-900 dark:bg-white' : 'bg-nature-200 dark:bg-nature-800'}`}
                        />
                    ))}
                    <span className="ml-2 text-xs font-semibold text-nature-500 dark:text-nature-400 whitespace-nowrap">
                        {t('Step {n} of {total}', { n: idx + 1, total: ORDER.length })}
                    </span>
                </div>

                {step === 'name' && (
                    <>
                        <h2 className="text-xl font-bold text-nature-950 dark:text-white mb-1">{t('👋 Your name')}</h2>
                        <p className="text-sm text-nature-500 dark:text-nature-400 mb-5 leading-relaxed">
                            {t('This is how neighbours will know you. You can change it any time.')}
                        </p>
                        <input
                            aria-label={t('Your name')}
                            type="text"
                            value={callsign}
                            onChange={(e) => setCallsign(e.target.value)}
                            maxLength={20}
                            placeholder={t('Your name (e.g. Sally)')}
                            className="w-full py-3 px-4 rounded-xl border border-terra-400 dark:border-terra-600 bg-terra-50/40 dark:bg-terra-950/30 text-nature-900 dark:text-white text-base focus:outline-none focus:ring-2 focus:ring-terra-300 font-semibold transition-all"
                        />
                        {error && <p className="text-red-500 dark:text-red-300 text-sm mt-3">{error}</p>}
                        <button
                            onClick={() => { setError(null); setStep('avatar'); }}
                            disabled={!nameOk}
                            className={`w-full mt-6 py-3.5 rounded-xl font-bold text-[15px] transition-all shadow-md ${nameOk ? 'bg-nature-900 dark:bg-white text-white dark:text-nature-900 hover:opacity-90 cursor-pointer' : 'bg-nature-300 dark:bg-nature-700 text-white/70 cursor-not-allowed'}`}
                        >
                            {t('Next →')}
                        </button>
                        <button onClick={onDone} className="w-full mt-3 py-2 bg-transparent border-none text-nature-400 hover:text-nature-600 dark:hover:text-nature-300 text-sm font-semibold cursor-pointer">
                            {t('Cancel')}
                        </button>
                    </>
                )}

                {step === 'avatar' && (
                    <>
                        <h2 className="text-xl font-bold text-nature-950 dark:text-white mb-1">{t('📸 Choose your look')}</h2>
                        <p className="text-sm text-nature-500 dark:text-nature-400 mb-5 leading-relaxed">
                            {t('Add a photo — whatever feels like you.')}
                        </p>
                        <div className="text-center mb-6">
                            <div
                                className="w-24 h-24 rounded-full flex items-center justify-center mx-auto text-4xl shadow-md border-4 border-terra-300 dark:border-terra-600 bg-oat-100 dark:bg-nature-800 overflow-hidden"
                                style={{ background: `url("${resolvedAvatar || resolveAvatarUrl(null, identity.publicKey) || '/avatars/avatar_bean_green.webp'}") center/cover` }}
                            >
                            </div>
                            {photoOffer && (
                                <label className="flex items-center gap-3 text-left mt-4 p-3 rounded-xl border border-nature-300 dark:border-nature-600 bg-nature-50 dark:bg-nature-800 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        data-testid="last-photo-offer"
                                        checked={offerTicked}
                                        onChange={() => { cropper.cancel(); setAvatar(offerTicked ? null : photoOffer.avatar); }}
                                        className="w-5 h-5 shrink-0 cursor-pointer accent-nature-900 dark:accent-white"
                                    />
                                    <span
                                        aria-hidden="true"
                                        className="w-10 h-10 rounded-full shrink-0 overflow-hidden bg-oat-100 dark:bg-nature-700"
                                        style={{ background: `url("${resolveAvatarUrl(photoOffer.avatar) || ''}") center/cover` }}
                                    />
                                    <span className="flex-1 min-w-0 break-words text-sm font-semibold text-nature-800 dark:text-nature-100">{offerLabel}</span>
                                </label>
                            )}
                            <input ref={fileInputRef} type="file" accept="image/*" onChange={handleAvatarUpload} className="hidden" />
                            <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" onChange={handleAvatarUpload} className="hidden" />
                            <div className="flex flex-wrap justify-center gap-3 mt-4">
                                <button onClick={() => cameraInputRef.current?.click()} className="bg-white dark:bg-nature-800 border border-nature-200 dark:border-nature-700 rounded-xl px-4 py-2 text-nature-700 dark:text-nature-200 text-xs font-bold cursor-pointer hover:bg-nature-50 dark:hover:bg-nature-700 shadow-sm transition-all">
                                    {t('📸 Camera')}
                                </button>
                                <button onClick={() => fileInputRef.current?.click()} className="bg-white dark:bg-nature-800 border border-nature-200 dark:border-nature-700 rounded-xl px-4 py-2 text-nature-700 dark:text-nature-200 text-xs font-bold cursor-pointer hover:bg-nature-50 dark:hover:bg-nature-700 shadow-sm transition-all">
                                    {t('🖼️ Gallery')}
                                </button>
                            </div>
                            <AvatarPresetPicker
                                selected={avatar}
                                onSelect={(uri) => { cropper.cancel(); setAvatar(uri); }}
                            />
                            {cropper.dialog}
                        </div>
                        {error && <p className="text-red-500 dark:text-red-300 text-sm mt-3">{error}</p>}
                        <button
                            onClick={() => { setError(null); setStep('guide'); }}
                            className="w-full py-3.5 rounded-xl font-bold text-[15px] transition-all shadow-md bg-nature-900 dark:bg-white text-white dark:text-nature-900 hover:opacity-90 cursor-pointer"
                        >
                            {t('Next →')}
                        </button>
                        <button onClick={() => { setError(null); setStep('name'); }} className="w-full mt-3 py-2 bg-transparent border-none text-nature-400 hover:text-nature-600 dark:hover:text-nature-300 text-sm font-semibold cursor-pointer">
                            {t('← Back')}
                        </button>
                    </>
                )}

                {step === 'guide' && (
                    <>
                        <h2 className="text-xl font-bold text-nature-950 dark:text-white mb-1">{t('🫘 How BeanPool works')}</h2>
                        <p className="text-sm text-nature-500 dark:text-nature-400 mb-5 leading-relaxed">
                            {t('A quick look at this community economy.')}
                        </p>
                        <OnboardingGuide />
                        {error && <p className="text-red-500 dark:text-red-300 text-sm mt-3">{error}</p>}
                        <button
                            onClick={handleFinish}
                            disabled={saving}
                            className={`w-full mt-6 py-3.5 rounded-xl font-bold text-[15px] transition-all shadow-md ${saving ? 'bg-nature-400 text-white cursor-not-allowed' : 'bg-nature-900 dark:bg-white text-white dark:text-nature-900 hover:opacity-90 cursor-pointer'}`}
                        >
                            {saving ? t('Saving...') : t('Done ✓')}
                        </button>
                        <button onClick={() => { setError(null); setStep('avatar'); }} disabled={saving} className="w-full mt-3 py-2 bg-transparent border-none text-nature-400 hover:text-nature-600 dark:hover:text-nature-300 text-sm font-semibold cursor-pointer">
                            {t('← Back')}
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}

export default ProfileSetup;
