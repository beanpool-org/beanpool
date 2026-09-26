/**
 * WelcomePage — First-run identity bootstrap with invite code
 *
 * New users:  Enter invite code + callsign → create → show seed phrase → joined
 * Existing:   Import identity from another device
 * Recovery:   Enter 12-word phrase to recover identity
 * Open door:  On a node whose door is open (the global community), no invite: a name and one sign-in
 *             (components/WebJoin.tsx), then the same photo, 12 words and tour
 * Sign-in:    There, an account comes back with the sign-in it joined with (components/WebRestore.tsx, G11-d)
 */

import React, { useState, useRef, useEffect, useId } from 'react';
import {
    checkIdentitySave, clearUnsentPendingJoin, completeInviteSent, createIdentityFromMnemonic, generateIdentity, identityFromMnemonic,
    importIdentity, loadInviteSent, markInviteSent, releaseInviteSent, settleRefusedInviteSend, updateCallsign, getMnemonic, hasMnemonic,
    loadPendingJoin, loadPendingRestore, pendingJoinSent, seedViewedKey, IdentityHeldError, InviteSentHeldError, SentJoinWaitingError,
    INVITE_SEND_CAN_LAND_MS, type BeanPoolIdentity, type JoinProvider, type SaveIdentityOptions,
} from '../lib/identity';
import { validateMnemonic } from '../lib/mnemonic';

import {
    redeemInvite, redeemOfflineTicket, registerMember, updateMemberProfile, checkMembership,
    recordOnboardingEvent, initPairingApi, pollPairingApi, cancelPairingApi, getNodeApiUrl,
    getCommunityInfo, isRouteMissing,
} from '../lib/api';
import { WebJoin, type JoinedResult } from '../components/WebJoin';
import { WebRestore } from '../components/WebRestore';
import { askPersistentStorage, captureAuthReturn, checkMembershipWithKey, probeMembership, providerLabel } from '../lib/web-join';
import { resolveAvatarUrl } from '../lib/avatar';
import { QRCodeSVG } from 'qrcode.react';
import { createPairingSession, decryptPairingPayload } from '@beanpool/core';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

const QRCodeSVGComponent: React.FC<any> = QRCodeSVG as any;

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

/** What an invite-sent record keeps of the code or ticket a key went with: its SHA-256, never the code itself. */
function inviteHash(code: string): string {
    return bytesToHex(sha256(utf8ToBytes(code)));
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

/**
 * Four equal columns that may shrink, with labels that wrap. The old row gave each step a fixed
 * 4.5rem with unwrappable labels — 18rem plus connectors, which at 1.3x text pushed the first
 * screen a new member sees out to 376px on a 320px phone.
 */
export function OnboardingStepper({ step, firstLabel = 'Your Name' }: { step: 1 | 2 | 3 | 4; firstLabel?: string }) {
    const steps = [firstLabel, 'Your Photo', 'Safety Backup', 'How it Works'];
    return (
        <div data-testid="onboarding-stepper" style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))`,
            columnGap: '2px',
            marginBottom: '1.5rem',
            width: '100%',
        }}>
            {steps.map((label, i) => {
                const stepNum = i + 1;
                const isActive = stepNum === step;
                const isCompleted = stepNum < step;
                return (
                    <div key={i} style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        position: 'relative',
                        minWidth: 0,
                    }}>
                        {i > 0 && (
                            // Connector from the previous step's dot to this one's, 4px clear of each.
                            <div aria-hidden="true" style={{
                                position: 'absolute',
                                top: '5px',
                                right: 'calc(50% + 10px)',
                                width: 'calc(100% - 18px)',
                                height: '2px',
                                backgroundColor: isCompleted || isActive ? '#22c55e' : '#e5e7eb',
                            }} />
                        )}
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
                            lineHeight: 1.2,
                            color: isActive ? 'var(--text-primary)' : '#6b7280',
                            fontWeight: isActive ? '700' : '500',
                            transition: 'color 0.3s',
                            whiteSpace: 'normal',
                            overflowWrap: 'anywhere',
                            textAlign: 'center',
                            maxWidth: '100%',
                        }}>
                            {label}
                        </span>
                    </div>
                );
            })}
        </div>
    );
}

/**
 * Whether this node takes members without an invite, from `/api/community/info` (a public read): `open` only when it
 * says so (the global profile with its door open); `invite` for every other answer, an older node's included, which
 * is today's page unchanged; `unreachable` when there was no answer at all.
 */
type Door = 'checking' | 'open' | 'invite' | 'unreachable';

export function WelcomePage({ onComplete }: Props) {
    // A sign-in coming back to this page: read and taken out of the address bar before anything else runs.
    const [authReturn] = useState(() => captureAuthReturn());
    const [door, setDoor] = useState<Door>('checking');
    const [doorCheck, setDoorCheck] = useState(0);
    useEffect(() => {
        let cancelled = false;
        setDoor('checking');
        getCommunityInfo()
            .then((info) => { if (!cancelled) setDoor(info?.profile === 'global' && info.features?.openJoin === true ? 'open' : 'invite'); })
            .catch((e) => { if (!cancelled) setDoor(isRouteMissing(e) ? 'invite' : 'unreachable'); });
        return () => { cancelled = true; };
    }, [doorCheck]);
    // Joined through the open door: the member exists on the node, so the steps after it have nothing to redeem, and
    // there is no going back to a name screen.
    const [joinedByDoor, setJoinedByDoor] = useState(false);
    const [joinedAsNote, setJoinedAsNote] = useState<string | null>(null);
    // The sign-in the door join also enrolled as this account's way back (G11-c), when the node stored the copy.
    const [signInRecovery, setSignInRecovery] = useState<JoinProvider | null>(null);
    // A key restored here (phone or 12 words) that is not a member of this open community yet: it joins as it is. Also
    // a member's key, while a join that went out from this browser is settled first (below).
    const [restoredForDoor, setRestoredForDoor] = useState<BeanPoolIdentity | null>(null);
    const doorOpen = door === 'open';
    // WebJoin for joining (not only for settling a sent join, below).
    const webJoinForDoor = doorOpen || !!restoredForDoor || (!!authReturn && door !== 'invite');

    /*
     * Getting an account back with a sign-in (G11-d, components/WebRestore.tsx): shown when the member asks for it on
     * the open door's screens (`signInRestore`, with the sign-in they just tried, if any), and when a sign-in comes back
     * whose `state` is the nonce a restore went with (`restoreReturn`). Any other return is the join's, as before.
     */
    const [signInRestore, setSignInRestore] = useState<{ provider: JoinProvider | null } | null>(null);
    const [restoreReturn, setRestoreReturn] = useState<'checking' | 'none' | 'restore'>(() => (authReturn ? 'checking' : 'none'));
    useEffect(() => {
        if (!authReturn) return;
        let cancelled = false;
        loadPendingRestore()
            .then((r) => { if (!cancelled) setRestoreReturn(r && !!authReturn.state && r.nonce === authReturn.state ? 'restore' : 'none'); })
            .catch((e) => {
                console.warn('[Welcome] could not read a pending restore:', e);
                if (!cancelled) setRestoreReturn('none');
            });
        return () => { cancelled = true; };
    }, [authReturn]);

    /*
     * A join that went out from this browser is settled wherever the page lands, the door open or shut (#1154 follow-up,
     * review 4106962311). While a sent pending join is stored, WebJoin is shown whatever the door says, and asks the node
     * about it (the membership probe, which the door doesn't gate): a member is in. With the door open it carries on as
     * ever. With the door shut, or a kept invite key waiting behind it (4112213080), it only settles (`settleOnly`): a
     * join that may still land is waited for, and one the node says never landed and can no longer land hands the page
     * back (`settledNotLanded`), its key kept as it is. And
     * nothing here writes an identity (an invite, a restore) while such a join is unsettled: every save carries
     * `sentJoinGuard()`.
     */
    const [sentJoin, setSentJoin] = useState<'checking' | 'none' | 'settle'>('checking');
    const settledNotLanded = useRef<{ publicKey: string; sentAt: number } | null>(null);
    useEffect(() => {
        let cancelled = false;
        loadPendingJoin()
            .then((p) => { if (!cancelled) setSentJoin(p && pendingJoinSent(p) ? 'settle' : 'none'); })
            .catch((e) => {
                // Unreadable: every write below reads it again first, and fails the same way rather than going ahead.
                console.warn('[Welcome] could not read a pending join:', e);
                if (!cancelled) setSentJoin('none');
            });
        return () => { cancelled = true; };
    }, []);

    /**
     * What every identity save here carries: refused (SentJoinWaitingError) while a join that went out from this browser
     * waits to be settled, unless it is the one the node has said never landed and can no longer land. identity.ts
     * decides it on the store as it is, in the transaction that writes the identity, so another tab can't send a join
     * between the check and the write (#1171's deciding pass).
     */
    function sentJoinGuard(): SaveIdentityOptions {
        return { refuseWhileSentJoinWaits: { except: settledNotLanded.current } };
    }

    /** Hand the page to WebJoin to settle the sent join first; the member comes back here once it is. */
    function settleSentJoinFirst() {
        setShowRecovery(false);
        setShowQrPairing(false);
        setError(null);
        setSentJoin('settle');
    }

    function handleSettled(cleared: { publicKey: string; sentAt: number } | null) {
        settledNotLanded.current = cleared;
        setSentJoin('none');
        // A key an invite went with is asked about next (settleSentInvite): nothing is offered until it has been.
        checkSentInviteAgain();
    }

    /*
     * One browser, one account (review 4106962020): identity.ts refuses to write a different key over the one stored.
     * Another tab can save one while this page is open; then nothing here replaces it, and the page offers to open it.
     */
    const [heldIdentity, setHeldIdentity] = useState<BeanPoolIdentity | null>(null);
    /*
     * With it, a key an invite sent from this page when the node may have it as a member (4111871903): it is still in
     * its slot on disk, and the held screen offers its 12 words, as WebJoin's 'taken' screen does. `joined`: the node
     * said yes to it.
     */
    const [heldSentKey, setHeldSentKey] = useState<{ identity: BeanPoolIdentity; joined: boolean } | null>(null);
    const [showHeldWords, setShowHeldWords] = useState(false);
    const heldWordsId = useId();

    function showHeld(held: BeanPoolIdentity, sent: { identity: BeanPoolIdentity; joined: boolean } | null) {
        setHeldSentKey(sent);
        setShowHeldWords(false);
        setHeldIdentity(held);
    }

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

    const [pendingIdentity, setPendingIdentity] = useState<BeanPoolIdentity | null>(null);
    // An invite join's new key, until the node takes the invite. It is never saved as the identity before then
    // (handleCreate); once a redeem goes with it, it is also on disk in the invite-sent slot, which loadIdentity never reads.
    const inviteKey = useRef<BeanPoolIdentity | null>(null);

    /*
     * A key an invite was sent with, kept on disk from before its redeem went (identity.ts InviteSent, deciding pass
     * 4111943146). The node may have taken it while the answer was lost, and the tab been reloaded or discarded since.
     * Every load of this page asks the node about it, signed by that key, once any sent door join is settled:
     *   - a member: saved through the guarded write, then the photo and its 12 words;
     *   - not a member, with no send that can still land: let go, and the invite form starts afresh;
     *   - not a member yet, while a send could still land: kept ('waiting'), and the invite form's next try sends that
     *     same key. On the open door there is no invite form: "Finish joining" waits for it with Retry, and the door's
     *     lobby comes once the key is settled, so a door join never makes a second key beside it (4112075367);
     *   - no answer: "Finish joining" with Retry. Never the invite form, whose pre-flight would call the code used.
     * The open door's lobby is shown only once this is 'none', whatever the door says. 'kept': a record is on disk and
     * not asked about yet, because a sent door join is settled first; that join is then only settled, never offered
     * again, so it hands the page back and this key is asked about next (4112213080).
     */
    type SentInviteView = 'checking' | 'none' | 'kept' | { stuck: 'unreachable' | 'unsaved' | 'waiting'; name: string; busy: boolean; again: boolean };
    const [sentInvite, setSentInvite] = useState<SentInviteView>('checking');
    const [sentInviteCheck, setSentInviteCheck] = useState(0);
    useEffect(() => {
        let cancelled = false;
        // Read from the first render, beside the pending join, so a browser with none shows its page as soon as before.
        void settleSentInvite(() => cancelled, sentJoin === 'none');
        return () => { cancelled = true; };
        // settleSentInvite reads refs and state setters only.
    }, [sentJoin, sentInviteCheck]);

    /** Ask about the kept key again. It shows "One moment…" in the same render, so the form never flashes up first. */
    function checkSentInviteAgain() {
        setSentInvite((v) => (typeof v === 'object' ? { ...v, busy: true } : 'checking'));
        setSentInviteCheck((n) => n + 1);
    }

    function stuckOnSentInvite(stuck: 'unreachable' | 'unsaved' | 'waiting', name: string) {
        setSentInvite((v) => ({ stuck, name, busy: false, again: typeof v === 'object' && v.stuck === stuck }));
    }

    /** `mayAsk`: no sent door join waits to be settled first. Until then a record found is only waited on. */
    async function settleSentInvite(cancelled: () => boolean, mayAsk: boolean) {
        let record;
        try {
            record = await loadInviteSent();
        } catch (e) {
            // Unreadable: an invite's own write reads it again first, and fails the same way rather than going ahead.
            console.warn('[Welcome] could not read a sent invite:', e);
            if (!cancelled()) setSentInvite('none');
            return;
        }
        if (cancelled()) return;
        if (!record) {
            setSentInvite('none');
            return;
        }
        if (!mayAsk) {
            setSentInvite('kept');
            return;
        }
        const kept = record.identity;
        const probe = await probeMembership(kept);
        if (cancelled()) return;
        if (probe.kind === 'member') {
            const member = { ...kept, callsign: probe.callsign || kept.callsign };
            try {
                await completeInviteSent(member, sentJoinGuard());
            } catch (e) {
                if (cancelled()) return;
                if (e instanceof SentJoinWaitingError) {
                    // A join that went out from this browser is settled first; this key stays on disk, and is asked
                    // about again once it is.
                    setSentInvite('kept');
                    settleSentJoinFirst();
                    return;
                }
                setSentInvite('none');
                if (e instanceof IdentityHeldError) {
                    showHeld(e.held, { identity: member, joined: true });
                    return;
                }
                console.error('[Welcome] a member key from an invite could not be saved:', e);
                stuckOnSentInvite('unsaved', member.callsign);
                return;
            }
            if (cancelled()) return;
            enterAsInvited(member);
            setSentInvite('none');
            return;
        }
        if (probe.kind === 'not_member') {
            const released = await releaseInviteSent(probe.answer).catch((e) => {
                console.warn('[Welcome] a sent invite key not let go:', e);
                return false;
            });
            if (cancelled()) return;
            if (!released) {
                // A send with it could still land: the next try sends this same key, and a pre-flight that calls the
                // code used doesn't stop it (handleCreate). Kept in sight: on the open door it is waited for.
                inviteKey.current = kept;
                setCallsign((typed) => typed || kept.callsign);
                stuckOnSentInvite('waiting', kept.callsign);
                return;
            }
            setSentInvite('none');
            return;
        }
        stuckOnSentInvite('unreachable', kept.callsign);
    }

    function retrySentInvite() {
        if (typeof sentInvite !== 'object' || sentInvite.busy) return;
        if (door === 'unreachable') setDoorCheck((n) => n + 1);
        checkSentInviteAgain();
    }

    /** An invite's key the node has as a member, now saved here: on to the photo, then its 12 words. */
    function enterAsInvited(member: BeanPoolIdentity) {
        inviteKey.current = null;
        setPendingIdentity(member);
        // Redeemed already, so the final step has nothing left to redeem.
        setInviteRedeemed(true);
        setShowAvatarSetup(true);
        setError(null);
    }

    // The words for the backup step. Read through the accessor and held in state, because
    // that read becomes a vault read in Phase C and a render cannot await.
    //
    // Note the three guards on this page use hasMnemonic() rather than this: they ask "is
    // there an identity mid-onboarding", not "what are the words". Routing them through the
    // async read would give each a null first frame and flash the wrong onboarding step.
    const [pendingWords, setPendingWords] = useState<string[] | null>(null);
    useEffect(() => {
        let cancelled = false;
        getMnemonic(pendingIdentity).then(w => { if (!cancelled) setPendingWords(w); });
        return () => { cancelled = true; };
    }, [pendingIdentity]);
    const [seedConfirmed, setSeedConfirmed] = useState(false);
    const [pendingInviteCode, setPendingInviteCode] = useState('');
    // Whether this identity's invite has already been redeemed on the node. In-memory only,
    // unlike native's persisted flag, because this wizard has no resume-after-reload path:
    // a reload loses pendingIdentity, and the root then routes on the stored identity rather
    // than re-entering the wizard. If a resume path is ever added, this needs persisting too.
    const [inviteRedeemed, setInviteRedeemed] = useState(false);
    const [showOnboardingGuide, setShowOnboardingGuide] = useState(false);
    const [showNewUser, setShowNewUser] = useState(() => true);
    const [showMemberOptions, setShowMemberOptions] = useState(false);
    const [openFaq, setOpenFaq] = useState<number | null>(null);

    const [showAvatarSetup, setShowAvatarSetup] = useState(false);

    // QR Device Pairing states (#89)
    const [showQrPairing, setShowQrPairing] = useState(false);
    const [pairingSession, setPairingSession] = useState<{ sessionId: string; privateKeyHex: string; publicKeyHex: string } | null>(null);
    const [pairingSecondsLeft, setPairingSecondsLeft] = useState(120);
    const [pairingStatus, setPairingStatus] = useState<'idle' | 'waiting' | 'decrypting' | 'success' | 'expired'>('idle');

    async function handleStartQrPairing() {
        setLoading(true);
        setError(null);
        try {
            const session = createPairingSession();
            setPairingSession(session);
            setPairingSecondsLeft(120);
            await initPairingApi(session.sessionId, session.publicKeyHex);
            setPairingStatus('waiting');
            setShowQrPairing(true);
        } catch (err: any) {
            console.error('[Pairing] Init error:', err);
            setError(err.message || 'Failed to initialize device pairing on node relay');
            setPairingStatus('idle');
            setShowQrPairing(false);
            setPairingSession(null);
        } finally {
            setLoading(false);
        }
    }

    // QR pairing countdown & response poller
    useEffect(() => {
        if (!showQrPairing || !pairingSession || pairingStatus !== 'waiting') return;

        const timer = setInterval(() => {
            setPairingSecondsLeft((prev) => {
                const next = prev - 1;
                if (next <= 0) {
                    clearInterval(timer);
                    clearInterval(poller);
                    setPairingStatus('expired');
                    return 0;
                }
                return next;
            });
        }, 1000);

        const poller = setInterval(async () => {
            try {
                const res = await pollPairingApi(pairingSession.sessionId);
                if (res.status === 'transferred' && res.payload) {
                    clearInterval(timer);
                    clearInterval(poller);
                    setPairingStatus('decrypting');

                    try {
                        const decrypted = decryptPairingPayload<BeanPoolIdentity>(
                            res.payload.ciphertextHex,
                            res.payload.nonceHex,
                            res.payload.mobilePubHex,
                            pairingSession.privateKeyHex,
                            pairingSession.sessionId
                        );

                        if (!decrypted.publicKey || !decrypted.privateKey || !decrypted.callsign) {
                            throw new Error('Received incomplete identity payload');
                        }

                        if (doorOpen) {
                            setPairingStatus('success');
                            await finishRestoreAtDoor(decrypted);
                            return;
                        }
                        await importIdentity(decrypted, sentJoinGuard());
                        setPairingStatus('success');
                        setTimeout(() => {
                            onComplete(decrypted);
                        }, 600);
                    } catch (decryptErr: any) {
                        if (decryptErr instanceof SentJoinWaitingError) {
                            // Not while a join that went out from this browser is unsettled: that one is asked about first.
                            setPairingStatus('idle');
                            settleSentJoinFirst();
                            return;
                        }
                        if (decryptErr instanceof IdentityHeldError) {
                            setPairingStatus('idle');
                            setShowQrPairing(false);
                            setHeldIdentity(decryptErr.held);
                            return;
                        }
                        console.error('[Pairing] Decryption/import failure:', decryptErr);
                        setError(decryptErr.message || 'Failed to decrypt paired identity');
                        setPairingStatus('expired');
                    }
                } else if (res.status === 'expired') {
                    clearInterval(timer);
                    clearInterval(poller);
                    setPairingStatus('expired');
                }
            } catch (err: any) {
                console.error('[Pairing] Error during poll:', err);
            }
        }, 1500);

        return () => {
            clearInterval(timer);
            clearInterval(poller);
        };
        // finishRestoreAtDoor reads only state that is fixed while the QR is up.
    }, [showQrPairing, pairingSession, pairingStatus, onComplete, doorOpen]);

    // Count the backup step being drawn. The ref holds it to once per mount;
    // recordOnboardingEvent holds it to once per person per node, which is what a reload or
    // a reopened tab part way through a join needs.
    //
    // The keeper-count variant is gone. It was hard-coded 'C' on every signup here, states A
    // and B never became reachable, keeper recovery has been removed, and the panel that
    // showed those states is gone with it — so it was recording one constant forever.
    const protectionShownRef = useRef(false);
    useEffect(() => {
        const onBackupStep = hasMnemonic(pendingIdentity) && !showAvatarSetup && !showOnboardingGuide;
        if (!onBackupStep || protectionShownRef.current) return;
        protectionShownRef.current = true;
        recordOnboardingEvent('protection_shown');
    }, [pendingIdentity, showAvatarSetup, showOnboardingGuide]);
    const [pendingAvatar, setPendingAvatar] = useState<string | null>(null);

    const fileInputRef = useRef<HTMLInputElement>(null);
    const cameraInputRef = useRef<HTMLInputElement>(null);


    // Cut the PWA out of the invite flow: an invite link only reaches the web
    // PWA via the trampoline's explicit "continue in browser" escape hatch,
    // which appends ?webjoin=1. Any OTHER arrival at /app?invite= (a stray or
    // bookmarked link) is bounced to the install trampoline, so the PWA never
    // silently redeems and burns a single-use code meant for the native app.
    React.useEffect(() => {
        const sp = new URLSearchParams(window.location.search);
        const invite = sp.get('invite');
        if (invite && !sp.get('webjoin')) {
            window.location.replace('/?invite=' + encodeURIComponent(invite));
        }
    }, []);


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

        // The node said yes to this page's key, so it is a member whatever happens next.
        let taken = false;
        try {
            // A key an invite went with from this browser, not this page's (another tab's, or one this page hasn't
            // asked about): settled first, before a pre-flight could call the code it used "already used" (deciding
            // pass 4111943146). markInviteSent below refuses the same case again, in its own transaction.
            const kept = await loadInviteSent();
            if (kept && kept.identity.publicKey !== inviteKey.current?.publicKey) {
                setLoading(false);
                checkSentInviteAgain();
                return;
            }

            // Pre-flight the invite BEFORE creating an identity — a dud code
            // should fail here, not after the seed ceremony. A null result
            // (older node) fails open; redeem stays the definitive check.
            const { checkInvite } = await import('../lib/api');
            const check = await checkInvite(trimmedCode);
            // "Used" on a retry may mean used by the key an earlier try sent: the node took it and the answer was lost.
            // The redeem answers a member's key before it looks at the code as used, so that retry goes on to it and
            // the key is saved (review 4111871900). Used by another key, the redeem refuses it and nothing is saved.
            const usedMaybeByThisKey = check?.reason === 'used' && inviteKey.current !== null;
            if (check && !check.valid && !usedMaybeByThisKey) {
                setError(check.reason === 'used'
                    ? 'This invite has already been used — each one works exactly once. Ask whoever invited you for a fresh one.'
                    : check.reason === 'expired'
                        ? 'This invite has expired — invites last 30 days. Ask whoever invited you for a fresh one.'
                        : "That invite wasn't recognised. Double-check the code, or ask whoever invited you for a fresh one.");
                setLoading(false);
                return;
            }

            // The key is made on the first try and is not saved as the identity until the node takes the invite (review
            // 4108355836): a code the node refuses, or an answer that never comes, leaves nothing here for the app to
            // open. A retry sends the same key, so an invite the node took while its answer was lost is answered
            // "already a member", and the key is saved then.
            const identity = inviteKey.current
                ? { ...inviteKey.current, callsign: trimmedCallsign }
                : await generateIdentity(trimmedCallsign);
            inviteKey.current = identity;
            // Nothing is spent on a key this browser couldn't keep: another account saved here, or a join that went out
            // from this browser and waits to be settled (asked about first). The save below decides it again.
            await checkIdentitySave(identity, sentJoinGuard());

            // On disk before it goes, in a slot of its own that loadIdentity never reads (deciding pass 4111943146).
            // The node may take this key while its answer is lost, and a reload or a discarded tab must not lose a
            // member's only key: the next load asks the node about it (settleSentInvite). Refused when another key an
            // invite went with is kept there, or a door join that went out waits, decided in the same transaction:
            // either is settled first, so no two keys from here go out at once (4112075367).
            const sentAt = Date.now();
            await markInviteSent(identity, inviteHash(trimmedCode), sentAt, sentJoinGuard());

            // Redeem invite immediately so user is registered on node right away. Signed with the key it names, which
            // is not this browser's identity yet.
            let joined = identity;
            try {
                const { redeemInvite, redeemOfflineTicket } = await import('../lib/api');
                if (trimmedCode.length > 20 && trimmedCode.startsWith('BP-')) {
                    const ticketB64 = trimmedCode.slice(3);
                    await redeemOfflineTicket(ticketB64, identity.publicKey, identity.callsign, identity);
                } else {
                    await redeemInvite(trimmedCode, identity.publicKey, identity.callsign, identity);
                }
            } catch (redeemErr: any) {
                // Only a node saying this key is a member already goes on (an older node says it this way; today's
                // answers that with a success). "Already been used" does not: the node answers a key that is a member
                // before it looks at the code, so that one means another key used it, and this key is not a member.
                if (!redeemErr?.message?.includes('already a member')) {
                    const status = redeemErr?.status;
                    // The redeem routes' refusal. A 400 is not taken on its word as "this send made no member": an older
                    // node answered a ticket's fault after registration with one (engine/invites.ts, 4112075324). The node
                    // is asked, signed by this key. The 400 came after its handler finished, so the answer is final for
                    // this send: a member goes on as a yes does; not a member lets the kept key go (unless an earlier send
                    // with it is unsettled); no answer keeps it, as a lost answer's is. In memory for the next try either way.
                    const probe = status === 400 ? await probeMembership(identity) : null;
                    if (probe?.kind === 'member') {
                        joined = { ...identity, callsign: probe.callsign || identity.callsign };
                    } else {
                        if (probe?.kind === 'not_member') {
                            const left = await settleRefusedInviteSend(probe.answer, sentAt)
                                .catch((e) => {
                                    console.warn('[Welcome] a refused invite key not let go:', e);
                                    return undefined;
                                });
                            if (left === null) setSentInvite('none');
                        }
                        setError(typeof status === 'number' && status < 500 && redeemErr.message
                            ? redeemErr.message
                            : "Can't reach the community right now. Try again in a minute.");
                        setLoading(false);
                        return;
                    }
                }
            }
            taken = true;
            // The node has this member: now the key is saved, through the guarded write, and its invite-sent record
            // goes in the same transaction.
            await completeInviteSent(joined, sentJoinGuard());
            setSentInvite('none');
            setPendingInviteCode(trimmedCode);
            enterAsInvited(joined);
            setLoading(false);
        } catch (err) {
            setLoading(false);
            if (err instanceof InviteSentHeldError) {
                // Another key an invite went with is kept on disk, unsettled (another tab's, or this browser's before a
                // reload). Nothing was sent: that one is asked about first, and the next try sends it if it may land.
                checkSentInviteAgain();
                return;
            }
            if (err instanceof SentJoinWaitingError) {
                // A join that went out from this browser is asked about first. This page's key stays for the next try:
                // in memory, and on disk if it was sent.
                settleSentJoinFirst();
                return;
            }
            if (err instanceof IdentityHeldError) {
                // Another tab saved an account here meanwhile, and it stays. If this page's key was sent, it is still in
                // its slot on disk and may be a member (4111871903): the held screen offers its 12 words.
                const kept = await loadInviteSent().catch(() => null);
                const mine = kept && kept.identity.publicKey === inviteKey.current?.publicKey ? kept.identity : null;
                showHeld(err.held, mine ? { identity: mine, joined: taken } : null);
                return;
            }
            setError('Failed to generate identity. Please try again.');
            console.error(err);
        }
    }

    /**
     * "← Back" on the photo step after an invite (the open door has none). By then the key is saved here and the node
     * has taken the invite for it. Going back leaves both as they are and forgets them on this page only, so the name
     * form's next try makes a new key, which the saved one refuses (IdentityHeldError: "This browser already has an
     * account"). What Back should do instead is an open product call (board card invite-back-step): this is its seam.
     */
    function backFromPhotoStep() {
        setPendingIdentity(null);
        setPendingAvatar(null);
        // Going back discards the identity, so what was redeemed
        // no longer describes what is about to be submitted.
        setInviteRedeemed(false);
        setShowAvatarSetup(false);
        setError(null);
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
            // Wraps the whole thing, rather than being folded into the first condition.
            //
            // The two inner branches are "redeem a code" and "register without one", and
            // they are alternatives to each other — not to being already registered. Adding
            // `&& !inviteRedeemed` to the outer `if` instead sent the normal path, an
            // invited member whose code was redeemed at Step 1, down the else and into
            // registerMember(), which is the no-invite path: a wasted request at best, and
            // at worst an error that returns early and strands somebody on the last screen
            // of a join they had already completed.
            //
            // Skipped entirely once Step 1 has redeemed, which is the normal path —
            // redemption moved there so a member exists on the node from the moment they
            // pick a name. Re-sending the code here doubled the invite attempts in the
            // funnel and spent a round trip at the tap where somebody is waiting to get in.
            if (!inviteRedeemed) {
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
                        // Already-redeemed is not a failure here. Step 1 treats it as
                        // success and carries on; this step used to strand the user on an
                        // error instead, so a code that had in fact been redeemed — by a
                        // Step 1 that ran before this flag existed, or by the same person
                        // retrying — blocked the join it had already completed. The two
                        // steps now agree about what "already a member" means.
                        const alreadyIn = err?.message?.includes('already a member')
                            || err?.message?.includes('already been used');
                        if (!alreadyIn) {
                            setError(err.message || 'Invalid invite code');
                            setLoading(false);
                            return;
                        }
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
            
            // Counted here, after registration has actually landed, rather than on the tap
            // that started it. Both branches above bail out early with an error, so counting
            // on the tap booked a completion for people who never got in — and booked it
            // again each time they retried.
            recordOnboardingEvent('guide_complete');

            // Onboarding complete — explicitly ask for location once
            if ('geolocation' in navigator) {
                navigator.geolocation.getCurrentPosition(() => {}, () => {});
            }
            // A browser member's key lives only in this site's storage: ask the browser to keep it (design G11 §4.2).
            // Nothing waits on the answer, and the words warning stays either way.
            if (joinedByDoor) void askPersistentStorage();
            onComplete(pendingIdentity);
        } finally {
            setLoading(false);
        }
    }

    /**
     * The open door took this browser in: the node has the member and the identity is saved (WebJoin). A key restored
     * here has an account already, so it goes straight in; a new one gets the steps every new member has.
     */
    function handleJoined(joined: JoinedResult) {
        setRestoredForDoor(null);
        if (joined.restored) {
            onComplete(joined.identity);
            return;
        }
        setJoinedByDoor(true);
        setSignInRecovery(joined.recovery?.enrolled ? joined.recovery.provider : null);
        setInviteRedeemed(true);
        setJoinedAsNote(joined.earlierJoinKept
            // A key was brought here, but the join this browser sent earlier had landed: that one is the account.
            ? `This browser had already joined as ${joined.identity.callsign}, so that's your account here, not the one you brought. Its 12 words come next.`
            : joined.requestedCallsign
                ? `You're ${joined.identity.callsign} here: ${joined.requestedCallsign} was taken. You can change it in Settings.`
                : null);
        setPendingIdentity(joined.identity);
        setShowAvatarSetup(true);
        setError(null);
    }

    /**
     * A key restored here (the phone's QR or the 12 words) on a node whose door is open. A member of this community
     * goes in, as anywhere; one that is not goes through the door with the same key, never a new one (design G11 §2,
     * screen 1). Nothing is saved until the node has said which: asked with the key itself, which is not stored yet.
     */
    async function finishRestoreAtDoor(identity: BeanPoolIdentity): Promise<boolean> {
        setError(null);
        let membership: { isMember: boolean; callsign: string | null };
        try {
            membership = await checkMembershipWithKey(identity);
        } catch {
            setShowQrPairing(false);
            setError("Can't reach the community right now. Try again in a minute.");
            return false;
        }
        if (membership.isMember) {
            const member = { ...identity, callsign: membership.callsign || identity.callsign };
            try {
                await importIdentity(member, sentJoinGuard());
            } catch (e) {
                if (e instanceof SentJoinWaitingError) {
                    // A join that went out from this browser comes first (review 4106962311): the node may have that key
                    // as a member, and this browser its only copy. WebJoin asks about it with this key waiting, says what
                    // it found, and lets the member choose once that join can no longer land.
                    setShowQrPairing(false);
                    setShowRecovery(false);
                    setRestoredForDoor(member);
                    return true;
                }
                if (!(e instanceof IdentityHeldError)) throw e;
                setShowQrPairing(false);
                setShowRecovery(false);
                setHeldIdentity(e.held);
                return true;
            }
            // A join started here and never sent is not needed now. One that went out stays (identity.ts
            // pendingJoinSent): the node may have that key as a member, and this browser its only copy.
            await clearUnsentPendingJoin().catch((e) => console.warn('[Welcome] leftover pending join not cleared:', e));
            if ('geolocation' in navigator) {
                navigator.geolocation.getCurrentPosition(() => {}, () => {});
            }
            onComplete(member);
            return true;
        }
        setShowQrPairing(false);
        setShowRecovery(false);
        setRestoredForDoor(identity);
        return true;
    }

    /**
     * An account brought back with a sign-in (WebRestore), already checked to be the one its name belongs to. It goes
     * the way a key restored with the 12 words does (finishRestoreAtDoor): the node is asked first, a join this browser
     * sent is settled first, and it is saved only through the guarded write, which never replaces another account.
     * False when the node could not be asked: WebRestore keeps the account on its screen and offers to try again.
     */
    async function handleSignInRestored(identity: BeanPoolIdentity): Promise<boolean> {
        const done = await finishRestoreAtDoor(identity);
        if (!done) {
            setError(null);
            return false;
        }
        setSignInRestore(null);
        setRestoreReturn('none');
        return true;
    }

    function leaveSignInRestore(then?: () => void) {
        setSignInRestore(null);
        setRestoreReturn('none');
        setError(null);
        then?.();
    }

    async function handleRecover() {
        const words = recoveryWords.map(w => w.toLowerCase().trim());
        if (!validateMnemonic(words)) {
            setError('One or more words are not valid. Check your spelling.');
            return;
        }
        setLoading(true);
        setError(null);
        if (doorOpen) {
            try {
                await finishRestoreAtDoor(await identityFromMnemonic(words, ''));
            } catch {
                setError('Recovery failed. Check your words and try again.');
            } finally {
                setLoading(false);
            }
            return;
        }
        try {
            // The 12 words ARE the identity. The callsign and avatar are just
            // node-held profile data that travel with the key, so we pull the
            // callsign down rather than asking for it (the avatar is read live
            // from the node on this app). We never push a typed/placeholder name
            // back up. If the node can't be reached the account still restores and
            // adopts its real name on the first online membership check.
            let identity = await createIdentityFromMnemonic(words, '', sentJoinGuard());
            try {
                const mem = await checkMembership(identity.publicKey);
                if (mem?.callsign) {
                    identity = (await updateCallsign(mem.callsign)) || identity;
                }
            } catch { /* offline — name lands on next boot */ }

            // Recovery complete — explicitly ask for location once
            if ('geolocation' in navigator) {
                navigator.geolocation.getCurrentPosition(() => {}, () => {});
            }
            onComplete(identity);
        } catch (e) {
            if (e instanceof SentJoinWaitingError) {
                // Not while a join that went out from this browser is unsettled: that one is asked about first.
                settleSentJoinFirst();
                return;
            }
            if (e instanceof IdentityHeldError) {
                setShowRecovery(false);
                setHeldIdentity(e.held);
                return;
            }
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

    // "Finish joining" for a kept invite key (settleSentInvite). A key the node says is not a member yet goes back to the
    // invite form, whose next try sends it; the open door has no such form, so it waits here instead (4112075367).
    const finishJoining = typeof sentInvite === 'object' && (sentInvite.stuck !== 'waiting' || webJoinForDoor);
    // WebJoin only settles a sent join, sends nothing, and hands the page back once that join can no longer land: where
    // the door isn't open, and wherever a kept invite key waits to be asked about after it (4112213080). Offered again
    // in full on the open door, that join's resend would be refused because of the kept key, and never hand back.
    const joinSettleOnly = !webJoinForDoor || sentInvite !== 'none';
    const waitMinutes = Math.round(INVITE_SEND_CAN_LAND_MS / 60_000);

    return (
        <div className="page-surface min-h-screen text-nature-950 dark:text-oat-50" style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            padding: '2rem',
        }}>
            <div style={{
                maxWidth: '480px',
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
                    {door === 'unreachable' && !hasMnemonic(pendingIdentity) && !heldIdentity && !finishJoining && (
                        <div role="alert" data-testid="door-unreachable" style={{ fontSize: '0.8rem', marginBottom: '1rem', lineHeight: 1.5 }}>
                            Can't reach the community right now. Try again in a minute.{' '}
                            <button type="button" onClick={() => setDoorCheck((n) => n + 1)}
                                style={{ background: 'none', border: 'none', color: '#2563eb', textDecoration: 'underline', cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit', padding: 0 }}>
                                Try again
                            </button>
                        </div>
                    )}
                    {/* ===== SEED PHRASE DISPLAY (after create, before confirm) ===== */}
                    {heldIdentity ? (
                        /* ===== ANOTHER TAB SAVED AN ACCOUNT HERE: never replaced (review 4106962020) ===== */
                        <>
                            <h3 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '0.5rem' }}>
                                This browser already has an account
                            </h3>
                            <p role="alert" data-testid="welcome-held" style={{ fontSize: '0.85rem', lineHeight: 1.5, marginBottom: '0.75rem', overflowWrap: 'anywhere' }}>
                                {heldIdentity.callsign.trim() || 'An account'} was saved in this browser from another tab or window,
                                so nothing here replaced it. A browser holds one account.
                            </p>
                            {heldSentKey ? (() => {
                                // The key this page's invite went with (4111871903): kept on disk, and its words one tap away.
                                const heldName = heldIdentity.callsign.trim() || 'the account saved from the other tab';
                                const mine = heldSentKey.identity.callsign.trim() || null;
                                const it = mine ?? 'that account';
                                const its = mine ? `${mine}'s` : 'its';
                                const words = heldSentKey.identity.mnemonic?.length ? heldSentKey.identity.mnemonic : null;
                                return (
                                    <>
                                        <p data-testid="welcome-held-sent" style={{ fontSize: '0.85rem', lineHeight: 1.5, marginBottom: '1rem', overflowWrap: 'anywhere' }}>
                                            {heldSentKey.joined
                                                ? `The community took ${it} too, so you have two accounts there now.`
                                                : `The invite from this page${mine ? `, as ${mine},` : ''} may have gone through too.`}
                                            {` This browser keeps ${heldName} as its account. ${mine ? `${mine}'s` : 'Its'} key is kept on this device too:`}
                                            {` write down ${its} 12 words to keep ${it}. To use ${it} here instead, sign out of ${heldName} in`}
                                            {` Settings, then restore ${it} with those words.`}
                                        </p>
                                        {words && (
                                            <>
                                                {/* One button that shows and hides them, as on WebJoin's 'taken' screen: it
                                                    stays where it is, so focus does too. */}
                                                <button type="button" aria-expanded={showHeldWords} aria-controls={showHeldWords ? heldWordsId : undefined}
                                                    onClick={() => setShowHeldWords((shown) => !shown)}
                                                    style={{
                                                        width: '100%', padding: '0.75rem 0.5rem', borderRadius: '10px', marginBottom: '0.75rem',
                                                        border: '1px solid #2563eb', background: 'transparent', color: '#2563eb',
                                                        fontSize: '0.9rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', overflowWrap: 'anywhere',
                                                    }}>
                                                    {`${showHeldWords ? 'Hide' : 'Show'} ${its} 12 words`}
                                                </button>
                                                {showHeldWords && (
                                                    // As the Safety Backup step lays them out: as many columns as whole words
                                                    // fit, and a word copied onto paper is never broken across lines.
                                                    <ol id={heldWordsId} data-testid="welcome-held-words" aria-label={`${mine ? `${mine}'s` : 'Its'} 12 words`} style={{
                                                        listStyle: 'none', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 6.5em), 1fr))',
                                                        gap: '0.4rem', padding: 0, margin: '0 0 0.75rem', overflowWrap: 'normal',
                                                    }}>
                                                        {words.map((w, i) => (
                                                            <li key={i} style={{
                                                                background: 'var(--bg-secondary, #1e293b)', borderRadius: 8, padding: '0.5rem 0.4rem',
                                                                fontSize: '0.8rem', fontFamily: 'monospace', textAlign: 'center', minWidth: 0,
                                                            }}>
                                                                <span style={{ color: 'var(--text-muted)', fontSize: '0.65rem' }}>{i + 1}. </span>
                                                                <strong>{w}</strong>
                                                            </li>
                                                        ))}
                                                    </ol>
                                                )}
                                            </>
                                        )}
                                    </>
                                );
                            })() : (
                                <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', lineHeight: 1.5, marginBottom: '1.25rem', overflowWrap: 'anywhere' }}>
                                    To use a different account here, sign out of this one in Settings, then restore the other one.
                                </p>
                            )}
                            <button
                                type="button"
                                onClick={() => onComplete(heldIdentity)}
                                style={{
                                    width: '100%', padding: '0.85rem 0.5rem', borderRadius: '10px', border: 'none',
                                    background: '#2563eb', color: '#fff', fontSize: '1rem', fontWeight: 700,
                                    cursor: 'pointer', fontFamily: 'inherit', overflowWrap: 'anywhere',
                                }}
                            >
                                {heldIdentity.callsign.trim() ? `Open ${heldIdentity.callsign.trim()}` : 'Open it'}
                            </button>
                        </>
                    ) : hasMnemonic(pendingIdentity) && showAvatarSetup ? (
                        /* ===== STEP 2: CHOOSE YOUR LOOK ===== */
                        <>
                            <OnboardingStepper step={2} firstLabel={joinedByDoor ? 'Sign in' : undefined} />
                            <h3 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.5rem' }}>
                                📸 Choose your look
                            </h3>
                            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '1.5rem', lineHeight: 1.5 }}>
                                Pick a profile picture so your community knows you.
                            </p>
                            {joinedAsNote && (
                                <p role="status" data-testid="joined-as-note" style={{ fontSize: '0.8rem', marginBottom: '1rem', lineHeight: 1.5 }}>
                                    {joinedAsNote}
                                </p>
                            )}

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

                            {/* Not after the open door: that member exists on the node and is saved here, so there is no
                                name screen to go back to, and discarding the identity would strand the account. */}
                            {!joinedByDoor && (
                            <button
                                onClick={backFromPhotoStep}
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
                            )}
                        </>
                    ) : hasMnemonic(pendingIdentity) && showOnboardingGuide ? (
                        /* ===== ONBOARDING GUIDE (Step 4) ===== */
                        <>
                            <OnboardingStepper step={4} firstLabel={joinedByDoor ? 'Sign in' : undefined} />
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
                                                Positive balances above 200 Beans contribute 1.0% to 2.5% monthly across progressive brackets (the first 200 is fee-free). This prevents hoarding and circulates surplus to fund the Community Commons.
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

                                {/*
                                  Card 4: how you get back in.

                                  The design doc's wording describes Phase B — an account
                                  split into pieces held by your phone, your hub and whoever
                                  invited you. None of that exists yet, and printing it now
                                  would tell a brand new member they are protected by keepers
                                  they do not have: exactly the false all-clear this redesign
                                  is meant to remove. It says what is true today, and gets
                                  the keeper wording in Phase B when the keepers are real.
                                */}
                                <div className="p-4 rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50/50 dark:bg-amber-950/30 space-y-2">
                                    <h4 className="font-bold text-sm text-nature-950 dark:text-oat-50">🔑 Your 12 Words Are Everything</h4>
                                    <p className="text-xs text-nature-600 dark:text-nature-400 leading-relaxed">
                                        Your 12 words are your primary key to your account across devices.
                                        {signInRecovery
                                            ? <> Signing in with {providerLabel(signInRecovery)} also brings it back.</>
                                            : <> Without them, account recovery requires operator-assisted re-enrolment.</>}
                                    </p>
                                    <p className="text-xs text-nature-600 dark:text-nature-400 leading-relaxed">
                                        ⚠️ <strong>Browser storage can be wiped without warning.</strong> Safari clears site data after
                                        7 days of inactivity, so keeping your 12 words safe ensures seamless access.
                                    </p>
                                    <p className="text-xs text-nature-600 dark:text-nature-400 leading-relaxed">
                                        📝 Find them any time under <strong>Settings → Recovery Phrase</strong>.
                                        Write them down on paper — it's the only backup that can't be wiped.
                                    </p>
                                </div>

                                {/* Card 5: Where to Start */}
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
                    ) : hasMnemonic(pendingIdentity) ? (
                        /* ===== SAFETY BACKUP (Step 3) ===== */
                        <>
                            <OnboardingStepper step={3} firstLabel={joinedByDoor ? 'Sign in' : undefined} />
                            <h3 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.5rem' }}>🔑 Your Safety Backup</h3>
                            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '1rem', lineHeight: 1.5 }}>
                                Write these 12 words down on paper and keep them safe.
                                {signInRecovery
                                    ? <> They bring your identity back if you lose this device.</>
                                    : <> This is the <strong>only</strong> way to recover your identity if you lose this device.</>}
                            </p>
                            {/* The join also enrolled the sign-in as a way back (G11-c): said once, next to the words. */}
                            {signInRecovery && (
                                <p data-testid="backup-signin-recovery" style={{ fontSize: '0.8rem', marginBottom: '1rem', lineHeight: 1.5 }}>
                                    Signing in with {providerLabel(signInRecovery)} also brings this account back.
                                </p>
                            )}

                            {/* Browser storage eviction warning — PWA is sovereign-only, no keepers.
                                Tailwind rather than inline style: the amber-500 hex this used to
                                hardcode sits at ~2:1 against the pale background, which is unreadable
                                for exactly the people this warning is for. */}
                            <div role="alert" className="p-3 mb-4 rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 space-y-1">
                                <p className="text-xs font-semibold text-amber-900 dark:text-amber-300">
                                    <span aria-hidden="true">⚠️</span> Browser storage is not permanent
                                </p>
                                <p className="text-xs text-amber-800 dark:text-amber-400 leading-relaxed">
                                    Safari can clear site data after <strong>7 days of inactivity</strong>, and
                                    clearing your browsing data wipes your local session.
                                    Your 12 words on paper are the only offline backup that can't be wiped.
                                </p>
                            </div>

                            {/*
                              As many columns as whole words fit: three on a laptop, as before, one on a 320px phone at
                              1.3x text, where three fixed columns left each word about 29px and pushed the page 50px
                              sideways. A word someone copies onto paper is never broken across lines to fit.
                            */}
                            <div data-testid="backup-words" style={{
                                display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 6.5em), 1fr))',
                                gap: '0.4rem', marginBottom: '1rem',
                            }}>
                                {pendingWords?.map((word, i) => (
                                    <div key={i} style={{
                                        background: 'var(--bg-secondary, #1e293b)',
                                        borderRadius: 8, padding: '0.5rem 0.4rem',
                                        fontSize: '0.8rem', fontFamily: 'monospace',
                                        textAlign: 'center', minWidth: 0,
                                    }}>
                                        <span style={{ color: 'var(--text-muted)', fontSize: '0.65rem' }}>{i + 1}. </span>
                                        <strong>{word}</strong>
                                    </div>
                                ))}
                            </div>

                            {/*
                              Says out loud that this is not the only chance. Removing the
                              gate without this just leaves people guessing whether skipping
                              costs them something permanent — and the ones most likely to
                              skip are the ones with no pen to hand, not the ones who do not
                              care.
                            */}
                            <p style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginBottom: '1rem', lineHeight: 1.5 }}>
                                No pen handy? Carry on — you can come back to these any time under
                                Settings → Recovery Phrase. But <strong>don't leave it too long</strong> — your browser
                                could clear this data without asking.
                            </p>

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

                            {/*
                              No longer disabled behind the checkbox. Gating the only way
                              forward on a tick box taught people that ticking it was the
                              price of entry rather than a statement about their words, and
                              stranded anyone who could not write them down right then at a
                              dead end — with an account already created on the node.
                            */}
                            <button
                                onClick={() => {
                                    recordOnboardingEvent('protection_choice', seedConfirmed ? 'words' : 'skip');
                                    // A member who ticked "I've written them down" has done the thing
                                    // Settings' banner nags about. Without this, finishing onboarding
                                    // correctly still greets them with "you haven't saved your recovery
                                    // phrase yet" — a warning that is not true, which is how warnings
                                    // stop being read. Only on confirm: skipping leaves it showing.
                                    if (seedConfirmed && pendingIdentity) {
                                        localStorage.setItem(seedViewedKey(pendingIdentity.publicKey), 'true');
                                    }
                                    setShowOnboardingGuide(true);
                                    setError(null);
                                }}
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
                                Next →
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
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                                    <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: 0, lineHeight: 1.5, textAlign: 'left' }}>
                                        Enter your 12 recovery words.
                                    </p>
                                    <button
                                        type="button"
                                        aria-label="Paste recovery words from clipboard"
                                        onClick={async () => {
                                            try {
                                                const text = await navigator.clipboard.readText();
                                                const tokens = (text || '').trim().split(/\s+/).filter(Boolean);
                                                if (tokens.length === 0) return;
                                                const updated = Array(12).fill('');
                                                tokens.slice(0, 12).forEach((w, idx) => { updated[idx] = w.toLowerCase().trim(); });
                                                setRecoveryWords(updated);
                                            } catch {
                                                setError('Unable to read clipboard. Please paste your recovery words directly into the inputs.');
                                            }
                                        }}
                                        className="bg-blue-50 dark:bg-blue-950/40 border border-blue-400 dark:border-blue-600 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/50 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none transition-colors"
                                        style={{
                                            fontSize: '0.75rem', fontWeight: 600,
                                            padding: '0.35rem 0.75rem', borderRadius: '8px', cursor: 'pointer',
                                            whiteSpace: 'nowrap',
                                        }}
                                    >
                                        <span aria-hidden="true">📋 </span>Paste Words
                                    </button>
                                </div>

                                <div style={{
                                    display: 'grid',
                                    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                                    gap: '0.5rem',
                                    marginBottom: '1rem',
                                    width: '100%',
                                }}>
                                    {recoveryWords.map((word, i) => (
                                        <input
                                            key={i}
                                            id={`recoveryWord-${i}`}
                                            aria-label={`Recovery word ${i + 1}`}
                                            type="text"
                                            value={word}
                                            autoCapitalize="none"
                                            autoCorrect="off"
                                            autoComplete="off"
                                            spellCheck={false}
                                            onPaste={(e) => {
                                                // A whole phrase pasted into any box fans out across all 12.
                                                const tokens = (e.clipboardData.getData('text') || '').trim().split(/\s+/).filter(Boolean);
                                                if (tokens.length > 1) {
                                                    e.preventDefault();
                                                    const updated = Array(12).fill('');
                                                    tokens.slice(0, 12).forEach((w, idx) => { updated[idx] = w.toLowerCase().trim(); });
                                                    setRecoveryWords(updated);
                                                }
                                            }}
                                            onChange={(e) => {
                                                const tokens = e.target.value.trim().split(/\s+/).filter(Boolean);
                                                if (tokens.length > 1) {
                                                    const updated = Array(12).fill('');
                                                    tokens.slice(0, 12).forEach((w, idx) => { updated[idx] = w.toLowerCase().trim(); });
                                                    setRecoveryWords(updated);
                                                } else {
                                                    const updated = [...recoveryWords];
                                                    updated[i] = e.target.value.toLowerCase().trim();
                                                    setRecoveryWords(updated);
                                                }
                                            }}
                                            placeholder={`${i + 1}`}
                                            className="bg-nature-50/80 dark:bg-nature-800 border border-nature-300 dark:border-nature-700 text-nature-900 dark:text-oat-50 placeholder-nature-400 dark:placeholder-nature-500 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 transition-all"
                                            style={{
                                                width: '100%',
                                                minWidth: 0,
                                                boxSizing: 'border-box',
                                                padding: '0.55rem 0.35rem',
                                                borderRadius: 8,
                                                fontSize: '0.85rem',
                                                fontFamily: 'monospace',
                                                textAlign: 'center',
                                                outline: 'none',
                                            }}
                                        />
                                    ))}
                                </div>

                                <p style={{ color: 'var(--text-muted)', fontSize: '0.75rem', margin: '0 0 1rem', lineHeight: 1.5, textAlign: 'left' }}>
                                    Your name and picture come back automatically — the 12 words are all you need.
                                </p>

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
                    ) : showQrPairing ? (
                        /* ===== QR DEVICE PAIRING (#89) ===== */
                        <>
                            <div style={{ textAlign: 'center', marginBottom: '1.25rem' }}>
                                <h3 style={{ fontSize: '1.15rem', fontWeight: 800, marginBottom: '0.35rem', color: 'var(--text-primary)' }}>
                                    📲 Link with Mobile App
                                </h3>
                                <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', lineHeight: 1.5, margin: 0 }}>
                                    Scan this QR code with the BeanPool app on your phone to instantly unlock your account on this computer.
                                </p>
                            </div>

                            {error && (
                                <div
                                    role="alert"
                                    aria-live="assertive"
                                    className="bg-red-50 dark:bg-red-950/40 border border-red-300 dark:border-red-700 text-red-800 dark:text-red-300 p-2.5 rounded-xl text-xs mb-4 text-center leading-relaxed font-medium"
                                >
                                    <span aria-hidden="true">⚠️ </span>{error}
                                </div>
                            )}

                            <div
                                role="status"
                                aria-live="polite"
                                aria-atomic="true"
                                style={{
                                    display: 'flex',
                                    flexDirection: 'column',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    padding: '1.25rem',
                                    background: '#ffffff',
                                    borderRadius: '18px',
                                    boxShadow: '0 8px 30px rgba(0,0,0,0.12)',
                                    margin: '0 auto 1.25rem',
                                    width: 'fit-content',
                                    position: 'relative',
                                }}
                            >
                                {pairingStatus === 'waiting' && pairingSession ? (
                                    <>
                                        <div role="img" aria-label="QR code to scan with BeanPool mobile app">
                                            <QRCodeSVGComponent
                                                value={`beanpool://pair?session=${pairingSession.sessionId}&pub=${pairingSession.publicKeyHex}&node=${encodeURIComponent(getNodeApiUrl() || window.location.origin)}`}
                                                size={210}
                                                level="M"
                                                marginSize={2}
                                            />
                                        </div>
                                        <div style={{
                                            marginTop: '0.75rem',
                                            fontSize: '0.8rem',
                                            fontWeight: 700,
                                            color: pairingSecondsLeft < 20 ? '#dc2626' : '#047857',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.35rem',
                                        }} aria-label={`Expires in ${pairingSecondsLeft} seconds`}>
                                            <span>⏱️ Expires in {pairingSecondsLeft}s</span>
                                        </div>
                                    </>
                                ) : pairingStatus === 'decrypting' ? (
                                    <div style={{ padding: '2.5rem 1.5rem', textAlign: 'center' }}>
                                        <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem', animation: 'spin 1s infinite linear' }}>🔐</div>
                                        <div style={{ fontWeight: 700, fontSize: '0.95rem', color: '#111827' }}>Decrypting & Unlocking...</div>
                                    </div>
                                ) : pairingStatus === 'success' ? (
                                    <div style={{ padding: '2.5rem 1.5rem', textAlign: 'center' }}>
                                        <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>✨</div>
                                        <div style={{ fontWeight: 800, fontSize: '1.05rem', color: '#047857' }}>Device Linked Successfully!</div>
                                    </div>
                                ) : (
                                    <div style={{ padding: '2rem 1.5rem', textAlign: 'center', color: '#374151' }}>
                                        <div style={{ fontSize: '2.2rem', marginBottom: '0.5rem' }}>⌛</div>
                                        <div style={{ fontWeight: 700, fontSize: '0.9rem', marginBottom: '0.75rem' }}>
                                            {error ? 'Connection issue with node relay' : 'Pairing code expired'}
                                        </div>
                                        <button
                                            onClick={handleStartQrPairing}
                                            disabled={loading}
                                            style={{
                                                padding: '0.65rem 1.3rem',
                                                borderRadius: '10px',
                                                background: '#059669',
                                                color: '#ffffff',
                                                border: 'none',
                                                fontWeight: 700,
                                                fontSize: '0.85rem',
                                                cursor: loading ? 'not-allowed' : 'pointer',
                                                opacity: loading ? 0.7 : 1,
                                            }}
                                        >
                                            {loading ? '🔄 Connecting...' : '🔄 Try Again / New Code'}
                                        </button>
                                    </div>
                                )}
                            </div>

                            {/* 3 Step Guide */}
                            <div style={{
                                background: 'var(--surface-subtle, rgba(255,255,255,0.05))',
                                borderRadius: '12px',
                                padding: '0.85rem 1rem',
                                marginBottom: '1.25rem',
                                textAlign: 'left',
                                fontSize: '0.8rem',
                                color: 'var(--text-secondary)',
                                border: '1px solid var(--border-primary, rgba(255,255,255,0.1))',
                            }}>
                                <div style={{ fontWeight: 700, marginBottom: '0.4rem', color: 'var(--text-primary)' }}>How to scan:</div>
                                <ol style={{ margin: 0, paddingLeft: '1.2rem', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                                    <li>Open <strong>BeanPool</strong> on your mobile phone</li>
                                    <li>Go to <strong>Settings → Link Another Device</strong></li>
                                    <li>Point camera at this screen</li>
                                </ol>
                            </div>

                            <button
                                onClick={() => {
                                    setShowQrPairing(false);
                                    if (pairingSession) cancelPairingApi(pairingSession.sessionId);
                                }}
                                style={{
                                    background: 'none',
                                    border: 'none',
                                    color: 'var(--text-muted)',
                                    fontSize: '0.85rem',
                                    cursor: 'pointer',
                                    fontFamily: 'inherit',
                                }}
                            >
                                ← Back to Options
                            </button>
                        </>
                    ) : signInRestore || restoreReturn === 'restore' ? (
                        /* ===== AN ACCOUNT BACK WITH ITS SIGN-IN (G11-d) ===== */
                        <WebRestore
                            provider={signInRestore?.provider ?? null}
                            // Only a return this page matched to a restore; any other went to WebJoin.
                            authReturn={restoreReturn === 'restore' ? authReturn : null}
                            onRestored={handleSignInRestored}
                            onHeld={(held) => leaveSignInRestore(() => setHeldIdentity(held))}
                            onExisting={onComplete}
                            onBack={() => leaveSignInRestore()}
                            onOtherWay={(how) => leaveSignInRestore(() => {
                                setRestoredForDoor(null);
                                if (how === 'words') setShowRecovery(true);
                                else void handleStartQrPairing();
                            })}
                        />
                    ) : restoreReturn === 'checking' ? (
                        <p role="status" style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>One moment…</p>
                    ) : (webJoinForDoor && sentInvite === 'none') || (sentJoin === 'settle' && sentInvite !== 'checking') ? (
                        /* A sign-in coming back is met at once, before the node has said what it is; on a node that
                           turns out to be invite-only it is dropped, and the invite page shows as always. A join that
                           went out from this browser is settled here first, whatever the door says (review 4106962311),
                           once the invite slot has been read, so the mode it settles in is known before it starts.
                           A key an invite went with comes before the door's lobby: "One moment…" while it is read and
                           asked about, then "Finish joining" until it is settled (4112075367). */
                        /* ===== THE OPEN DOOR: join with a sign-in, no invite (design G11) ===== */
                        <>
                            {error && (
                                <div role="alert"
                                    className="bg-red-50 dark:bg-red-950/40 border border-red-300 dark:border-red-700 text-red-800 dark:text-red-300 p-2.5 rounded-xl text-xs mb-4 text-center leading-relaxed font-medium">
                                    {error}
                                </div>
                            )}
                            <WebJoin
                                // Settling only is a mode for the life of one WebJoin: when the door's answer moves the
                                // page from one to the other, it starts again in the right one.
                                key={joinSettleOnly ? 'settle' : restoredForDoor?.publicKey ?? 'new'}
                                restored={restoredForDoor}
                                settleOnly={joinSettleOnly}
                                onSettled={handleSettled}
                                onExisting={onComplete}
                                onJoined={handleJoined}
                                onRestore={(how, provider) => {
                                    setError(null);
                                    setRestoredForDoor(null);
                                    if (how === 'signin') setSignInRestore({ provider: provider ?? null });
                                    else if (how === 'words') setShowRecovery(true);
                                    else void handleStartQrPairing();
                                }}
                            />
                        </>
                    ) : finishJoining && typeof sentInvite === 'object' ? (
                        /* ===== A KEY AN INVITE WENT WITH, NOT SETTLED YET (deciding pass 4111943146) ===== */
                        <>
                            <h3 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '0.5rem' }}>Finish joining</h3>
                            <p role="alert" data-testid="invite-sent-unreachable" style={{ fontSize: '0.85rem', lineHeight: 1.5, marginBottom: '0.75rem', overflowWrap: 'anywhere' }}>
                                {sentInvite.stuck === 'unsaved'
                                    ? `The community has you as ${sentInvite.name || 'a member'}, but this browser couldn't save the account.`
                                    : sentInvite.stuck === 'waiting'
                                        ? `You asked to join as ${sentInvite.name || 'a new member'} with an invite, and the community doesn't have you yet.`
                                        : `You asked to join as ${sentInvite.name || 'a new member'}, and the answer didn't reach this browser.`}
                                {` It's keeping ${sentInvite.name ? `${sentInvite.name}'s` : 'your'} key until it can finish.`}
                            </p>
                            {sentInvite.stuck === 'unreachable' && (
                                <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', lineHeight: 1.5, marginBottom: '1rem', overflowWrap: 'anywhere' }}>
                                    Can't reach the community right now.
                                </p>
                            )}
                            {sentInvite.stuck === 'waiting' && (
                                <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', lineHeight: 1.5, marginBottom: '1rem', overflowWrap: 'anywhere' }}>
                                    {`An invite can still go through up to ${waitMinutes} minutes after it was sent. After that, Retry lets the key go, and you can join another way.`}
                                </p>
                            )}
                            <p role="status" style={{ fontSize: '0.8rem', lineHeight: 1.5, marginBottom: sentInvite.again && !sentInvite.busy ? '1rem' : 0, overflowWrap: 'anywhere' }}>
                                {sentInvite.again && !sentInvite.busy
                                    ? (sentInvite.stuck === 'unsaved'
                                        ? "Still couldn't save it. Try again in a minute."
                                        : sentInvite.stuck === 'waiting'
                                            ? "The community still doesn't have you. Try again in a few minutes."
                                            : "Still can't reach the community. Try again in a minute.")
                                    : ''}
                            </p>
                            {/* aria-disabled, not disabled, while it asks: a disabled button would drop the focus it has. */}
                            <button type="button" aria-disabled={sentInvite.busy} onClick={retrySentInvite}
                                style={{
                                    width: '100%', padding: '0.85rem 0.5rem', borderRadius: '10px', border: 'none',
                                    background: sentInvite.busy ? '#555' : '#2563eb', color: '#fff', fontSize: '1rem', fontWeight: 700,
                                    cursor: sentInvite.busy ? 'not-allowed' : 'pointer', fontFamily: 'inherit', overflowWrap: 'anywhere',
                                }}>
                                {sentInvite.busy ? 'Checking…' : 'Retry'}
                            </button>
                        </>
                    ) : door === 'checking' || sentJoin === 'checking' || sentInvite === 'checking' || sentInvite === 'kept' ? (
                        <p role="status" style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>One moment…</p>
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
                                Your Callsign (Name)
                            </label>
                            <input
                                id="callsign"
                                type="text"
                                value={callsign}
                                onChange={(e) => setCallsign(e.target.value)}
                                placeholder="e.g. Alice"
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
                                disabled={loading}
                                style={{
                                    width: '100%', padding: '0.85rem', borderRadius: '10px',
                                    border: 'none',
                                    background: loading ? '#555' : '#10b981',
                                    color: '#fff', fontSize: '1rem',
                                    fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer',
                                    fontFamily: 'inherit', transition: 'background 0.2s',
                                    marginBottom: '1rem',
                                }}
                            >
                                {loading ? 'Creating...' : 'Create Identity & Join →'}
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

                            {/* ===== RESTORE IDENTITY ACTION FOR RETURNING USERS (#98) ===== */}
                            <div style={{
                                marginTop: '1.25rem',
                                padding: '1rem',
                                borderRadius: '12px',
                                background: 'rgba(59, 130, 246, 0.08)',
                                border: '1px solid rgba(59, 130, 246, 0.25)',
                                textAlign: 'center',
                            }}>
                                <p style={{
                                    color: 'var(--text-secondary)',
                                    fontSize: '0.85rem',
                                    margin: '0 0 0.65rem',
                                    fontWeight: 500,
                                }}>
                                    Already a member or switching devices?
                                </p>
                                <button
                                    onClick={() => {
                                        setShowNewUser(false);
                                        setShowMemberOptions(true);
                                        setError(null);
                                    }}
                                    aria-label="Restore existing identity"
                                    style={{
                                        width: '100%',
                                        padding: '0.75rem 1rem',
                                        borderRadius: '10px',
                                        border: '1px solid #2563eb',
                                        background: 'transparent',
                                        color: '#2563eb',
                                        fontSize: '0.9rem',
                                        fontWeight: 700,
                                        cursor: 'pointer',
                                        fontFamily: 'inherit',
                                        transition: 'background 0.2s, transform 0.15s',
                                    }}
                                    onMouseDown={(e) => (e.currentTarget.style.transform = 'scale(0.98)')}
                                    onMouseUp={(e) => (e.currentTarget.style.transform = 'scale(1)')}
                                    onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
                                >
                                    🔑 Restore Existing Identity →
                                </button>
                            </div>

                            <button
                                onClick={() => { setShowNewUser(false); setShowMemberOptions(false); setError(null); }}
                                style={{
                                    background: 'none', border: 'none',
                                    color: 'var(--text-muted)', fontSize: '0.8rem',
                                    cursor: 'pointer', marginTop: '1rem', fontFamily: 'inherit',
                                }}
                            >
                                ← Back to Home
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

                                    {error && (
                                        <div
                                            role="alert"
                                            aria-live="assertive"
                                            className="bg-red-50 dark:bg-red-950/40 border border-red-300 dark:border-red-700 text-red-800 dark:text-red-300 p-2.5 rounded-xl text-xs mb-4 text-center leading-relaxed font-medium"
                                        >
                                            <span aria-hidden="true">⚠️ </span>{error}
                                        </div>
                                    )}

                                    <button
                                        onClick={handleStartQrPairing}
                                        disabled={loading}
                                        className="w-full rounded-2xl border border-emerald-500/40 bg-emerald-50/90 hover:bg-emerald-100/90 active:scale-[0.98] dark:bg-emerald-950/40 dark:hover:bg-emerald-900/50 text-emerald-800 dark:text-emerald-300 font-bold text-base transition-all duration-150 flex items-center justify-center gap-2 mb-3 py-3.5 px-4 shadow-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
                                    >
                                        <span aria-hidden="true">📲</span> Link with Mobile App (Scan QR)
                                        <span className="text-[10px] font-extrabold bg-emerald-600 text-white px-2 py-0.5 rounded-full ml-1 uppercase tracking-wider">
                                            FASTEST
                                        </span>
                                    </button>

                                    <button
                                        onClick={() => { setShowRecovery(true); setError(null); }}
                                        disabled={loading}
                                        className="w-full rounded-2xl border border-amber-500/40 bg-amber-50/90 hover:bg-amber-100/90 active:scale-[0.98] dark:bg-amber-950/40 dark:hover:bg-amber-900/50 text-amber-900 dark:text-amber-300 font-bold text-base transition-all duration-150 flex items-center justify-center gap-2 mb-3 py-3.5 px-4 shadow-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2"
                                    >
                                        <span aria-hidden="true">🔑</span> Recover with 12 Words
                                    </button>

                                    <button
                                        onClick={() => setShowMemberOptions(false)}
                                        style={{
                                            background: 'none', border: 'none',
                                            color: 'var(--text-muted)', fontSize: '0.85rem',
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
