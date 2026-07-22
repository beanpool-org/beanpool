/**
 * WelcomePage — First-run identity bootstrap with invite code
 *
 * New users:  Enter invite code + callsign → create → show seed phrase → joined
 * Existing:   Import identity from another device
 * Recovery:   Enter 12-word phrase to recover identity
 */

import React, { useState, useRef } from 'react';
import { createIdentity, createIdentityFromMnemonic, importIdentity, type BeanPoolIdentity } from '../lib/identity';
import { validateMnemonic } from '../lib/mnemonic';

import { redeemInvite, redeemOfflineTicket, registerMember, updateMemberProfile } from '../lib/api';
import { resolveAvatarUrl } from '../lib/avatar';


interface Props {
    onComplete: (identity: BeanPoolIdentity) => void;
}

// ===================== INVITE CODE FORMATTING =====================

function extractInviteToken(raw: string): string {
    const inviteMatch = raw.match(/[?&]invite=([^&]+)/);
    if (inviteMatch) {
        return decodeURIComponent(inviteMatch[1]);
    }
    return raw;
}

/** Strip everything except alphanumeric, uppercase, and format as BP-XXXX-XXXX */
function formatInviteCode(raw: string): string {
    const extracted = extractInviteToken(raw);
    const trimmed = extracted.trim();
    if (trimmed.length > 20 && trimmed.startsWith('BP-')) {
        return trimmed; // It's an offline cryptographic ticket. Just return it cleanly.
    }

    // Strip non-alphanumeric
    const clean = extracted.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    
    // Legacy support for Node Genesis invites
    if (clean.startsWith('INV')) {
        const body = clean.slice(3);
        if (body.length === 0) return '';
        if (body.length <= 4) return `INV-${body}`;
        return `INV-${body.slice(0, 4)}-${body.slice(4, 8)}`;
    }

    const withoutPrefix = clean.startsWith('BP') ? clean.slice(2) : clean;
    const body = withoutPrefix.slice(0, 8);

    if (body.length === 0) return '';
    if (body.length <= 4) return `BP-${body}`;
    return `BP-${body.slice(0, 4)}-${body.slice(4)}`;
}

/** Normalise any input to the canonical format for API submission */
function normaliseInviteCode(raw: string): string {
    const extracted = extractInviteToken(raw);
    const trimmed = extracted.trim();
    if (trimmed.length > 20 && trimmed.startsWith('BP-')) {
        return trimmed; // Offline cryptographic bulk token
    }

    const clean = extracted.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    
    if (clean.startsWith('INV')) {
        const body = clean.slice(3);
        if (body.length < 8) return extracted.trim().toUpperCase();
        return `INV-${body.slice(0, 4)}-${body.slice(4, 8)}`;
    }

    const withoutPrefix = clean.startsWith('BP') ? clean.slice(2) : clean;
    const body = withoutPrefix.slice(0, 8);
    if (body.length < 8) return extracted.trim().toUpperCase(); // partial — return as-is
    return `BP-${body.slice(0, 4)}-${body.slice(4)}`;
}

// ===================== FAQ DATA =====================

const FAQ_ITEMS = [
    {
        q: 'What is BeanPool?',
        a: 'BeanPool is a mutual credit marketplace for local communities. Members can post offers and needs, trade using community credits, and build local economic resilience — all without banks or corporations.',
    },
    {
        q: 'How do I get an invite?',
        a: 'Ask an existing community member to generate an invite code for you. They can share it as a link, QR code, or text. Each invite code works once.',
    },
    {
        q: 'Is my data private?',
        a: 'Your identity is an Ed25519 keypair stored only on your device — never on a server. Your posts and transactions are shared within your community, but your private key never leaves your device.',
    },
    {
        q: 'What are community credits?',
        a: 'Credits are a mutual credit currency. When you trade, credits transfer between members. Every member starts at zero. The system is designed to encourage reciprocity and keep value circulating locally.',
    },
    {
        q: 'Can I use this on my phone?',
        a: 'Yes! BeanPool is a Progressive Web App. Open the app link in your browser, then "Add to Home Screen" for the full native-like experience — works on Android, iOS, and desktop.',
    },
];

// ===================== BUNDLED AVATARS & STEPPER =====================

const BUNDLED_AVATARS = [
    { id: 'bean-green',   label: 'Green Bean' },
    { id: 'bean-purple',  label: 'Purple Bean' },
    { id: 'leaf',         label: 'Leaf' },
    { id: 'sprout',       label: 'Sprout' },
    { id: 'sun',          label: 'Sun' },
    { id: 'moon',         label: 'Moon' },
    { id: 'wave',         label: 'Wave' },
    { id: 'mountain',     label: 'Mountain' },
    { id: 'fire',         label: 'Fire' },
    { id: 'crystal',      label: 'Crystal' },
];

function OnboardingStepper({ step }: { step: 1 | 2 | 3 | 4 }) {
    const steps = ['Your Name', 'Your Photo', 'Safety Backup', 'How it Works'];
    return (
        <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '1.5rem',
            width: '100%',
        }}>
            {steps.map((label, i) => {
                const stepNum = i + 1;
                const isActive = stepNum === step;
                const isCompleted = stepNum < step;
                return (
                    <React.Fragment key={i}>
                        {i > 0 && (
                            <div style={{
                                flex: 1,
                                height: '2px',
                                backgroundColor: isCompleted || isActive ? '#22c55e' : '#e5e7eb',
                                marginLeft: '4px',
                                marginRight: '4px',
                                marginTop: '-14px',
                            }} />
                        )}
                        <div style={{
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            position: 'relative',
                            width: '4.5rem',
                        }}>
                            <div style={{
                                width: '12px',
                                height: '12px',
                                borderRadius: '6px',
                                backgroundColor: isCompleted ? '#22c55e' : isActive ? '#2563eb' : '#d1d5db',
                                marginBottom: '6px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                transition: 'all 0.3s',
                            }}>
                                {isCompleted && (
                                    <span style={{ color: '#fff', fontSize: '8px', fontWeight: '800' }}>✓</span>
                                )}
                            </div>
                            <span style={{
                                fontSize: '10px',
                                color: isActive ? 'var(--text-primary)' : '#6b7280',
                                fontWeight: isActive ? '700' : '500',
                                transition: 'color 0.3s',
                                whiteSpace: 'nowrap',
                                textAlign: 'center',
                            }}>
                                {label}
                            </span>
                        </div>
                    </React.Fragment>
                );
            })}
        </div>
    );
}

export function WelcomePage({ onComplete }: Props) {
    const [callsign, setCallsign] = useState('');
    const [inviteCode, setInviteCode] = useState(() => {
        const params = new URLSearchParams(window.location.search);
        const raw = params.get('invite') || '';
        return raw ? formatInviteCode(raw) : '';
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [showRecovery, setShowRecovery] = useState(false);
    const [recoveryWords, setRecoveryWords] = useState<string[]>(Array(12).fill(''));
    const [recoveryCallsign, setRecoveryCallsign] = useState('');
    const [pendingIdentity, setPendingIdentity] = useState<BeanPoolIdentity | null>(null);
    const [seedConfirmed, setSeedConfirmed] = useState(false);
    const [pendingInviteCode, setPendingInviteCode] = useState('');
    const [showOnboardingGuide, setShowOnboardingGuide] = useState(false);
    const [showNewUser, setShowNewUser] = useState(() => true);
    const [showMemberOptions, setShowMemberOptions] = useState(false);
    const [openFaq, setOpenFaq] = useState<number | null>(null);

    const [showAvatarSetup, setShowAvatarSetup] = useState(false);
    const [pendingAvatar, setPendingAvatar] = useState<string | null>(null);

    const fileInputRef = useRef<HTMLInputElement>(null);
    const cameraInputRef = useRef<HTMLInputElement>(null);


    async function handleCreate() {
        const trimmedCallsign = callsign.trim();
        const trimmedCode = normaliseInviteCode(inviteCode);

        if (!trimmedCode) {
            setError('An invite code is required to join this node.');
            return;
        }

        if (trimmedCallsign.length < 2) {
            setError('Callsign must be at least 2 characters.');
            return;
        }

        setLoading(true);
        setError(null);

        try {
            // Pre-flight the invite BEFORE creating an identity — a dud code
            // should fail here, not after the seed ceremony. A null result
            // (older node) fails open; redeem stays the definitive check.
            const { checkInvite } = await import('../lib/api');
            const check = await checkInvite(trimmedCode);
            if (check && !check.valid) {
                setError(check.reason === 'used'
                    ? 'This invite has already been used — each one works exactly once. Ask whoever invited you for a fresh one.'
                    : check.reason === 'expired'
                        ? 'This invite has expired — invites last 30 days. Ask whoever invited you for a fresh one.'
                        : "That invite wasn't recognised. Double-check the code, or ask whoever invited you for a fresh one.");
                setLoading(false);
                return;
            }

            const identity = pendingIdentity
                ? { ...pendingIdentity, callsign: trimmedCallsign }
                : await createIdentity(trimmedCallsign);
            setPendingIdentity(identity);
            setPendingInviteCode(trimmedCode);

            // Redeem invite immediately so user is registered on node right away
            try {
                const { redeemInvite, redeemOfflineTicket } = await import('../lib/api');
                if (trimmedCode.length > 20 && trimmedCode.startsWith('BP-')) {
                    const ticketB64 = trimmedCode.slice(3);
                    await redeemOfflineTicket(ticketB64, identity.publicKey, identity.callsign);
                } else {
                    await redeemInvite(trimmedCode, identity.publicKey, identity.callsign);
                }
            } catch (redeemErr: any) {
                if (!redeemErr?.message?.includes('already a member') && !redeemErr?.message?.includes('already been used')) {
                    throw redeemErr;
                }
            }

            setShowAvatarSetup(true);
            setLoading(false);
        } catch (err) {
            setError('Failed to generate identity. Please try again.');
            console.error(err);
            setLoading(false);
        }
    }

    const handleAvatarFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setLoading(true);
        setError(null);

        const reader = new FileReader();
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = 128;
                canvas.height = 128;
                const ctx = canvas.getContext('2d');
                if (ctx) {
                    // Crop to center square
                    const minDim = Math.min(img.width, img.height);
                    const sx = (img.width - minDim) / 2;
                    const sy = (img.height - minDim) / 2;
                    ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, 128, 128);
                    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
                    setPendingAvatar(dataUrl);
                }
                setLoading(false);
            };
            img.onerror = () => {
                setError('Failed to load image.');
                setLoading(false);
            };
            img.src = event.target?.result as string;
        };
        reader.onerror = () => {
            setError('Failed to read file.');
            setLoading(false);
        };
        reader.readAsDataURL(file);
        e.target.value = '';
    };

    async function handleSeedConfirmed() {
        if (!pendingIdentity) return;
        setLoading(true);
        try {
            if (pendingInviteCode) {
                try {
                    if (pendingInviteCode.length > 20 && pendingInviteCode.startsWith('BP-')) {
                        // Offline ticket cryptographic redemption
                        const ticketB64 = pendingInviteCode.slice(3); // Remove 'BP-' prefix
                        await redeemOfflineTicket(ticketB64, pendingIdentity.publicKey, pendingIdentity.callsign);
                    } else {
                        // Legacy short-hash central database redemption
                        await redeemInvite(pendingInviteCode, pendingIdentity.publicKey, pendingIdentity.callsign);
                    }
                } catch (err: any) {
                    setError(err.message || 'Invalid invite code');
                    setLoading(false);
                    return;
                }
            } else {
                try {
                    await registerMember(pendingIdentity.publicKey, pendingIdentity.callsign);
                } catch (err: any) {
                    setError(err.message || 'Registration failed.');
                    setLoading(false);
                    return;
                }
            }

            // Sync the chosen profile avatar to the node database
            if (pendingAvatar) {
                try {
                    await updateMemberProfile(pendingIdentity.publicKey, {
                        avatar: pendingAvatar,
                    });
                } catch (avatarErr) {
                    console.warn('[Welcome] Failed to update member profile avatar:', avatarErr);
                }
            }
            
            // Onboarding complete — explicitly ask for location once
            if ('geolocation' in navigator) {
                navigator.geolocation.getCurrentPosition(() => {}, () => {});
            }
            onComplete(pendingIdentity);
        } finally {
            setLoading(false);
        }
    }

    async function handleRecover() {
        const words = recoveryWords.map(w => w.toLowerCase().trim());
        if (!validateMnemonic(words)) {
            setError('One or more words are not valid. Check your spelling.');
            return;
        }
        if (recoveryCallsign.trim().length < 2) {
            setError('Enter your callsign (at least 2 characters).');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const identity = await createIdentityFromMnemonic(words, recoveryCallsign.trim());
            try {
                await registerMember(identity.publicKey, identity.callsign);
            } catch { /* offline */ }
            
            // Recovery complete — explicitly ask for location once
            if ('geolocation' in navigator) {
                navigator.geolocation.getCurrentPosition(() => {}, () => {});
            }
            onComplete(identity);
        } catch {
            setError('Recovery failed. Check your words and try again.');
        } finally {
            setLoading(false);
        }
    }



    const inputStyle: React.CSSProperties = {
        width: '100%',
        padding: '0.75rem 1rem',
        borderRadius: '10px',
        border: '1px solid var(--border-input)',
        background: 'var(--bg-secondary)',
        color: 'var(--text-primary)',
        fontSize: '1rem',
        fontFamily: 'inherit',
        outline: 'none',
        marginBottom: '1rem',
    };

    return (
        <div className="bg-oat-50 dark:bg-nature-950 min-h-screen text-nature-950 dark:text-oat-50" style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            padding: '2rem',
        }}>
            <div style={{
                maxWidth: '420px',
                width: '100%',
                textAlign: 'center',
            }}>
                <img src="/assets/logo-192x192.png" alt="BeanPool Logo" style={{ width: '4rem', height: '4rem', objectFit: 'contain', margin: '0 auto 1rem' }} />
                <h2 style={{ fontSize: '1.6rem', fontWeight: 700, marginBottom: '0.5rem' }}>
                    Welcome to BeanPool
                </h2>
                <p style={{ color: 'var(--text-muted)', marginBottom: '2rem', lineHeight: 1.6 }}>
                    Your identity is yours. It lives on this device,
                    backed by cryptography — no passwords, no central accounts.
                </p>

                <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 shadow-sm" style={{
                    borderRadius: '16px',
                    padding: '2rem',
                }}>
                    {/* ===== SEED PHRASE DISPLAY (after create, before confirm) ===== */}
                    {pendingIdentity?.mnemonic && showAvatarSetup ? (
                        /* ===== STEP 2: CHOOSE YOUR LOOK ===== */
                        <>
                            <OnboardingStepper step={2} />
                            <h3 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.5rem' }}>
                                📸 Choose your look
                            </h3>
                            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '1.5rem', lineHeight: 1.5 }}>
                                Pick a profile picture so your community knows you.
                            </p>

                            {/* Circular Preview */}
                            <div style={{
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                marginBottom: '1.5rem',
                            }}>
                                {pendingAvatar ? (
                                    <img
                                        src={resolveAvatarUrl(pendingAvatar) || ''}
                                        alt="Avatar Preview"
                                        style={{
                                            width: '96px',
                                            height: '96px',
                                            borderRadius: '48px',
                                            border: '3px solid #2563eb',
                                            objectFit: 'cover',
                                        }}
                                    />
                                ) : (
                                    <div style={{
                                        width: '96px',
                                        height: '96px',
                                        borderRadius: '48px',
                                        backgroundColor: 'var(--bg-secondary, #1e293b)',
                                        border: '2px dashed var(--border-primary, #334155)',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                    }}>
                                        <span style={{ fontSize: '2rem', fontWeight: '800', color: 'var(--text-muted)' }}>
                                            {pendingIdentity.callsign.charAt(0).toUpperCase()}
                                        </span>
                                    </div>
                                )}
                                <span style={{ fontSize: '1rem', fontWeight: 700, marginTop: '0.5rem' }}>
                                    {pendingIdentity.callsign}
                                </span>
                            </div>

                            {/* Camera and Gallery Buttons */}
                            <div style={{
                                display: 'flex',
                                gap: '0.75rem',
                                marginBottom: '1.5rem',
                            }}>
                                <button
                                    onClick={() => cameraInputRef.current?.click()}
                                    disabled={loading}
                                    style={{
                                        flex: 1,
                                        padding: '0.75rem',
                                        borderRadius: '12px',
                                        border: '1px solid var(--border-primary, #334155)',
                                        background: 'var(--bg-secondary, #1e293b)',
                                        color: 'var(--text-primary)',
                                        fontSize: '0.9rem',
                                        fontWeight: 600,
                                        cursor: 'pointer',
                                        display: 'flex',
                                        flexDirection: 'column',
                                        alignItems: 'center',
                                        gap: '0.25rem',
                                    }}
                                >
                                    <span style={{ fontSize: '1.5rem' }}>📸</span>
                                    Camera
                                </button>
                                <button
                                    onClick={() => fileInputRef.current?.click()}
                                    disabled={loading}
                                    style={{
                                        flex: 1,
                                        padding: '0.75rem',
                                        borderRadius: '12px',
                                        border: '1px solid var(--border-primary, #334155)',
                                        background: 'var(--bg-secondary, #1e293b)',
                                        color: 'var(--text-primary)',
                                        fontSize: '0.9rem',
                                        fontWeight: 600,
                                        cursor: 'pointer',
                                        display: 'flex',
                                        flexDirection: 'column',
                                        alignItems: 'center',
                                        gap: '0.25rem',
                                    }}
                                >
                                    <span style={{ fontSize: '1.5rem' }}>🖼️</span>
                                    Gallery
                                </button>
                            </div>

                            {/* Hidden inputs */}
                            <input
                                type="file"
                                accept="image/*"
                                capture="user"
                                ref={cameraInputRef}
                                style={{ display: 'none' }}
                                onChange={handleAvatarFileChange}
                            />
                            <input
                                type="file"
                                accept="image/*"
                                ref={fileInputRef}
                                style={{ display: 'none' }}
                                onChange={handleAvatarFileChange}
                            />

                            <h4 style={{
                                fontSize: '0.85rem',
                                fontWeight: 600,
                                color: 'var(--text-secondary)',
                                textAlign: 'left',
                                marginBottom: '0.75rem',
                            }}>
                                Or choose an avatar:
                            </h4>

                            {/* Horizontal scroll grid of BUNDLED_AVATARS */}
                            <div style={{
                                display: 'flex',
                                gap: '0.75rem',
                                overflowX: 'auto',
                                padding: '0.5rem 0.25rem',
                                marginBottom: '1.5rem',
                                backgroundColor: 'var(--bg-secondary, #1e293b)',
                                borderRadius: '12px',
                                border: '1px solid var(--border-primary, #334155)',
                            }} className="custom-scrollbar">
                                {BUNDLED_AVATARS.map((avatar) => {
                                    const isSelected = pendingAvatar === `bundled://${avatar.id}`;
                                    const resolvedUrl = resolveAvatarUrl(`bundled://${avatar.id}`) || '';
                                    return (
                                        <button
                                            key={avatar.id}
                                            onClick={() => setPendingAvatar(`bundled://${avatar.id}`)}
                                            style={{
                                                flexShrink: 0,
                                                width: '56px',
                                                height: '56px',
                                                borderRadius: '28px',
                                                border: isSelected ? '3px solid #2563eb' : '2px solid transparent',
                                                padding: 0,
                                                overflow: 'hidden',
                                                cursor: 'pointer',
                                                background: 'none',
                                                transition: 'all 0.2s',
                                                transform: isSelected ? 'scale(1.05)' : 'none',
                                            }}
                                            title={avatar.label}
                                        >
                                            <img
                                                src={resolvedUrl}
                                                alt={avatar.label}
                                                style={{
                                                    width: '100%',
                                                    height: '100%',
                                                    objectFit: 'cover',
                                                }}
                                            />
                                        </button>
                                    );
                                })}
                            </div>

                            {loading && (
                                <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '1rem' }}>
                                    Processing photo...
                                </p>
                            )}

                            {error && (
                                <p style={{ color: '#ef4444', fontSize: '0.85rem', marginBottom: '1rem' }}>
                                    {error}
                                </p>
                            )}

                            <button
                                onClick={() => {
                                    if (pendingAvatar) {
                                        setShowAvatarSetup(false);
                                        setError(null);
                                    }
                                }}
                                disabled={!pendingAvatar || loading}
                                style={{
                                    width: '100%',
                                    padding: '0.85rem',
                                    borderRadius: '10px',
                                    border: 'none',
                                    background: !pendingAvatar ? 'var(--border-primary, #334155)' : loading ? '#555' : '#2563eb',
                                    color: 'var(--text-primary)',
                                    fontSize: '1rem',
                                    fontWeight: 600,
                                    cursor: !pendingAvatar || loading ? 'not-allowed' : 'pointer',
                                    fontFamily: 'inherit',
                                    transition: 'background 0.2s',
                                }}
                            >
                                Next →
                            </button>

                            <button
                                onClick={() => {
                                    setPendingIdentity(null);
                                    setPendingAvatar(null);
                                    setShowAvatarSetup(false);
                                    setError(null);
                                }}
                                disabled={loading}
                                style={{
                                    background: 'none',
                                    border: 'none',
                                    color: 'var(--text-muted)',
                                    fontSize: '0.85rem',
                                    cursor: 'pointer',
                                    marginTop: '1rem',
                                    fontFamily: 'inherit',
                                }}
                            >
                                ← Back
                            </button>
                        </>
                    ) : pendingIdentity?.mnemonic && showOnboardingGuide ? (
                        /* ===== ONBOARDING GUIDE (Step 4) ===== */
                        <>
                            <OnboardingStepper step={4} />
                            <h3 className="text-xl font-bold mb-2 text-nature-950 dark:text-oat-50">🫘 Welcome to BeanPool</h3>
                            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '1.5rem', lineHeight: 1.5 }}>
                                Let's look at how this community economy works.
                            </p>

                            <div className="text-left space-y-4 mb-6" style={{ maxHeight: '350px', overflowY: 'auto', paddingRight: '0.5rem', textAlign: 'left' }}>
                                {/* Card 1: Energy Exchange */}
                                <div className="p-4 rounded-xl border border-nature-200 dark:border-nature-800 bg-nature-50/50 dark:bg-nature-950/50">
                                    <h4 className="font-bold text-sm mb-1 text-nature-950 dark:text-oat-50">⚡ Energy Exchange Marketplace</h4>
                                    <p className="text-xs text-nature-600 dark:text-nature-400 leading-relaxed">
                                        BeanPool runs on cooperation, not accumulation. The goal is to keep energy flowing.
                                    </p>
                                    <div className="mt-3 p-3 rounded-lg border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50/50 dark:bg-emerald-950/20 text-emerald-800 dark:text-emerald-300 text-xs leading-normal">
                                        🟢 <strong>The best place to be is zero (0 Beans).</strong> This means you have given as much value to your community as you have received from it.
                                    </div>
                                    <div className="mt-3 p-3 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50/50 dark:bg-amber-950/20 text-amber-800 dark:text-amber-300 text-xs leading-normal">
                                        🫘 <strong>Contributions First.</strong> To keep the credit pool healthy, you must list at least one Offer of what you can give back before you can post Needs or accept Offers from others.
                                    </div>
                                </div>

                                {/* Card 2: The Ledger Rules */}
                                <div className="p-4 rounded-xl border border-nature-200 dark:border-nature-800 bg-nature-50/50 dark:bg-nature-950/50 space-y-4">
                                    <h4 className="font-bold text-sm text-nature-950 dark:text-oat-50">🪙 The Mutual Credit Ledger</h4>
                                    
                                    <div className="flex gap-3 items-start">
                                        <span className="text-lg leading-none">🤝</span>
                                        <div>
                                            <h5 className="font-bold text-xs text-nature-850 dark:text-nature-300">Trust-Backed Credit</h5>
                                            <p className="text-[11px] text-nature-500 dark:text-nature-400 leading-relaxed">
                                                Everyone starts with a 0 Bean limit. Complete your first real marketplace trade and your community credit line opens — then it deepens steadily with the value you trade and the people you trade with, up to -2000 Beans. No interest, no bank fees.
                                            </p>
                                        </div>
                                    </div>

                                    <div className="flex gap-3 items-start border-t border-nature-100 dark:border-nature-900 pt-3">
                                        <span className="text-lg leading-none">🌾</span>
                                        <div>
                                            <h5 className="font-bold text-xs text-nature-850 dark:text-nature-300">Community Commons Pool</h5>
                                            <p className="text-[11px] text-nature-500 dark:text-nature-400 leading-relaxed">
                                                Positive balances above 200 Beans decay by 1.5% monthly (progressive circulation). This prevents hoarding and funds local community projects.
                                            </p>
                                        </div>
                                    </div>

                                    <div className="flex gap-3 items-start border-t border-nature-100 dark:border-nature-900 pt-3">
                                        <span className="text-lg leading-none">⏱️</span>
                                        <div>
                                            <h5 className="font-bold text-xs text-nature-850 dark:text-nature-300">Reference Rate</h5>
                                            <p className="text-[11px] text-nature-500 dark:text-nature-400 leading-relaxed">
                                                40 Beans represents roughly 1 hour of community service or time, helping you easily value what you offer or need.
                                            </p>
                                        </div>
                                    </div>
                                </div>

                                {/* Card 3: Safe Handshake Held in Trust */}
                                <div className="p-4 rounded-xl border border-nature-200 dark:border-nature-800 bg-nature-50/50 dark:bg-nature-950/50">
                                    <h4 className="font-bold text-sm mb-1 text-nature-950 dark:text-oat-50">🔒 Held in Trust</h4>
                                    <p className="text-xs text-nature-600 dark:text-nature-400 leading-relaxed">
                                        To ensure fairness, when you accept an offer or request a job, your credits are safely held in a temporary Trust Wallet. They are only released to the provider once you confirm delivery.
                                    </p>
                                </div>

                                {/* Card 4: Where to Start */}
                                <div className="p-4 rounded-xl border border-nature-200 dark:border-nature-800 bg-nature-50/50 dark:bg-nature-950/50 space-y-2">
                                    <h4 className="font-bold text-sm text-nature-950 dark:text-oat-50">🚀 Where to Start?</h4>
                                    <p className="text-xs text-nature-600 dark:text-nature-400 leading-relaxed">
                                        📍 Explore the <strong>Map</strong> to find offers (blue) and needs (orange) near you.
                                    </p>
                                    <p className="text-xs text-nature-600 dark:text-nature-400 leading-relaxed">
                                        💬 Tap <strong>Message</strong> on any post to chat securely (E2E encrypted) with neighbors.
                                    </p>
                                    <p className="text-xs text-nature-600 dark:text-nature-400 leading-relaxed">
                                        ➕ Click <strong>Post</strong> to list what you need or what you can offer to the community.
                                    </p>
                                    <p className="text-xs text-nature-600 dark:text-nature-400 leading-relaxed">
                                        💳 Use the <strong>Ledger</strong> tab to send credits to neighbors instantly.
                                    </p>
                                </div>
                            </div>

                            {error && (
                                <p style={{ color: '#ef4444', fontSize: '0.85rem', marginBottom: '1rem' }}>
                                    {error}
                                </p>
                            )}

                            <button
                                onClick={handleSeedConfirmed}
                                disabled={loading}
                                style={{
                                    width: '100%', padding: '0.85rem', borderRadius: '10px',
                                    border: 'none',
                                    background: loading ? '#555' : '#2563eb',
                                    color: 'var(--text-primary)', fontSize: '1rem',
                                    fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer',
                                    fontFamily: 'inherit', transition: 'background 0.2s',
                                }}
                            >
                                {loading ? 'Entering...' : "Let's Begin! 🚀"}
                            </button>

                            <button
                                onClick={() => { setShowOnboardingGuide(false); setError(null); }}
                                style={{
                                    background: 'none', border: 'none',
                                    color: 'var(--text-muted)', fontSize: '0.85rem',
                                    cursor: 'pointer', marginTop: '1rem', fontFamily: 'inherit',
                                }}
                            >
                                ← Back to Backup
                            </button>
                        </>
                    ) : pendingIdentity?.mnemonic ? (
                        /* ===== SAFETY BACKUP (Step 3) ===== */
                        <>
                            <OnboardingStepper step={3} />
                            <h3 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.5rem' }}>🔑 Your Safety Backup</h3>
                            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '1rem', lineHeight: 1.5 }}>
                                Write these 12 words down on paper and keep them safe.
                                This is the <strong>only</strong> way to recover your identity if you lose this device.
                            </p>

                            <div style={{
                                display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
                                gap: '0.4rem', marginBottom: '1rem',
                            }}>
                                {pendingIdentity.mnemonic.map((word, i) => (
                                    <div key={i} style={{
                                        background: 'var(--bg-secondary, #1e293b)',
                                        borderRadius: 8, padding: '0.5rem 0.4rem',
                                        fontSize: '0.8rem', fontFamily: 'monospace',
                                        textAlign: 'center',
                                    }}>
                                        <span style={{ color: 'var(--text-muted)', fontSize: '0.65rem' }}>{i + 1}. </span>
                                        <strong>{word}</strong>
                                    </div>
                                ))}
                            </div>

                            <label htmlFor="seedConfirmed" style={{
                                display: 'flex', alignItems: 'center', gap: '0.5rem',
                                fontSize: '0.8rem', color: 'var(--text-muted)',
                                marginBottom: '1rem', cursor: 'pointer',
                            }}>
                                <input
                                    id="seedConfirmed"
                                    type="checkbox"
                                    checked={seedConfirmed}
                                    onChange={(e) => setSeedConfirmed(e.target.checked)}
                                    style={{ accentColor: '#2563eb' }}
                                />
                                I've written these words down somewhere safe
                            </label>

                            {error && (
                                <p style={{ color: '#ef4444', fontSize: '0.85rem', marginBottom: '1rem' }}>
                                    {error}
                                </p>
                            )}

                            <button
                                onClick={() => {
                                    setShowOnboardingGuide(true);
                                    setError(null);
                                }}
                                disabled={!seedConfirmed || loading}
                                style={{
                                    width: '100%', padding: '0.85rem', borderRadius: '10px',
                                    border: 'none',
                                    background: !seedConfirmed ? '#334155' : loading ? '#555' : '#2563eb',
                                    color: 'var(--text-primary)', fontSize: '1rem',
                                    fontWeight: 600, cursor: !seedConfirmed ? 'not-allowed' : 'pointer',
                                    fontFamily: 'inherit', transition: 'background 0.2s',
                                }}
                            >
                                Continue →
                            </button>

                            <button
                                onClick={() => {
                                    setShowAvatarSetup(true);
                                    setError(null);
                                }}
                                disabled={loading}
                                style={{
                                    background: 'none', border: 'none',
                                    color: 'var(--text-muted)', fontSize: '0.85rem',
                                    cursor: 'pointer', marginTop: '1rem', fontFamily: 'inherit',
                                }}
                            >
                                ← Back to Photo
                            </button>
                        </>
                    ) : showRecovery ? (
                        /* ===== RECOVERY FROM 12 WORDS ===== */
                        <>
                            <h3 style={{ fontSize: '1rem', marginBottom: '0.5rem', textAlign: 'left' }}>
                                🔑 Recover with 12 Words
                            </h3>
                            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '1rem', lineHeight: 1.5, textAlign: 'left' }}>
                                Enter the 12 recovery words you wrote down when you first joined.
                            </p>

                            <div style={{
                                display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
                                gap: '0.35rem', marginBottom: '1rem',
                            }}>
                                {recoveryWords.map((word, i) => (
                                    <input
                                        key={i}
                                        id={`recoveryWord-${i}`}
                                        aria-label={`Recovery word ${i + 1}`}
                                        type="text"
                                        value={word}
                                        onChange={(e) => {
                                            const updated = [...recoveryWords];
                                            updated[i] = e.target.value;
                                            setRecoveryWords(updated);
                                        }}
                                        placeholder={`${i + 1}`}
                                        autoCapitalize="none"
                                        autoCorrect="off"
                                        style={{
                                            padding: '0.45rem 0.3rem',
                                            borderRadius: 8,
                                            border: '1px solid var(--border-input, #334155)',
                                            background: 'var(--bg-secondary, #1e293b)',
                                            color: 'var(--text-primary)',
                                            fontSize: '0.75rem',
                                            fontFamily: 'monospace',
                                            textAlign: 'center',
                                            outline: 'none',
                                        }}
                                    />
                                ))}
                            </div>

                            <label htmlFor="recoveryCallsign" style={{
                                display: 'block', textAlign: 'left',
                                fontSize: '0.85rem', fontWeight: 600,
                                color: 'var(--text-secondary)', marginBottom: '0.5rem',
                            }}>
                                Your Callsign
                            </label>
                            <input
                                id="recoveryCallsign"
                                type="text"
                                value={recoveryCallsign}
                                onChange={(e) => setRecoveryCallsign(e.target.value)}
                                placeholder="Your callsign"
                                maxLength={32}
                                style={inputStyle}
                            />

                            {error && (
                                <p style={{ color: '#ef4444', fontSize: '0.85rem', marginBottom: '1rem' }}>
                                    {error}
                                </p>
                            )}

                            <button
                                onClick={handleRecover}
                                disabled={loading}
                                style={{
                                    width: '100%', padding: '0.85rem', borderRadius: '10px',
                                    border: 'none',
                                    background: loading ? '#555' : '#2563eb',
                                    color: 'var(--text-primary)', fontSize: '1rem',
                                    fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer',
                                    fontFamily: 'inherit', transition: 'background 0.2s',
                                }}
                            >
                                {loading ? 'Recovering...' : 'Recover Identity'}
                            </button>

                            <button
                                onClick={() => { setShowRecovery(false); setError(null); }}
                                style={{
                                    background: 'none', border: 'none',
                                    color: 'var(--text-muted)', fontSize: '0.85rem',
                                    cursor: 'pointer', marginTop: '1rem', fontFamily: 'inherit',
                                }}
                            >
                                ← Back
                            </button>
                        </>
                    ) : showNewUser ? (
                        /* ===== NEW USER SIGNUP + FAQs ===== */
                        <>
                            <OnboardingStepper step={1} />
                            <h3 style={{ fontSize: '1.05rem', fontWeight: 700, marginBottom: '0.35rem' }}>
                                🎟️ Join with Invite Code
                            </h3>
                            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '1.25rem', lineHeight: 1.5 }}>
                                Got an invite code or scanned a QR? Enter it below with your chosen callsign to join.
                            </p>

                            <label htmlFor="inviteCode" style={{
                                display: 'block', textAlign: 'left',
                                fontSize: '0.85rem', fontWeight: 600,
                                color: 'var(--text-secondary)', marginBottom: '0.5rem',
                            }}>
                                Invite Code
                            </label>
                            <input
                                id="inviteCode"
                                type="text"
                                value={inviteCode}
                                onChange={(e) => setInviteCode(formatInviteCode(e.target.value))}
                                placeholder="e.g. BP-7K3X-9M2W"
                                maxLength={800}
                                disabled={loading}
                                style={{
                                    ...inputStyle,
                                    fontFamily: 'monospace',
                                    letterSpacing: '1px',
                                    textAlign: 'center',
                                    fontSize: '1.1rem',
                                }}
                            />

                            <label htmlFor="callsign" style={{
                                display: 'block', textAlign: 'left',
                                fontSize: '0.85rem', fontWeight: 600,
                                color: 'var(--text-secondary)', marginBottom: '0.5rem',
                            }}>
                                Choose your Callsign
                            </label>
                            <input
                                id="callsign"
                                type="text"
                                value={callsign}
                                onChange={(e) => setCallsign(e.target.value)}
                                placeholder="e.g. Billinudgel-Marty"
                                maxLength={32}
                                disabled={loading}
                                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                                style={inputStyle}
                            />

                            {error && (
                                <p style={{ color: '#ef4444', fontSize: '0.85rem', marginBottom: '1rem' }}>
                                    {error}
                                </p>
                            )}

                            <button
                                onClick={handleCreate}
                                disabled={loading || callsign.trim().length < 2}
                                style={{
                                    width: '100%', padding: '0.85rem', borderRadius: '10px',
                                    border: 'none',
                                    background: loading ? '#555' : '#2563eb',
                                    color: 'var(--text-primary)', fontSize: '1rem',
                                    fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer',
                                    fontFamily: 'inherit', transition: 'background 0.2s',
                                }}
                            >
                                {loading ? 'Joining...' : inviteCode.trim()
                                    ? 'Join with Invite'
                                    : 'Create Self-Managed Identity'}
                            </button>

                            {/* ===== FAQs ===== */}
                            <div style={{ marginTop: '2rem', borderTop: '1px solid var(--border-primary, #333)', paddingTop: '1.25rem' }}>
                                <h4 style={{ fontSize: '0.9rem', fontWeight: 700, marginBottom: '0.75rem', color: 'var(--text-secondary)' }}>
                                    ❓ Frequently Asked Questions
                                </h4>
                                {FAQ_ITEMS.map((faq, i) => (
                                    <div
                                        key={i}
                                        style={{
                                            borderTop: i > 0 ? '1px solid var(--border-primary, #222)' : 'none',
                                            padding: '0.65rem 0',
                                        }}
                                    >
                                        <div
                                            role="button"
                                            tabIndex={0}
                                            aria-expanded={openFaq === i}
                                            onClick={() => setOpenFaq(openFaq === i ? null : i)}
                                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenFaq(openFaq === i ? null : i); } }}
                                            className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nature-500"
                                            style={{
                                                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                                cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600,
                                                color: 'var(--text-primary)',
                                                textAlign: 'left',
                                            }}
                                        >
                                            {faq.q}
                                            <span style={{
                                                fontSize: '0.7rem', color: 'var(--text-muted)',
                                                transition: 'transform 0.2s',
                                                transform: openFaq === i ? 'rotate(90deg)' : 'none',
                                                flexShrink: 0, marginLeft: '0.5rem',
                                            }}>▶</span>
                                        </div>
                                        {openFaq === i && (
                                            <p style={{
                                                fontSize: '0.78rem', color: 'var(--text-muted)',
                                                lineHeight: 1.5, marginTop: '0.4rem', textAlign: 'left',
                                            }}>
                                                {faq.a}
                                            </p>
                                        )}
                                    </div>
                                ))}
                            </div>

                            <button
                                onClick={() => { setShowNewUser(false); setError(null); }}
                                style={{
                                    background: 'none', border: 'none',
                                    color: 'var(--text-muted)', fontSize: '0.8rem',
                                    cursor: 'pointer', marginTop: '1rem', fontFamily: 'inherit',
                                }}
                            >
                                ← Back
                            </button>
                        </>
                    ) : (
                        /* ===== MAIN WELCOME — two simple choices ===== */
                        <>
                            {!showMemberOptions ? (
                                /* DEFAULT: Two clear choices */
                                <>
                                    <button
                                        onClick={() => setShowMemberOptions(true)}
                                        style={{
                                            width: '100%', padding: '1.1rem 1rem', borderRadius: '14px',
                                            border: 'none',
                                            background: 'linear-gradient(135deg, #2563eb, #1d4ed8)',
                                            color: '#fff', fontSize: '1.1rem', fontWeight: 700,
                                            cursor: 'pointer', fontFamily: 'inherit',
                                            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                                            marginBottom: '1rem',
                                            boxShadow: '0 4px 14px rgba(37,99,235,0.35)',
                                            transition: 'transform 0.15s',
                                        }}
                                        onMouseDown={(e) => (e.currentTarget.style.transform = 'scale(0.98)')}
                                        onMouseUp={(e) => (e.currentTarget.style.transform = 'scale(1)')}
                                        onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
                                    >
                                        I'm Already a Member →
                                    </button>

                                    <button
                                        onClick={() => setShowNewUser(true)}
                                        style={{
                                            width: '100%', padding: '0.9rem 1rem', borderRadius: '14px',
                                            border: '1px solid var(--border-primary, #333)',
                                            background: 'transparent',
                                            color: 'var(--text-muted)', fontSize: '0.95rem', fontWeight: 500,
                                            cursor: 'pointer', fontFamily: 'inherit',
                                            transition: 'transform 0.15s',
                                        }}
                                        onMouseDown={(e) => (e.currentTarget.style.transform = 'scale(0.98)')}
                                        onMouseUp={(e) => (e.currentTarget.style.transform = 'scale(1)')}
                                        onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
                                    >
                                        I'm New Here
                                    </button>
                                </>
                            ) : (
                                /* MEMBER SUB-OPTIONS */
                                <>
                                    <h3 style={{ fontSize: '1.05rem', fontWeight: 700, marginBottom: '0.35rem' }}>
                                        Sign in to your account
                                    </h3>
                                    <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '1.25rem', lineHeight: 1.5 }}>
                                        Choose how to restore your identity on this device:
                                    </p>



                                    <button
                                        onClick={() => { setShowRecovery(true); setError(null); }}
                                        style={{
                                            width: '100%', padding: '1rem 1rem', borderRadius: '14px',
                                            border: '1px solid #f59e0b66',
                                            background: 'linear-gradient(135deg, rgba(245,158,11,0.2), rgba(245,158,11,0.06))',
                                            color: '#fcd171', fontSize: '1.05rem', fontWeight: 700,
                                            cursor: 'pointer', fontFamily: 'inherit',
                                            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.6rem',
                                            transition: 'transform 0.15s',
                                        }}
                                        onMouseDown={(e) => (e.currentTarget.style.transform = 'scale(0.98)')}
                                        onMouseUp={(e) => (e.currentTarget.style.transform = 'scale(1)')}
                                        onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
                                    >
                                        🔑 Recover with 12 Words
                                    </button>

                                    <button
                                        onClick={() => setShowMemberOptions(false)}
                                        style={{
                                            background: 'none', border: 'none',
                                            color: 'var(--text-muted)', fontSize: '0.8rem',
                                            cursor: 'pointer', marginTop: '1rem', fontFamily: 'inherit',
                                        }}
                                    >
                                        ← Back
                                    </button>
                                </>
                            )}
                        </>
                    )}
                </div>
                <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '1.25rem', lineHeight: 1.4, opacity: 0.8 }}>
                    BeanPool is a decentralized, peer-to-peer network. You are responsible for your own local tax compliance. By continuing, you agree to our <a href="https://beanpool.org/terms" target="_blank" rel="noopener noreferrer" style={{ color: '#3b82f6', textDecoration: 'underline' }}>Terms of Service</a> and <a href="https://beanpool.org/privacy" target="_blank" rel="noopener noreferrer" style={{ color: '#3b82f6', textDecoration: 'underline' }}>Privacy Policy</a>.
                </p>
            </div>
        </div>
    );
}
