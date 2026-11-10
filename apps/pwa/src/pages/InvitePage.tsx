/**
 * InvitePage — Generate invites + Community Tree + Health Dashboard
 *
 * Three sections:
 *  1. Invite code generation & management
 *  2. Interactive invite tree visualisation
 *  3. Community health metrics & flags
 *
 * On a node that takes no invites (lib/node-invites.ts: the global node), none of that: the community's plain link to
 * share, since anyone joins it with a sign-in. Where only its admins invite (the door, `features.door === 'admins'`), a
 * member who is no owner or admin there makes none either, and is told who does, in plain words.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
    buildOfflineInviteCode, generateInvite, getCommunityCard, getMyInvites, revokeInvite, getInviteTree, getMyVouching, getVouchersBlock,
    myNodeRoleOnce, request, type CommunityInfo, type InviteCode, type MyVouching, type VoucherSummary,
} from '../lib/api';
import type { WaitingVoucherRow } from '@beanpool/core';
import { type BeanPoolIdentity } from '../lib/identity';
import { communityInfoOnce } from '../lib/visitor-lobby-gate';
import { marked, modeFor, readsOwn, useReaderFeatures } from '../lib/features';
import { LocalCommunityAction, LocalCommunityLine, LocalCommunityStrip, type LocalCommunityWays } from '../components/LocalCommunityMark';
import { SampleHeader, sampleInvites, sampleInviteTree } from '../components/ShowcasePreviews';
import { AskAnAdmin, InviteAsksToAnswer } from '../components/InviteAsks';
import { VouchPresetChoice } from '../components/VouchPresetChoice';
import { InviteAddsBoxes } from '../components/InviteAddsBoxes';
import { VoucherCardModal } from '../components/VoucherCardModal';
import { InviteMadeCard, PendingInvites } from '../components/PendingInvites';
import { MakeVoucherNotice } from '../components/MakeVoucherNotice';
import { LOCAL_COMMUNITY_LINES, formatDate, inviteRevokeWords, inviteShareText, offersInviteAsk, offersNamesList, shareAddress, t, tn, vouchPresets, ownersHeading, waitingHeading, ownerRowWords, voucherRowWords, waitingRowWords, vouchersBlockSections, type InviteRowSource } from '@beanpool/core';
import {
    communityLinkText, invitesOn, invitesOffRefusal, onlyAdminsInvite, takesKnocks, readInviteRole, roleReadRefused, mayInviteHere, mayMakeOfflineTicket,
    adminsOnlyText, adminsOnlyRefusal, pausedRefusal, OFFLINE_ADMINS_ONLY_TEXT, INVITE_WORDS, type InviteRole,
} from '../lib/node-invites';

/** A refusal as the page shows it: lib/node-invites.ts's own fallback in the member's language, the node's words as they came. */
function refusalWords(said: string): string {
    if (said === INVITE_WORDS.offFallback) return t(INVITE_WORDS.offFallback);
    if (said === INVITE_WORDS.adminsOnlyFallback) return t(INVITE_WORDS.adminsOnlyFallback);
    if (said === INVITE_WORDS.offlineAdminsOnly) return t(INVITE_WORDS.offlineAdminsOnly);
    if (said === INVITE_WORDS.pausedFallback) return t(INVITE_WORDS.pausedFallback);
    return said;
}

/** A date on an invite or in the tree, as the phone's Invites says it ("20 Oct 2026"; it was the browser's own). */
const dayWords = (iso: string) => formatDate(new Date(iso), 'day-month-year');
import { QRCodeSVG } from 'qrcode.react';

const QRCodeSVGComponent = QRCodeSVG as any;

interface Props extends LocalCommunityWays {
    identity: BeanPoolIdentity;
    /** Where the 🏘️ sheet's in-app ways forward lead (Home's Find card, a guide page). */
    onNavigate?: (tab: string, contextId?: string) => void;
    /** Invites are previewed on this node: Example Valley's invitations and tree, and the marker's sheet for every action. */
    preview?: boolean;
}

interface TreeNode {
    publicKey: string;
    callsign: string;
    joinedAt: string;
    inviteCode: string;
    children: TreeNode[];
}

export function InvitePage({ identity, onNavigate, preview: propPreview, ...ways }: Props) {
    const waysForward: LocalCommunityWays = {
        onNearYou: ways.onNearYou ?? (onNavigate ? () => onNavigate('home') : undefined),
        onGuide: ways.onGuide ?? (onNavigate ? (slug) => onNavigate('guide', slug) : undefined),
    };

    const [invites, setInvites] = useState<InviteCode[]>([]);
    const [cardName, setCardName] = useState<string | null>(null);
    useEffect(() => {
        let alive = true;
        const address = shareAddress(window.location.origin);
        getCommunityCard().then(card => {
            const claimed = card?.host?.replace(/:443$/, '') ?? null;
            if (alive && card?.name && claimed === address) setCardName(card.name);
        }).catch(() => { /* the address names it */ });
        return () => { alive = false; };
    }, []);
    const [generating, setGenerating] = useState(false);
    const [newCode, setNewCode] = useState<string | null>(null);
    // What the invite just made is for and carries, for the card under Generate; the form folds behind "Make another invite" once
    // one is made, so a second code is a deliberate tap (Marty, 10 Nov: a plain invite was made beside the bound one).
    const [madeCard, setMadeCard] = useState<{ who: string | null; invite: InviteRowSource } | null>(null);
    const [makeAnother, setMakeAnother] = useState(false);
    const [intendedFor, setIntendedFor] = useState('');
    const [copied, setCopied] = useState(false);
    const [showQR, setShowQR] = useState(false);

    // Tree
    const [tree, setTree] = useState<TreeNode[]>([]);
    const [activeSection, setActiveSection] = useState<'invites' | 'tree'>('invites');

    // Invites, where the node makes them (lib/node-invites.ts: off on the global node, which refuses every one). Until
    // the node has said, on, as on every node before the switch. Where they are off the page offers the link instead.
    const [makes, setMakes] = useState(true);
    // The node's own words, when it refused a generate before this page had heard it takes no invites.
    const [refused, setRefused] = useState<string | null>(null);
    const [nodeInfo, setNodeInfo] = useState<CommunityInfo | null>(null);
    // Invites live in a local community here (preview or read-only, lib/features.ts): the line under the link (§1 row 8).
    const reader = useReaderFeatures(nodeInfo);
    useEffect(() => {
        let cancelled = false;
        Promise.resolve()
            .then(() => communityInfoOnce())
            .then((info) => { if (!cancelled) { setNodeInfo(info); setMakes(invitesOn(info)); } })
            .catch(() => { /* Not answered: keep what the page shows; the node refuses an invite itself. */ });
        return () => { cancelled = true; };
    }, []);

    const isPreview = propPreview !== undefined ? propPreview : modeFor('invites', nodeInfo, reader) === 'preview';

    // Where only its admins invite (lib/node-invites.ts), this member's role, as the node says it (GET
    // /api/node-admin/me). Not heard yet, or no answer, counts as before: the node refuses a member's invite itself.
    const doorAdmins = !isPreview && onlyAdminsInvite(nodeInfo);
    const [role, setRole] = useState<InviteRole | undefined>(undefined);
    useEffect(() => {
        if (!doorAdmins) return;
        let cancelled = false;
        request<{ role?: unknown }>('GET', '/api/node-admin/me')
            .then((body) => { if (!cancelled) setRole(readInviteRole(body?.role)); })
            .catch((e) => {
                // A refusal (not a member) is an answer: no role. No answer at all, or a busy network's 429, leaves it unknown.
                if (!cancelled && roleReadRefused(e)) setRole(null);
            });
        return () => { cancelled = true; };
    }, [doorAdmins]);
    // The signer's role, asked once a page load (lib/api.ts myNodeRoleOnce), for the two names-list boxes an owner or admin sees
    // under the vouch presets (components/InviteAddsBoxes.tsx). It decides nothing on the node: undefined (not heard) and null
    // (no role) both show nothing, and the node checks every request itself.
    const [nodeRole, setNodeRole] = useState<string | null | undefined>(undefined);
    useEffect(() => {
        if (isPreview) return;
        let cancelled = false;
        void myNodeRoleOnce().then((r) => { if (!cancelled) setNodeRole(r); });
        return () => { cancelled = true; };
    }, [isPreview]);
    // Owners and admins on a node that offers the names list (core offersNamesList: not the global node). The node's profile
    // must have been heard, so the boxes never flash on a node that makes no invites.
    const showsNamesBoxes = !isPreview && nodeInfo !== null && offersNamesList(nodeRole, nodeInfo.profile);
    // The node's own words, when it refused a generate because only admins invite here.
    const [adminsRefused, setAdminsRefused] = useState<string | null>(null);
    const adminsOnly = !isPreview && (adminsRefused !== null || !mayInviteHere(nodeInfo, role));
    // Said under the button when no invite was made and the page stays as it is (offline where only admins invite).
    const [notice, setNotice] = useState<string | null>(null);

    // Vouchers (V3): the signer's budget presets, and the Vouchers block for owners and committee admins (§11).
    const [myVouching, setMyVouching] = useState<MyVouching | null>(null);
    const [vouchPreset, setVouchPreset] = useState<number | null>(null);
    const [vouchersData, setVouchersData] = useState<VoucherSummary[] | null>(null);
    // Invites not used yet that promise a budget (the Vouchers block's Waiting to join): their names are on the phone.
    const [waitingData, setWaitingData] = useState<WaitingVoucherRow[]>([]);
    const [selectedVoucherPubkey, setSelectedVoucherPubkey] = useState<string | null>(null);
    const [showMakeVoucherNotice, setShowMakeVoucherNotice] = useState(false);

    // An answer that lands after the page has gone sets nothing (a test's torn-down window once turned main red, 6 Nov).
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);

    const loadMyVouching = useCallback(async () => {
        if (isPreview) return;
        let data: Awaited<ReturnType<typeof getMyVouching>> | null;
        try {
            data = await getMyVouching();
        } catch {
            data = null;
        }
        if (mounted.current) setMyVouching(data);
    }, [isPreview]);

    const loadVouchersBlock = useCallback(async () => {
        if (isPreview) return;
        let data: VoucherSummary[] | null;
        let waiting: WaitingVoucherRow[] = [];
        try {
            const block = await getVouchersBlock();
            data = block?.vouchers ?? null;
            waiting = block?.waiting ?? [];
        } catch {
            data = null;
        }
        if (mounted.current) { setVouchersData(data); setWaitingData(waiting); }
    }, [isPreview]);

    useEffect(() => {
        void loadMyVouching();
        void loadVouchersBlock();
    }, [loadMyVouching, loadVouchersBlock]);

    // The member's own codes and their invite tree: never asked where invites are in preview (the global node, which
    // makes no invite; lib/features readsOwn).
    useEffect(() => {
        if (isPreview) {
            setInvites(sampleInvites());
            setTree(sampleInviteTree());
            return;
        }
        let cancelled = false;
        readsOwn('invites').then((reads) => {
            if (cancelled) return;
            if (reads) {
                loadInvites(true);
                loadTree();
            }
        });
        return () => { cancelled = true; };
    }, [isPreview, identity.publicKey]);

    async function loadInvites(askNode: boolean) {
        if (isPreview || !askNode) return;
        let serverInvites: InviteCode[] = [];
        try {
            const result = await getMyInvites(identity.publicKey);
            serverInvites = result.invites;
        } catch { /* offline */ }

        // Merge with local offline tickets that haven't been redeemed
        try {
            const storedOffline = localStorage.getItem(`bp_offline_invites_${identity.publicKey}`);
            if (storedOffline) {
                const localInvites: InviteCode[] = JSON.parse(storedOffline);
                const merged = [...localInvites, ...serverInvites];
                setInvites(merged);
                return;
            }
        } catch (e) {
            console.error("Failed to parse local offline tickets", e);
        }

        setInvites(serverInvites);
    }

    /**
     * Revoke one of this member's invites on the community (invites-vouching I2). Gone, it leaves Pending and the made card,
     * and a vouch it held is back in the budget. A `no_invite` means the community holds no such unused code of theirs any
     * more (lapsed and pruned): it goes from the list too. Otherwise the node's sentence is shown and the invite stays.
     */
    async function revokeMine(inv: InviteRowSource): Promise<string | null> {
        try {
            await revokeInvite(inv.code);
        } catch (e) {
            // Only the node's own `no_invite` means it is gone: a node older than Revoke answers 404 too, with no code.
            if ((e as { code?: unknown })?.code !== 'no_invite') return (e as Error)?.message || inviteRevokeWords.failed();
        }
        const key = inv.code.toLowerCase();
        setInvites((prev) => prev.filter((i) => i.code.toLowerCase() !== key));
        if (newCode && newCode.toLowerCase() === key) {
            setNewCode(null);
            setMadeCard(null);
        }
        if (inv.vouchAmount) void loadMyVouching();
        return null;
    }

    async function saveOfflineInviteLocally(invite: InviteCode) {
        try {
            const storedOffline = localStorage.getItem(`bp_offline_invites_${identity.publicKey}`);
            const localInvites: InviteCode[] = storedOffline ? JSON.parse(storedOffline) : [];
            localInvites.unshift(invite);
            localStorage.setItem(`bp_offline_invites_${identity.publicKey}`, JSON.stringify(localInvites));
        } catch (e) {
            console.error("Local storage error:", e);
        }
    }

    async function loadTree() {
        if (isPreview) return;
        try {
            const result = await getInviteTree();
            setTree(result);
        } catch { /* offline */ }
    }


    async function handleGenerate() {
        setGenerating(true);
        setCopied(false);
        setNotice(null);
        const chosenVouch = myVouching?.voucher ? vouchPreset : null;
        try {
            // Online first (parity with native): a server-minted INV- code is
            // short, single-use enforced centrally, and lands in the node's
            // invite tree. Only fall back to a self-signed offline ticket when
            // the node can't be reached.
            try {
                const res = chosenVouch != null
                    ? await generateInvite(identity.publicKey, intendedFor.trim() || undefined, chosenVouch)
                    : await generateInvite(identity.publicKey, intendedFor.trim() || undefined);
                if (res?.invite?.code) {
                    setNewCode(res.invite.code);
                    setMadeCard({ who: intendedFor.trim() || null, invite: res.invite });
                    setMakeAnother(false);
                    setIntendedFor('');
                    setShowQR(true);
                    setVouchPreset(null);
                    setInvites(prev => [res.invite, ...prev]);
                    void loadMyVouching();
                    void loadVouchersBlock();
                    return;
                }
            } catch (e: any) {
                // The node takes no invites (it said so before this page heard): its words, and no offline ticket, which
                // it would refuse just the same.
                const refusal = invitesOffRefusal(e);
                if (refusal) {
                    setRefused(refusal);
                    setMakes(false);
                    return;
                }
                // Only admins invite here (the page hadn't heard, or this member's role changed): the node's words, and
                // no offline ticket, which it would refuse at the join.
                const adminsWords = adminsOnlyRefusal(e);
                if (adminsWords) {
                    setAdminsRefused(adminsWords);
                    return;
                }
                // This member's account is paused: the node's words, and no offline ticket, which it would refuse at the
                // join until the pause ends.
                const pausedWords = pausedRefusal(e);
                if (pausedWords) {
                    setNotice(pausedWords);
                    return;
                }
                // A refused vouch shows the node's sentence and makes no ticket:
                const serverMsg = typeof e?.message === 'string' && e.message ? e.message : typeof e?.error === 'string' && e.error ? e.error : null;
                if (chosenVouch !== null && serverMsg && typeof e?.status === 'number') {
                    setNotice(serverMsg);
                    return;
                }
                // An offline ticket never carries a vouch:
                if (chosenVouch !== null) {
                    setNotice(t(vouchPresets.noOfflineVouch));
                    return;
                }
                /* node unreachable on None — offline fallback below */
            }

            // Where only admins invite, a ticket only from a member the node has said is one (lib/node-invites.ts).
            if (!mayMakeOfflineTicket(nodeInfo, role)) {
                setNotice(OFFLINE_ADMINS_ONLY_TEXT);
                return;
            }

            // A self-signed ticket for this community only (core's format 2 names its host), with the
            // `BP-` that tells it apart from an invite code.
            const forWhom = intendedFor.trim() || undefined;
            const code = await buildOfflineInviteCode(identity.publicKey, identity.privateKey, forWhom);

            setNewCode(code);
            setIntendedFor('');
            setShowQR(true);
            
            // Construct the struct for local presentation
            const inviteObj: InviteCode = {
                code,
                createdBy: identity.publicKey,
                createdAt: new Date().toISOString(),
                usedBy: null,
                usedAt: null,
                intendedFor: forWhom
            };

            // Write to local IndexedDB/localStorage persist to survive reload
            await saveOfflineInviteLocally(inviteObj);

            // Optimistically stick it in the UI since the server doesn't know about it yet!
            setInvites(prev => [inviteObj, ...prev]);
            setMadeCard({ who: forWhom ?? null, invite: inviteObj });
            setMakeAnother(false);
            
        } catch (err: any) {
            alert(err.message || t('Failed to generate offline ticket'));
        } finally {
            setGenerating(false);
        }
    }

    async function handleCopy(code: string) {
        try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            const el = document.createElement('textarea');
            el.value = code;
            document.body.appendChild(el);
            el.select();
            document.execCommand('copy');
            document.body.removeChild(el);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    }

    async function handleCopyProxy(code: string) {
        // The /api/links/shorten proxy was never implemented server-side; the
        // full ?invite= URL is the real (and only) format links have ever used.
        await handleCopy(`${window.location.origin}/?invite=${code}`);
    }

    /**
     * Share sends the message as text only (Marty, 10 Nov: a shared QR picture lost the link, the code and the address). The QR
     * stays on the card for someone beside you to scan. Where the browser has no share, the message is copied.
     */
    async function handleShare(code: string) {
        const inviteUrl = `${window.location.origin}/?invite=${code}`;
        // Plain words for a friend (no "node", no "URL"; front doors S10, core inviteShareText), naming the community as
        // its card does (read when the page opened: a share must start inside the tap, or Safari refuses it), else by
        // its address.
        const address = shareAddress(window.location.origin);
        const name = cardName ?? address;
        const messageText = inviteShareText({ name, link: inviteUrl, code, address });

        const shareData = {
            title: t('Join me on BeanPool'),
            text: messageText,
        };

        if (navigator.share) {
            try { await navigator.share(shareData); } catch { /* cancelled */ }
        } else {
            handleCopy(messageText);
        }
    }

    async function handleShareLink() {
        const text = communityLinkText(window.location.origin);
        if (navigator.share) {
            try { await navigator.share({ title: 'BeanPool', text }); } catch { /* cancelled */ }
        } else {
            handleCopy(text);
        }
    }

    // Where only admins invite, a paper ticket made on this device before the switch is refused by the node, so it is
    // not listed as a code that still works.
    const offlineCodes = (!isPreview && adminsOnly) ? localOfflineCodes(identity.publicKey) : new Set<string>();
    const unusedInvites = invites.filter(i => !i.usedBy && !offlineCodes.has(i.code));
    const usedInvites = invites.filter(i => i.usedBy);
    // The form is folded away once an invite is made; a second code is a deliberate tap on "Make another invite".
    const formOpen = isPreview || !newCode || makeAnother;

    // The community's plain link, to copy or share: where nobody makes invites, or where only admins do and the
    // community takes requests to join (someone with the link asks in the app, and an admin answers).
    const linkActions = () => {
        const link = window.location.origin;
        return (
            <>
                <p className="font-mono text-[14px] font-bold text-nature-950 dark:text-white break-all mb-4">{link}</p>
                <div className="flex flex-wrap gap-3">
                    <button
                        onClick={() => handleCopy(link)}
                        className={`py-3 px-6 rounded-xl border text-[14px] font-bold cursor-pointer transition-all ${
                            copied
                                ? 'bg-emerald-100 border-emerald-500 text-emerald-700 dark:bg-emerald-900/50 dark:border-emerald-500 dark:text-emerald-400'
                                : 'bg-white dark:bg-nature-800 border-nature-200 dark:border-nature-700 text-nature-900 dark:text-white hover:bg-nature-50 dark:hover:bg-nature-700'
                        }`}
                        aria-label={t("Copy this community's link")}
                        title={t("Copy this community's link")}
                    >
                        {copied ? t('✓ Copied!') : t('📋 Copy')}
                    </button>
                    <button
                        onClick={handleShareLink}
                        className="py-3 px-6 rounded-xl border-none bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on text-[14px] font-bold cursor-pointer shadow-sm transition-all"
                        aria-label={t("Share this community's link")}
                        title={t("Share this community's link")}
                    >
                        {t('📤 Share')}
                    </button>
                </div>
            </>
        );
    };

    const bringSomeoneHere = (withLine: boolean) => {
        const desc = refused !== null ? refusalWords(refused) : (
            nodeInfo?.features?.wordsDoor === false
                ? t("This community doesn’t use invites. Anyone can join it with a sign-in, so just share its link.")
                : t("This community doesn’t use invites. Anyone can join it with 12 words or a sign-in, so just share its link.")
        );
        return (
            <div className={withLine ? "mb-6" : undefined}>
                <h2 className="text-xl font-bold mb-2 text-nature-950 dark:text-white flex items-center gap-2">
                    {t('📤 Bring someone here')}
                </h2>
                <p className="text-nature-500 dark:text-nature-400 text-[14px] mb-5 leading-relaxed">
                    {desc}
                </p>
                {linkActions()}
                {withLine && (
                    <div className="mt-5" data-testid="invites-local-line">
                        <LocalCommunityLine feature="invites" text={t(LOCAL_COMMUNITY_LINES.invites)} {...waysForward} />
                    </div>
                )}
            </div>
        );
    };

    if (!makes && !isPreview) {
        return (
            <div className="p-4 max-w-[500px] mx-auto min-h-full">
                {bringSomeoneHere(Boolean(marked(modeFor('invites', nodeInfo, reader))))}
            </div>
        );
    }

    return (
        <div className="p-4 max-w-[500px] mx-auto min-h-full" data-testid={isPreview ? "invites-preview" : undefined}>
            {isPreview && (
                <div className="mb-4">
                    <LocalCommunityStrip feature="invites" {...waysForward} />
                    <SampleHeader />
                </div>
            )}
            {isPreview && bringSomeoneHere(true)}
            {/* Section tabs */}
            <div className="flex gap-2 mb-6">
                <button 
                    onClick={() => setActiveSection('invites')} 
                    className={`flex-1 py-3 rounded-xl border-none text-[14px] font-bold cursor-pointer transition-all shadow-sm ${
                        activeSection === 'invites' 
                            ? 'bg-bp-commit-fill text-bp-commit-on shadow-md' 
                            : 'bg-oat-100 dark:bg-nature-800 text-nature-600 dark:text-nature-200 hover:bg-oat-200 dark:hover:bg-nature-700'
                    }`}
                >
                    {t('🎟️ Invites')}
                </button>
                <button 
                    onClick={() => setActiveSection('tree')} 
                    className={`flex-1 py-3 rounded-xl border-none text-[14px] font-bold cursor-pointer transition-all shadow-sm ${
                        activeSection === 'tree' 
                            ? 'bg-bp-commit-fill text-bp-commit-on shadow-md' 
                            : 'bg-oat-100 dark:bg-nature-800 text-nature-600 dark:text-nature-200 hover:bg-oat-200 dark:hover:bg-nature-700'
                    }`}
                >
                    {t('🌳 Tree')}
                </button>
            </div>

            {/* =================== INVITES SECTION =================== */}
            {activeSection === 'invites' && (
                <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                    {adminsOnly ? (
                        // Only its admins invite here and this member is no owner or admin: no generator, but the
                        // codes they already made (below) and the Tree stay.
                        <div className="mb-6">
                            <h2 className="text-xl font-bold mb-2 text-nature-950 dark:text-white flex items-center gap-2">
                                {t('📤 Bring someone here')}
                            </h2>
                            <p className="text-nature-500 dark:text-nature-400 text-[14px] mb-5 leading-relaxed">
                                {adminsRefused !== null ? refusalWords(adminsRefused) : adminsOnlyText(takesKnocks(nodeInfo))}
                            </p>
                            {takesKnocks(nodeInfo) && linkActions()}
                            {offersInviteAsk(nodeInfo?.features, !adminsOnly) && <AskAnAdmin onCopy={handleCopyProxy} onShare={handleShare} />}
                        </div>
                    ) : (
                        <>
                    {!isPreview && doorAdmins && nodeInfo?.features?.inviteAsks === true && <InviteAsksToAnswer />}
                    {!isPreview && vouchersData !== null && (
                        <div className="mb-6" data-testid="vouchers-block">
                            <h2 className="text-xl font-bold mb-2 text-nature-950 dark:text-white flex items-center gap-2">
                                {t('Vouchers')}
                            </h2>
                            <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl overflow-hidden shadow-sm divide-y divide-nature-100 dark:divide-nature-800">
                                {(() => {
                                    const { owners, others } = vouchersBlockSections(vouchersData);
                                    const row = (v: VoucherSummary) => (
                                        <button
                                            key={v.memberPubkey}
                                            type="button"
                                            onClick={() => setSelectedVoucherPubkey(v.memberPubkey)}
                                            className="w-full text-left p-3.5 hover:bg-oat-50 dark:hover:bg-nature-800/50 transition-colors flex items-start justify-between gap-2 border-0 bg-transparent cursor-pointer"
                                            data-testid={`voucher-row-${v.callsign}`}
                                        >
                                            <div className="flex-1 min-w-0 text-sm font-semibold text-nature-900 dark:text-white break-words">
                                                {v.noLimit ? ownerRowWords(v.callsign, v.peopleVouched) : voucherRowWords(v.callsign, v.left)}
                                            </div>
                                        </button>
                                    );
                                    return (
                                        <>
                                            {owners.length > 0 && (
                                                <div className="px-3.5 pt-3 pb-1 text-xs font-bold text-nature-600 dark:text-nature-300" data-testid="vouchers-owners-line">{ownersHeading()}</div>
                                            )}
                                            {owners.map(row)}
                                            {others.map(row)}
                                            {waitingData.length > 0 && (
                                                <h3 className="m-0 px-3.5 pt-3 pb-1 text-xs font-bold text-nature-600 dark:text-nature-300" data-testid="vouchers-waiting-heading">{waitingHeading()}</h3>
                                            )}
                                            {waitingData.map((w) => (
                                                <button
                                                    key={w.entryId}
                                                    type="button"
                                                    onClick={() => setShowMakeVoucherNotice(true)}
                                                    className="w-full text-left p-3.5 hover:bg-oat-50 dark:hover:bg-nature-800/50 transition-colors flex items-start justify-between gap-2 border-0 bg-transparent cursor-pointer"
                                                    data-testid="voucher-waiting-row"
                                                >
                                                    {/* The name is sealed in the names list, which only a phone can open. */}
                                                    <div className="flex-1 min-w-0 text-sm font-semibold text-nature-900 dark:text-white break-words">{waitingRowWords(w, null)}</div>
                                                </button>
                                            ))}
                                        </>
                                    );
                                })()}
                                <button
                                    type="button"
                                    onClick={() => setShowMakeVoucherNotice(true)}
                                    className="w-full text-left p-3.5 hover:bg-oat-50 dark:hover:bg-nature-800/50 transition-colors flex items-center gap-2 border-0 bg-transparent cursor-pointer text-sm font-bold text-bp-ink-accent"
                                    data-testid="make-voucher-button"
                                >
                                    {t('+ Make someone a voucher')}
                                </button>
                            </div>
                        </div>
                    )}
                    <h2 className="text-xl font-bold mb-2 text-nature-950 dark:text-white flex items-center gap-2">
                        {t('🎟️ Invite Someone')}
                    </h2>
                    <p className="text-nature-500 dark:text-nature-400 text-[14px] mb-6 leading-relaxed">
                        {t('Each invite code is single-use and valid for 30 days. Generate a new code for each person you invite.')}
                    </p>

                    {formOpen && (
                        <>
                        <input
                            type="text"
                            placeholder={t("A note for you, kept on your community's server")}
                            value={intendedFor}
                            onChange={e => setIntendedFor(e.target.value)}
                            className="w-full p-4 rounded-xl border border-nature-200 dark:border-nature-500 bg-white dark:bg-nature-900 text-nature-950 dark:text-white text-[15px] font-medium mb-4 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none shadow-sm transition-all"
                        />

                        {myVouching?.voucher && (
                            <VouchPresetChoice
                                value={vouchPreset}
                                onChange={setVouchPreset}
                                budgetLeft={myVouching.budget?.left ?? 0}
                                budgetTotal={myVouching.budget?.level ?? 0}
                                noLimit={myVouching.noLimit === true}
                            />
                        )}

                        {showsNamesBoxes && <InviteAddsBoxes />}

                        {isPreview ? (
                            <LocalCommunityAction feature="invites" label={t('✨ Generate New Invite')} className="w-full p-4 mb-6 text-[15px] shadow-md" {...waysForward} />
                        ) : (
                            <button
                                onClick={handleGenerate}
                                disabled={generating}
                                className={`w-full p-4 rounded-xl text-[15px] font-bold border-none cursor-pointer mb-6 transition-all shadow-md ${
                                    generating 
                                        ? 'bg-nature-400 text-white cursor-not-allowed' 
                                        : 'bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on hover:shadow-lg'
                                }`}
                            >
                                {generating ? t('Generating...') : t('✨ Generate New Invite')}
                            </button>
                        )}
                        {notice && (
                            <p role="alert" className="text-amber-700 dark:text-amber-400 text-[14px] -mt-3 mb-6 leading-relaxed">{refusalWords(notice)}</p>
                        )}

                        </>
                    )}
                    {isPreview && newCode && showQR && (
                        // The showcase's sample card (Example Valley): the marker actions, as it always was.
                        <div className="bg-oat-50 dark:bg-nature-950 border-2 border-emerald-500 rounded-2xl p-6 text-center mb-6 shadow-md transition-all" data-testid="invite-qr-card">
                            <p className="text-nature-600 dark:text-nature-400 text-[14px] font-medium mb-3">{t('Share this code with someone you trust')}</p>
                            <p className="font-mono font-bold text-nature-950 dark:text-white break-all mb-4 text-base sm:text-xl tracking-wider sm:tracking-widest" title={newCode}>
                                {newCode.length > 20 ? `${newCode.substring(0, 16)}...` : newCode.toUpperCase()}
                            </p>
                            <div className="bg-white rounded-xl p-4 inline-block mb-5 shadow-sm max-w-full">
                                <QRCodeSVGComponent value={newCode} size={200} className="block max-w-full h-auto" />
                            </div>
                            <div className="flex flex-col gap-2">
                                <LocalCommunityAction feature="invites" label={t('📋 Copy')} className="w-full py-3 px-6 text-[14px]" {...waysForward} />
                                <LocalCommunityAction feature="invites" label={t('Share')} className="w-full py-3 px-6 text-[14px]" {...waysForward} />
                            </div>
                        </div>
                    )}
                    {!isPreview && newCode && madeCard && madeCard.invite.code === newCode && (
                        <InviteMadeCard
                            who={madeCard.who}
                            invite={madeCard.invite}
                            now={Date.now()}
                            link={`${window.location.origin}/?invite=${newCode}`}
                            actions={
                                <>
                                        <button
                                            onClick={() => newCode && handleCopyProxy(newCode)}
                                            className={`py-3 px-6 rounded-xl border text-[14px] font-bold cursor-pointer transition-all ${
                                                copied
                                                    ? 'bg-emerald-100 border-emerald-500 text-emerald-700 dark:bg-emerald-900/50 dark:border-emerald-500 dark:text-emerald-400'
                                                    : 'bg-white dark:bg-nature-800 border-nature-200 dark:border-nature-700 text-nature-900 dark:text-white hover:bg-nature-50 dark:hover:bg-nature-700'
                                            }`}
                                            aria-label={t('Copy invite link')}
                                            title={t('Copy invite link')}
                                        >
                                            {copied ? t('✓ Copied!') : t('📋 Copy')}
                                        </button>
                                        <button
                                            onClick={() => newCode && handleShare(newCode)}
                                            className="py-3 px-6 rounded-xl border-none bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on text-[14px] font-bold cursor-pointer shadow-sm transition-all"
                                            aria-label={t('Share invite link')}
                                            title={t('Share invite link')}
                                        >
                                            {t('📤 Share')}
                                        </button>
                                </>
                            }
                            onRevoke={revokeMine}
                        />
                    )}
                    {!formOpen && (
                        <button
                            type="button"
                            onClick={() => setMakeAnother(true)}
                            className="w-full min-h-[44px] p-3 rounded-xl border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-800 text-nature-900 dark:text-white text-[15px] font-bold cursor-pointer mb-6 shadow-sm"
                            data-testid="invite-make-another"
                        >
                            {t('Make another invite')}
                        </button>
                    )}
                        </>
                    )}

                    {isPreview ? (
                        // The showcase's sample list (Example Valley), flat as it always was: every sample row, with its markers.
                        <>
                            {unusedInvites.length > 0 && (
                                <div className="mb-6">
                                    <h3 className="text-[13px] font-bold text-nature-500 dark:text-nature-400 mb-3 uppercase tracking-wider">{t('⏳ Pending ({count})', { count: unusedInvites.length })}</h3>
                                    {unusedInvites.map(inv => (
                                        <div key={inv.code} className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-xl p-4 mb-3 shadow-sm transition-transform hover:-translate-y-0.5">
                                            <div className="flex justify-between items-center">
                                                <div className="flex flex-col gap-1">
                                                    {inv.intendedFor && (
                                                        <span className="text-[13px] font-bold text-nature-600 dark:text-nature-400">
                                                            {t('For: {name}', { name: inv.intendedFor })}
                                                        </span>
                                                    )}
                                                    <span className="font-mono text-[14px] font-bold tracking-wider text-nature-950 dark:text-white break-all" title={inv.code}>
                                                        {inv.code.length > 20 ? `${inv.code.substring(0, 16)}...` : inv.code.toUpperCase()}
                                                    </span>
                                                </div>
                                                <div className="flex gap-2">
                                                    <button
                                                        onClick={() => { setNewCode(inv.code); setShowQR(prev => newCode === inv.code ? !prev : true); }}
                                                        className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center p-2 rounded-lg bg-oat-50 dark:bg-nature-800 border border-nature-200 dark:border-nature-700 text-nature-600 dark:text-nature-300 hover:bg-oat-100 dark:hover:bg-nature-700 dark:hover:text-nature-200 cursor-pointer transition-colors shadow-sm"
                                                        aria-label={t('Show QR code')}
                                                        title={t('Show QR code')}
                                                    >
                                                        📱
                                                    </button>
                                                </div>
                                            </div>
                                            <div className="mt-3 flex flex-col gap-2">
                                                <LocalCommunityAction feature="invites" label={t('📋 Copy')} aria-label={t('Copy invite link')} className="w-full py-2 px-3 text-[12px] justify-center" {...waysForward} />
                                                <LocalCommunityAction feature="invites" label={t('Share')} className="w-full py-2 px-3 text-[12px] justify-center" {...waysForward} />
                                            </div>
                                            <p className="text-nature-400 dark:text-nature-400 text-[11px] font-semibold mt-2 uppercase tracking-wide">
                                                {t('Created {date}', { date: dayWords(inv.createdAt) })}
                                            </p>
                                        </div>
                                    ))}
                                </div>
                            )}
                            {usedInvites.length > 0 && (
                                <div>
                                    <h3 className="text-[13px] font-bold text-nature-500 dark:text-nature-400 mb-3 uppercase tracking-wider mt-6">{t('✅ Redeemed ({count})', { count: usedInvites.length })}</h3>
                                    {usedInvites.map(inv => (
                                        <div key={inv.code} className="bg-oat-50 dark:bg-nature-950 border border-nature-200 dark:border-nature-800 rounded-xl p-4 mb-3 opacity-70">
                                            <div className="flex flex-col gap-1">
                                                {inv.intendedFor && (
                                                    <span className="text-[13px] text-nature-500 dark:text-nature-300 font-medium">
                                                        {t('For: {name}', { name: inv.intendedFor })}
                                                    </span>
                                                )}
                                                <span className="font-mono text-[13px] text-nature-500 dark:text-nature-300 line-through break-all" title={inv.code}>
                                                    {inv.code.length > 20 ? `${inv.code.substring(0, 16)}...` : inv.code.toUpperCase()}
                                                </span>
                                            </div>
                                            <p className="text-nature-400 dark:text-nature-300 text-[11px] font-semibold mt-2 uppercase tracking-wide">
                                                {inv.usedAt ? t('Used {date}', { date: dayWords(inv.usedAt) }) : t('Used')}
                                            </p>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </>
                    ) : (
                        <>
                            {adminsOnly && unusedInvites.length > 0 && (
                                <p className="text-nature-500 dark:text-nature-400 text-[13px] mb-3 leading-relaxed">
                                    {t('Codes you made earlier still work until they lapse, 30 days after they were made.')}
                                </p>
                            )}
                            <PendingInvites
                                invites={[...unusedInvites, ...usedInvites]}
                                now={Date.now()}
                                linkFor={(code) => `${window.location.origin}/?invite=${code}`}
                                shareFor={(code) => (
                                    <div className="flex gap-3 justify-center flex-wrap">
                                        <button
                                            onClick={() => code && handleCopyProxy(code)}
                                            className={`py-3 px-6 rounded-xl border text-[14px] font-bold cursor-pointer transition-all ${
                                                copied
                                                    ? 'bg-emerald-100 border-emerald-500 text-emerald-700 dark:bg-emerald-900/50 dark:border-emerald-500 dark:text-emerald-400'
                                                    : 'bg-white dark:bg-nature-800 border-nature-200 dark:border-nature-700 text-nature-900 dark:text-white hover:bg-nature-50 dark:hover:bg-nature-700'
                                            }`}
                                            aria-label={t('Copy invite link')}
                                            title={t('Copy invite link')}
                                        >
                                            {copied ? t('✓ Copied!') : t('📋 Copy')}
                                        </button>
                                        <button
                                            onClick={() => code && handleShare(code)}
                                            className="py-3 px-6 rounded-xl border-none bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on text-[14px] font-bold cursor-pointer shadow-sm transition-all"
                                            aria-label={t('Share invite link')}
                                            title={t('Share invite link')}
                                        >
                                            {t('📤 Share')}
                                        </button>
                                    </div>
                                )}
                                onRevoke={revokeMine}
                            />
                        </>
                    )}
                </div>
            )}

            {/* =================== TREE SECTION =================== */}
            {activeSection === 'tree' && (
                <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                    <h2 className="text-xl font-bold mb-2 text-nature-950 dark:text-white flex items-center gap-2">
                        {t('🌳 Community Tree')}
                    </h2>
                    <p className="text-nature-500 dark:text-nature-400 text-[14px] mb-6 leading-relaxed">
                        {t('Who invited whom. The tree shows how your community grows.')}
                    </p>

                    {tree.length === 0 ? (
                        <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-8 text-center text-nature-500 dark:text-nature-400 shadow-sm">
                            <p className="text-4xl mb-3">🌱</p>
                            <p className="font-medium">{t('No members yet. Generate an invite to start growing!')}</p>
                        </div>
                    ) : (
                        <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-4 shadow-sm" data-testid={isPreview ? 'invite-tree' : undefined}>
                            {tree.map(node => (
                                <TreeNodeView key={node.publicKey} node={node} depth={0} identity={identity} />
                            ))}
                        </div>
                    )}
                </div>
            )}
            {selectedVoucherPubkey && (
                <VoucherCardModal
                    memberPubkey={selectedVoucherPubkey}
                    onClose={() => setSelectedVoucherPubkey(null)}
                    onUpdated={() => {
                        void loadVouchersBlock();
                        void loadMyVouching();
                    }}
                />
            )}

            {showMakeVoucherNotice && <MakeVoucherNotice onClose={() => setShowMakeVoucherNotice(false)} />}
        </div>
    );
}

function localOfflineCodes(publicKey: string): Set<string> {
    try {
        const stored = localStorage.getItem(`bp_offline_invites_${publicKey}`);
        const list: InviteCode[] = stored ? JSON.parse(stored) : [];
        return new Set(list.map((i) => i.code));
    } catch { return new Set(); }
}

// =================== SUB-COMPONENTS ===================
function TreeNodeView({ node, depth, identity }: { node: TreeNode; depth: number; identity: BeanPoolIdentity }) {
    const [expanded, setExpanded] = useState(depth < 2);
    const isMe = node.publicKey === identity.publicKey;
    const hasChildren = node.children.length > 0;
    const joinDate = dayWords(node.joinedAt);

    return (
        <div className={`${depth > 0 ? 'ml-5' : 'ml-0'}`}>
            <div
                onClick={() => hasChildren && setExpanded(!expanded)}
                className={`flex items-center gap-3 py-2 px-1 rounded-lg transition-colors ${
                    hasChildren ? 'cursor-pointer hover:bg-oat-50 dark:hover:bg-nature-800/50' : 'cursor-default'
                } ${depth > 0 ? 'border-l-2 border-nature-200 dark:border-nature-700 pl-4' : ''}`}
            >
                {/* Expand/collapse */}
                <span className="text-[12px] text-nature-400 dark:text-nature-400 w-4 text-center">
                    {hasChildren ? (expanded ? '▼' : '▶') : '·'}
                </span>

                {/* Avatar dot */}
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold shrink-0 shadow-sm ${
                    isMe 
                        ? 'bg-bp-commit-fill text-bp-commit-on border-2 border-emerald-300 dark:border-emerald-800' 
                        : 'bg-oat-200 dark:bg-nature-800 text-nature-700 dark:text-nature-300'
                }`}>
                    {node.callsign.charAt(0).toUpperCase()}
                </div>

                {/* Name + info */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <span className={`text-[14px] font-bold truncate ${
                            isMe ? 'text-emerald-600 dark:text-emerald-500' : 'text-nature-900 dark:text-white'
                        }`}>
                            {node.callsign}
                        </span>
                        {isMe && (
                            <span className="text-[10px] font-bold uppercase tracking-wider bg-bp-chip-ok-tint text-bp-chip-ok-ink px-1.5 py-0.5 rounded-md border border-transparent">
                                {t('you')}
                            </span>
                        )}
                    </div>
                    <span className="text-[11px] font-medium text-nature-500 dark:text-nature-400 block mt-0.5">
                        {hasChildren
                            ? tn(node.children.length, 'Joined {date} · {n} invite', 'Joined {date} · {n} invites', { date: joinDate })
                            : t('Joined {date}', { date: joinDate })}
                    </span>
                </div>
            </div>

            {/* Children */}
            {expanded && hasChildren && (
                <div className="mt-1">
                    {node.children.map(child => (
                        <TreeNodeView key={child.publicKey} node={child} depth={depth + 1} identity={identity} />
                    ))}
                </div>
            )}
        </div>
    );
}
