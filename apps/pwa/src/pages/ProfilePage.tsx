/**
 * ProfilePage — Edit your avatar, bio, and contact details
 *
 * Accessible from Settings. Contact visibility controls let
 * members choose who sees their contact info.
 */

import { useState, useEffect, useRef } from 'react';
import { updateMemberProfile, getMemberProfile, registerMember, type MemberProfile } from '../lib/api';
import { updateCallsign, type BeanPoolIdentity } from '../lib/identity';
import { resolveAvatarUrl } from '../lib/avatar';

interface Props {
    identity: BeanPoolIdentity;
    onBack: () => void;
    onIdentityUpdated?: (identity: BeanPoolIdentity) => void;
}

export function ProfilePage({ identity, onBack, onIdentityUpdated }: Props) {
    const [avatar, setAvatar] = useState<string | null>(null);
    const [callsign, setCallsign] = useState(identity.callsign);
    const [bio, setBio] = useState('');
    const [contactValue, setContactValue] = useState('');
    const [contactVisibility, setContactVisibility] = useState<'hidden' | 'trade_partners' | 'community' | 'friends'>('hidden');
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [loading, setLoading] = useState(true);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const cameraInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        loadProfile();
    }, []);

    async function loadProfile() {
        try {
            const profile = await getMemberProfile(identity.publicKey, identity.publicKey);
            if (profile) {
                setAvatar(profile.avatar);
                setBio(profile.bio || '');
                if (profile.contact) {
                    setContactValue(profile.contact.value);
                    setContactVisibility(profile.contact.visibility);
                }
            }
        } catch { /* first time */ }
        setLoading(false);
    }

    async function handleSave() {
        if (!navigator.onLine) {
            alert('You must be online to update your profile.');
            return;
        }
        setSaving(true);
        setSaved(false);
        try {
            await updateMemberProfile(identity.publicKey, {
                avatar,
                bio,
                contact: contactValue.trim()
                    ? { value: contactValue.trim(), visibility: contactVisibility }
                    : null,
            });
            // Update callsign if changed
            if (callsign.trim() && callsign.trim() !== identity.callsign) {
                const updated = await updateCallsign(callsign.trim());
                if (updated) {
                    await registerMember(updated.publicKey, updated.callsign);
                    onIdentityUpdated?.(updated);
                }
            }
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
        } catch (err: any) {
            alert(err.message || 'Failed to save profile');
        } finally {
            setSaving(false);
        }
    }

    function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            // Resize to 128x128 thumbnail
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = 128;
                canvas.height = 128;
                const ctx = canvas.getContext('2d')!;
                // Center crop
                const size = Math.min(img.width, img.height);
                const sx = (img.width - size) / 2;
                const sy = (img.height - size) / 2;
                ctx.drawImage(img, sx, sy, size, size, 0, 0, 128, 128);
                setAvatar(canvas.toDataURL('image/jpeg', 0.7));
            };
            img.src = reader.result as string;
        };
        reader.readAsDataURL(file);
    }

    if (loading) {
        return (
            <div className="p-8 text-center text-nature-500 font-medium animate-pulse">
                Loading profile...
            </div>
        );
    }

    return (
        <div className="p-6 max-w-[480px] mx-auto min-h-full bg-white dark:bg-nature-900 transition-colors">
            <div className="flex items-center gap-3 mb-6">
                <button
                    onClick={onBack}
                    className="bg-transparent border-none text-nature-600 dark:text-nature-400 hover:text-nature-900 dark:hover:text-white text-sm cursor-pointer px-1 transition-colors font-semibold"
                >
                    ← Back
                </button>
                <h2 className="text-xl font-bold text-nature-950 dark:text-white m-0 tracking-tight">Your Profile</h2>
            </div>

            {/* Avatar */}
            <div className="text-center mb-8 relative">
                <div
                    className="w-24 h-24 rounded-full flex items-center justify-center mx-auto text-4xl shadow-md border-4 border-terra-300 dark:border-terra-600 bg-oat-100 dark:bg-nature-800 overflow-hidden relative group transition-transform hover:scale-105"
                    style={{ background: resolveAvatarUrl(avatar) ? `url("${resolveAvatarUrl(avatar)}") center/cover` : undefined }}
                >
                    {!resolveAvatarUrl(avatar) && '👤'}
                    <div className="absolute inset-0 bg-black/30 hidden group-hover:flex items-center justify-center transition-opacity">
                        <span className="text-white text-xs font-bold bg-black/60 px-2 py-1 rounded-full backdrop-blur-sm">Edit</span>
                    </div>
                </div>

                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleAvatarUpload}
                    className="hidden"
                />
                <input
                    ref={cameraInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={handleAvatarUpload}
                    className="hidden"
                />
                <div className="flex justify-center gap-3 mt-4">
                    <button
                        onClick={() => cameraInputRef.current?.click()}
                        className="bg-white dark:bg-nature-800 border border-nature-200 dark:border-nature-700 rounded-xl px-4 py-2 text-nature-700 dark:text-nature-200 text-xs font-bold cursor-pointer hover:bg-nature-50 dark:hover:bg-nature-700 shadow-sm transition-all"
                    >
                        📸 Camera
                    </button>
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        className="bg-white dark:bg-nature-800 border border-nature-200 dark:border-nature-700 rounded-xl px-4 py-2 text-nature-700 dark:text-nature-200 text-xs font-bold cursor-pointer hover:bg-nature-50 dark:hover:bg-nature-700 shadow-sm transition-all"
                    >
                        🖼️ Gallery
                    </button>
                </div>
                {avatar && (
                    <button
                        onClick={() => setAvatar(null)}
                        className="bg-transparent mt-3 border-none text-red-500 hover:text-red-700 text-xs font-semibold cursor-pointer transition-colors px-2 py-1 rounded-md hover:bg-red-50 dark:hover:bg-red-950/30"
                    >
                        Remove photo
                    </button>
                )}
            </div>

            {/* Callsign */}
            <div className="mb-6">
                <label htmlFor="profile-callsign" className="block text-[14px] font-bold text-nature-950 dark:text-white mb-2">Callsign ✏️</label>
                <input
                    id="profile-callsign"
                    type="text"
                    value={callsign}
                    onChange={(e) => setCallsign(e.target.value)}
                    maxLength={20}
                    className="w-full py-3 px-4 rounded-xl border border-terra-400 dark:border-terra-600 bg-terra-50/40 dark:bg-terra-950/30 text-nature-900 dark:text-white text-base focus:outline-none focus:ring-2 focus:ring-terra-300 font-semibold transition-all"
                />
                <p className="text-nature-500 dark:text-nature-400 text-xs mt-2 font-medium">
                    Changing your callsign updates your display name everywhere
                </p>
            </div>

            {/* Bio */}
            <div className="mb-6">
                <label htmlFor="profile-bio" className="block text-[14px] font-bold text-nature-950 dark:text-white mb-2">Bio</label>
                <textarea
                    id="profile-bio"
                    value={bio}
                    onChange={(e) => setBio(e.target.value)}
                    placeholder="A short bio about yourself..."
                    maxLength={200}
                    className="w-full py-3 px-4 rounded-xl border border-nature-200 dark:border-nature-800 bg-oat-50/50 dark:bg-nature-950/50 text-nature-900 dark:text-white text-base focus:outline-none focus:ring-2 focus:ring-terra-300 shadow-sm min-h-[90px] resize-none transition-all placeholder:text-nature-400"
                />
                <p className="text-nature-400 dark:text-nature-500 text-xs text-right mt-1 font-medium">
                    {bio.length}/200
                </p>
            </div>

            {/* Contact Details */}
            <div className="bg-oat-50/50 dark:bg-nature-950/40 border border-nature-200 dark:border-nature-800 rounded-2xl p-5 mb-8 shadow-sm">
                <label htmlFor="profile-contact" className="block text-[14px] font-bold text-nature-950 dark:text-white mb-2">Contact Details</label>
                <input
                    id="profile-contact"
                    type="text"
                    value={contactValue}
                    onChange={(e) => setContactValue(e.target.value)}
                    placeholder="Phone, email, or WhatsApp"
                    className="w-full py-3 px-4 mb-4 rounded-xl border border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-900 text-nature-900 dark:text-white text-base focus:outline-none focus:ring-2 focus:ring-terra-300 shadow-sm transition-all placeholder:text-nature-400"
                />

                {contactValue.trim() && (
                    <div className="animate-in fade-in slide-in-from-top-2 duration-300">
                        <label className="block text-xs font-bold text-nature-700 dark:text-nature-300 uppercase tracking-wider mb-2.5 mt-2">Who can see this?</label>
                        <div className="flex flex-col gap-2">
                            {([
                                { value: 'hidden', label: '🔒 Hidden', desc: 'Only you can see it' },
                                { value: 'trade_partners', label: '🤝 Trade Partners', desc: 'Visible when you enter a trade' },
                                { value: 'friends', label: '👥 Friends', desc: 'People you have added as friends' },
                                { value: 'community', label: '🌍 Community', desc: 'Anyone on this node' },
                            ] as const).map(opt => (
                                <button
                                    key={opt.value}
                                    onClick={() => setContactVisibility(opt.value)}
                                    className={`flex items-center gap-3 p-3.5 rounded-xl border transition-all text-left w-full cursor-pointer shadow-sm ${
                                        contactVisibility === opt.value
                                            ? 'border-terra-500 bg-terra-50 dark:bg-terra-950/30 shadow-md ring-1 ring-terra-500'
                                            : 'border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-900 hover:bg-nature-50 dark:hover:bg-nature-800'
                                    }`}
                                >
                                    <span className="text-xl leading-none">{opt.label.split(' ')[0]}</span>
                                    <div className="flex-1">
                                        <div className={`text-[14px] font-bold ${contactVisibility === opt.value ? 'text-terra-900 dark:text-terra-300' : 'text-nature-900 dark:text-white'}`}>
                                            {opt.label.split(' ').slice(1).join(' ')}
                                        </div>
                                        <div className={`text-xs mt-0.5 ${contactVisibility === opt.value ? 'text-terra-700 dark:text-terra-400' : 'text-nature-500 dark:text-nature-400'}`}>
                                            {opt.desc}
                                        </div>
                                    </div>
                                    {contactVisibility === opt.value && (
                                        <div className="text-terra-500 text-lg font-bold">✓</div>
                                    )}
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* Save Button */}
            <button
                onClick={handleSave}
                disabled={saving}
                className={`w-full py-4 rounded-xl font-bold transition-all shadow-md text-[15px] cursor-pointer ${
                    saved 
                        ? 'bg-emerald-500 text-white border-emerald-600' 
                        : saving 
                            ? 'bg-nature-300 text-white cursor-not-allowed' 
                            : 'bg-nature-900 dark:bg-white text-white dark:text-nature-900 hover:opacity-90'
                }`}
            >
                {saved ? '✓ Profile Saved Successfully!' : saving ? 'Saving...' : 'Save Profile Changes'}
            </button>
        </div>
    );
}
