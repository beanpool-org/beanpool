/**
 * LedgerPage — Balance, Standing, and Trade History
 *
 * Fetches real balance and transaction history from the BeanPool Node API.
 * Mirrors the native app's Trust Level and Financials tab layout and visualizations.
 *
 * In preview (a node that previews Beans, the showcase: scratch/global-node/DESIGN-global-showcase-fable.md §1 row 3) it is
 * the same screen drawn from Example Valley (ShowcasePreviews sampleLedger), as the phone's Ledger is: the strip and
 * "Example Valley · an example member" on top, and every press that would move Beans or export opens the marker's
 * sheet. It then asks the node nothing about the reader's own ledger: no balance, no transactions, no members.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { type BeanPoolIdentity } from '../lib/identity';
import {
    getBalance, getTransactions, sendTransfer, request,
    type BalanceInfo, type TierInfo, type Transaction, type Member
} from '../lib/api';
import { resolveAvatarUrl } from '../lib/avatar';
import { CommonsInfoModal } from '../components/CommonsInfoModal';
import { CreditBar } from '../components/CreditBar';
import { RepaymentCard } from '../components/RepaymentCard';
import { PER_COUNTERPARTY_VOLUME_CAP, PROTOCOL_CONSTANTS, TIER_LEVELS, memberLevel, BLOCKED_BEANS_NOTE, ledgerLineNote, type TierName } from '@beanpool/core';
import { withJitter } from '../lib/jitter';
import { onSyncActivity } from '../lib/sync';
import { getBlockedUsers, onBlocklistUpdated } from '../lib/blocklist';
import { useMembersOnDemand, useMemberSearch, getMembersWhole, MEMBERS_SEARCH_MIN_CHARS } from '../lib/members-on-demand';
import { creditLineCard, knownFrozenPartNote, frozenDebitLine, KNOWN_FROZEN_TITLE, KNOWN_FROZEN_BODY } from '../lib/credit-line-card';
import { LocalCommunityAction, LocalCommunityStrip, type LocalCommunityWays } from '../components/LocalCommunityMark';
import { SampleHeader, sampleLedger, type LedgerRowView } from '../components/ShowcasePreviews';
import { t, monthlyCirculation, CIRCULATION_FREE_BEANS } from '@beanpool/core';

interface Props extends LocalCommunityWays {
    /** Null only in preview: a visitor with no key reads Example Valley's ledger in the lobby (GuestLobby). */
    identity: BeanPoolIdentity | null;
    onNavigate?: (tab: string, contextId?: string) => void;
    /**
     * False for a guest — a local key the node has no member for. The node answers "Member not found"
     * for its balance, so a guest's balance is not fetched and no error is shown. Omitted means a member.
     */
    isMember?: boolean;
    /** Beans are previewed on this node: Example Valley's ledger, and the marker's sheet for every action (above). */
    preview?: boolean;
}

// Tiers are recognition milestones; where each starts comes from @beanpool/core TIER_LEVELS.
// `min` = the credit backing the floor (vouch + earned + granted); `floor` = the floor on ENTERING
// the tier (floors slide continuously between them). Only presentation lives here.
// The invite perk: not shown in preview, where inviting is off (global) and its Invites screen says so.
const INVITE_PERK = 'Invite others to join';
const TIER_LOOK: Record<TierName, { color: string; bg: string; border: string; blurb: string; perks: string[] }> = {
    Newcomer: { color: 'var(--tier-newcomer)', bg: 'var(--tier-newcomer-bg)', border: 'var(--tier-newcomer-border)',
      blurb: "Welcome. From day one you can browse, trade, receive credits and invite others — your first completed trade (or a community vouch) opens your credit line.",
      perks: ['Browse & trade the marketplace', 'Receive credits', INVITE_PERK, 'Send credits after first trade (needs positive balance)'] },
    Resident: { color: 'var(--tier-resident)', bg: 'var(--tier-resident-bg)', border: 'var(--tier-resident-border)',
      blurb: "You've traded real value with the community. Your credit line deepens with every trade — the more value you exchange, the deeper it grows.",
      perks: ['Credit floor deepens with the value you trade', INVITE_PERK] },
    Steward:  { color: 'var(--tier-steward)', bg: 'var(--tier-steward-bg)', border: 'var(--tier-steward-border)',
      blurb: "A trusted trader with a broad circle of partners. The community recognises you, and your credit line runs deeper still.",
      perks: ['Credit floor continues deepening', 'Trusted-trader recognition'] },
    Elder:    { color: 'var(--tier-elder)', bg: 'var(--tier-elder-bg)', border: 'var(--tier-elder-border)',
      blurb: "A pillar of the commons — the deepest possible credit line and the community's highest recognition.",
      perks: ['Credit floor can reach -2000 (the maximum)', 'Recognised as a community Elder'] },
};
const { CREDIT_MAX_EARNED, TRUST_CURVE_K, CREDIT_BASE_FLOOR } = PROTOCOL_CONSTANTS;
const TIERS = TIER_LEVELS.map(t => ({
    name: t.name, emoji: t.emoji, ...TIER_LOOK[t.name], min: t.minCredit, floor: CREDIT_BASE_FLOOR - t.minCredit,
}));

// Trust curve (from @beanpool/core): earned trust is a saturating function of qualified,
// diversity-capped trade VALUE. Floors slide continuously; gifts build no trust.
const PER_COUNTERPARTY_CAP = PER_COUNTERPARTY_VOLUME_CAP; // canonical 500 from @beanpool/core
// Inverse of the curve: qualified value needed to reach a target earned credit.
function valueForEarned(target: number): number {
    if (target <= 0) return 0;
    if (target >= CREDIT_MAX_EARNED) return Infinity;
    return Math.ceil((TRUST_CURVE_K * target) / (CREDIT_MAX_EARNED - target));
}

export function LedgerPage({ identity, onNavigate, isMember, preview = false, ...ways }: Props) {
    const viewerIsMember = isMember !== false && identity !== null;
    const myKey = identity?.publicKey ?? '';
    // Drawn from, never stored: a preview that turns live while the page is open never shows the sample as the member's own.
    // Built each render (it is small), so its words follow a change of language.
    const sample = preview ? sampleLedger() : null;
    // App learns guest status after mount, so a member-style refresh can still be in flight when this
    // flips to false; its failure must not put an error in front of the guest.
    const viewerIsMemberRef = useRef(viewerIsMember);
    viewerIsMemberRef.current = viewerIsMember;
    const [ownBalanceInfo, setBalanceInfo] = useState<BalanceInfo | null>(null);
    const balanceInfo = sample ? sample.balance : ownBalanceInfo;
    const [txns, setTxns] = useState<Transaction[]>([]);
    const [members, setMembers] = useState<Member[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<'trust' | 'financials'>('trust');
    const [selectedLevel, setSelectedLevel] = useState<number | null>(null);

    // Send form
    const [showSend, setShowSend] = useState(false);
    const [sendTo, setSendTo] = useState('');
    const [sendAmount, setSendAmount] = useState('');
    const [sendMemo, setSendMemo] = useState('');
    const [sending, setSending] = useState(false);

    // Search filter for recipient select dropdown
    const [memberSearch, setMemberSearch] = useState('');
    const [showMemberPicker, setShowMemberPicker] = useState(false);
    // With members on demand (the worldwide community) this page never reads the directory whole: the Send picker asks
    // the node by name and keeps the card picked (lib/members-on-demand; review of #1861, N1). Elsewhere the list is
    // read as before, once the node has said which it is.
    const membersOnDemand = useMembersOnDemand();
    const membersOnDemandRef = useRef<boolean | null>(null);
    membersOnDemandRef.current = membersOnDemand;
    const pickerSearch = useMemberSearch(memberSearch, membersOnDemand === true && showMemberPicker);
    const [pickedCard, setPickedCard] = useState<{ publicKey: string; callsign: string } | null>(null);
    const [showCommonsInfo, setShowCommonsInfo] = useState(false);
    // Beans from someone this member has blocked show BLOCKED_BEANS_NOTE in place of their note (@beanpool/core
    // ledgerLineNote): one the community kept from them already comes so, and this covers the rest.
    const [blocklistVersion, setBlocklistVersion] = useState(0);
    useEffect(() => onBlocklistUpdated(() => setBlocklistVersion(v => v + 1)), []);
    const blockedSet = useMemo(() => new Set(getBlockedUsers()), [blocklistVersion]);

    function renderMemoText(memo: string) {
        const sanitized = memo
            .replace(/escrow hold/gi, 'Held in trust')
            .replace(/escrow/gi, 'trust');
            
        const uuidRegex = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/;
        const match = sanitized.match(uuidRegex);
        if (match && onNavigate) {
            const offerId = match[1];
            const parts = sanitized.split(offerId);
            return (
                <span>
                    {parts[0]}
                    <button
                        onClick={() => onNavigate('marketplace', offerId)}
                        className="text-emerald-600 dark:text-emerald-400 font-bold hover:underline"
                        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', verticalAlign: 'baseline', font: 'inherit' }}
                    >
                        View Offer
                    </button>
                    {parts[1]}
                </span>
            );
        }
        return sanitized;
    }

    const lastRefreshTimeRef = useRef<number>(0);
    const refreshPromiseRef = useRef<Promise<void> | null>(null);
    // Guards the state writes below: this refresh is now also triggered by the socket, so it can
    // easily still be in flight when the member navigates away from the ledger.
    const isMountedRef = useRef(true);
    useEffect(() => {
        isMountedRef.current = true;
        return () => { isMountedRef.current = false; };
    }, []);

    const refresh = useCallback(async () => {
        if (!viewerIsMember || preview) {
            // Same approach as the enterprise page: a guest has no balance on the node, so don't ask.
            setError(null);
            setLoading(false);
            lastRefreshTimeRef.current = Date.now();
            return;
        }
        if (refreshPromiseRef.current) return refreshPromiseRef.current;
        const p = (async () => {
            try {
                const [bal, txn, mem] = await Promise.all([
                    getBalance(myKey).catch(() => null),
                    getTransactions(myKey).catch(() => []),
                    // null, not [], when the list couldn't be read (the node busy with heavy lists answers 503):
                    // the Send picker keeps who it had and the next refresh reads them again.
                    // Read only once the node has said it reads whole (the effect below reads them when it says so).
                    // A 403 members_on_demand turns the switch on (getMembersWhole): the picker then searches.
                    membersOnDemandRef.current === false ? getMembersWhole().catch(() => null) : null,
                ]);
                // The balance is the point of this screen, so a balance that failed to load is a
                // failed refresh even when the other two calls succeeded. Requiring ALL THREE to
                // fail meant a blip on getBalance alone left the previous balance on screen,
                // stamped the refresh as successful, and started the cooldown — so the stale
                // number could stand until the 300s backstop with no error shown.
                if (!bal) {
                    throw new Error('Failed to load balance');
                }
                if (!isMountedRef.current) return;
                setBalanceInfo(bal);
                setTxns(txn);
                if (mem) setMembers(mem.filter(m => m.publicKey !== myKey));
                setError(null);
                // Stamped on SUCCESS only. In `finally` a FAILED refresh counted as a refresh,
                // so the cooldown then suppressed the retry — a blip could leave the view stale
                // until the 300s backstop, which is exactly the window this stage widened.
                lastRefreshTimeRef.current = Date.now();
            } catch (e: any) {
                if (viewerIsMemberRef.current) setError(e.message || 'Failed to load');
                throw e;
            } finally {
                setLoading(false);
                refreshPromiseRef.current = null;
            }
        })();
        refreshPromiseRef.current = p;
        return p;
    }, [myKey, viewerIsMember, preview]);

    // The node has just said it reads whole: the list the refresh at open couldn't read yet, read once.
    useEffect(() => {
        if (membersOnDemand !== false || !viewerIsMember || preview) return;
        // Asked inside the promise, so a read that throws before it starts waits for the next refresh too.
        Promise.resolve()
            .then(() => getMembersWhole())
            .then(mem => { if (isMountedRef.current) setMembers(mem.filter(m => m.publicKey !== myKey)); })
            .catch(() => { /* the next refresh reads them again */ });
    }, [membersOnDemand, preview]);

    useEffect(() => {
        // In preview nothing is polled and the socket's nudges are not taken up: Example Valley never changes.
        if (preview) return;
        let interval: ReturnType<typeof setInterval> | null = null;

        const startPolling = () => {
            if (!interval) {
                refresh().catch(() => {});
                interval = setInterval(() => {
                    refresh().catch(() => {});
                }, withJitter(300_000));
            }
        };

        const stopPolling = () => {
            if (interval) {
                clearInterval(interval);
                interval = null;
            }
        };

        const handleVisibilityChange = () => {
            if (document.hidden) {
                stopPolling();
            } else {
                startPolling();
            }
        };

        if (!document.hidden) {
            startPolling();
        }

        document.addEventListener('visibilitychange', handleVisibilityChange);

        // Fast path: WebSocket broadcasts trigger coordinated sync.
        // Returns the in-flight or fresh promise to coordinator so delta cursor advances only on success.
        // Coalesces with visibilitychange / reconnect sync if already in-flight or refreshed within 2000ms.
        const unsubscribe = onSyncActivity(() => {
            if (document.hidden) return;
            if (refreshPromiseRef.current) return refreshPromiseRef.current;
            if (Date.now() - lastRefreshTimeRef.current < 2000) return;
            return refresh();
        });

        return () => {
            stopPolling();
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            unsubscribe();
        };
    }, [refresh, preview]);

    async function handleSend() {
        if (!sendTo || !sendAmount) return;
        // Sends are positive-balance only — you can only send beans you actually hold. Your credit
        // line (overdraft) is for trading, not for gifting yourself into debt.
        if (Number(sendAmount) > balance) {
            setError(`You can only send beans you hold — your balance is ${balance.toFixed(2)}B.`);
            return;
        }
        setSending(true);
        setError(null);
        try {
            await sendTransfer(myKey, sendTo, Number(sendAmount), sendMemo);
            setShowSend(false);
            setSendTo('');
            setSendAmount('');
            setSendMemo('');
            await refresh();
        } catch (e: any) {
            setError(e.message || 'Transfer failed');
        } finally {
            setSending(false);
        }
    }

    const balance = balanceInfo?.balance ?? 0;
    const floor = balanceInfo?.floor ?? 0;              // earned credit LIMIT (how deep you could go)
    const usableFloor = balanceInfo?.usableFloor ?? floor; // v3: how deep you may go NOW (gated by live offers)
    const liveOffers = balanceInfo?.liveOffers ?? 0;       // v3: currently-live Offer count
    const frozen = balanceInfo?.frozen ?? false;           // v3: debt below usable floor → spending paused
    const activated = balanceInfo?.activated;   // has a credit line at all (earned/vouched/granted)
    const earned = balanceInfo?.earnedCredit ?? 0;     // from the saturating value curve
    // The level and the trust figure behind it, from one source (memberLevel, @beanpool/core): the node's tier name and
    // its tierCredit, the credit that tier is read from (a freeze keeps the line held unfrozen), so the badge above and the
    // Levels card show one level. CREDIT_BASE_FLOOR − floor only from a node that sends no tierCredit.
    const level = memberLevel(balanceInfo);
    const totalCredit = level.credit;
    const ec = totalCredit;                            // "trust" shown to the user
    const notEarned = Math.max(0, totalCredit - earned); // vouch + grants — fixed, not grown by trading
    const qualifiedValue = balanceInfo?.qualifiedValue ?? 0;
    const avgRating = balanceInfo?.avgRating ?? 0;
    const reviewCount = balanceInfo?.reviewCount ?? 0;
    const canSend = balance > 0 && earned > 0;          // gate: positive balance AND at least 1 completed trade (earnedCredit > 0)
    const ts = balanceInfo?.trustStats;
    const uniquePartners = ts?.uniquePartners ?? 0;

    const tierIdx = level.index;
    const tier = TIERS[tierIdx];
    const nextTier = TIERS[tierIdx + 1] || null;
    const ELDER_MIN = TIERS[TIERS.length - 1].min;
    const journeyPct = Math.min(1, totalCredit / ELDER_MIN);
    const creditsToNext = nextTier ? Math.max(0, nextTier.min - totalCredit) : 0;

    // Value needed for the next tier: invert the curve for the earned credit it requires
    // (vouch + grants are fixed), minus value already traded → rough "new partners" count.
    const targetEarned = nextTier ? Math.max(0, nextTier.min - notEarned) : 0;
    const valueToNext = nextTier ? Math.max(0, valueForEarned(targetEarned) - qualifiedValue) : 0;
    const partnersToNext = nextTier && Number.isFinite(valueToNext)
        ? Math.max(1, Math.ceil(valueToNext / PER_COUNTERPARTY_CAP)) : 0;

    const selLevel = selectedLevel ?? tierIdx;
    const sel = TIERS[selLevel];
    const selReached = tierIdx >= selLevel;
    const selCurrent = tierIdx === selLevel;
    const selNeeded = Math.max(0, sel.min - ec);

    const hoursEquivalent = Math.abs(balance) / 40;

    // The Wallet's rows: the member's own, or Example Valley's in preview (who it was with, and when, under each).
    const rows: LedgerRowView[] = sample ? sample.rows : txns.map(tx => {
        const isSent = tx.from === myKey;
        return {
            id: tx.id,
            sent: isSent,
            note: ledgerLineNote({ incoming: !isSent, counterparty: tx.from, memo: tx.memo }, blockedSet),
            when: new Date(tx.timestamp).toLocaleString(),
            amount: tx.amount,
        };
    });

    // ⚡ Bolt: O(1) Map lookup for selected member recipient instead of O(M) .find() scans
    const membersMap = useMemo(() => new Map(members.map(m => [m.publicKey, m])), [members]);
    const selectedMember = membersMap.get(sendTo) ?? (pickedCard?.publicKey === sendTo ? pickedCard : undefined);
    const filteredMembers = members.filter(m => m.callsign.toLowerCase().includes(memberSearch.toLowerCase()));
    const pickable: Array<{ publicKey: string; callsign: string }> = membersOnDemand === true
        ? (pickerSearch.found ?? []).filter(m => m.publicKey !== myKey)
        : filteredMembers;
    // Said only once it is so: never "nobody" for a search that failed or hasn't answered yet.
    const pickerNote = membersOnDemand === false ? (filteredMembers.length === 0 ? 'No members found' : null)
        : membersOnDemand === null ? null
        : memberSearch.trim().length < MEMBERS_SEARCH_MIN_CHARS ? `Type at least ${MEMBERS_SEARCH_MIN_CHARS} letters of a name.`
        : pickerSearch.state === 'searching' ? 'Searching…'
        : pickerSearch.state === 'failed' ? (pickerSearch.refusal ?? "Couldn't search just now. Check your connection and try again.")
        : pickerSearch.found && pickable.length === 0 ? 'Nobody here has a name starting with that.'
        : null;

    return (
        <div className="p-4 md:p-6 max-w-6xl mx-auto min-h-full pb-24" data-testid={preview ? 'ledger-preview' : undefined}>
            {/* In preview: the strip, then "Example Valley · an example member" (design §1 row 3), as on the phone. */}
            {preview && <LocalCommunityStrip feature="beans" {...ways} />}
            {preview && <SampleHeader />}
            {/* Identity & Balance Overview */}
            <div className="flex flex-col md:flex-row gap-4 items-center justify-between p-6 bg-white dark:bg-nature-900 rounded-2xl border border-nature-200 dark:border-nature-800 shadow-sm mb-4">
                <div className="flex items-center gap-3">
                    <div className="w-14 h-14 shrink-0 rounded-full border-2 border-emerald-500 overflow-hidden bg-oat-50 dark:bg-nature-800 shadow-inner flex items-center justify-center">
                        <img src="/assets/logo-192x192.png" className="w-[70%] h-[70%] object-contain" alt="Identity" />
                    </div>
                    <div className="min-w-0">
                        <h2 className="text-lg font-bold text-nature-950 dark:text-white leading-tight">{sample ? sample.member : identity?.callsign}</h2>
                        <div className="mt-1 flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold bg-nature-100 dark:bg-nature-800 text-nature-600 dark:text-nature-300 border border-nature-200 dark:border-nature-700 w-fit">
                            <span>{tier.emoji}</span>
                            <span>{tier.name}</span>
                        </div>
                    </div>
                </div>

                <div className="text-right flex flex-col items-center md:items-end">
                    <span className={`text-2xl font-black font-mono ${balance >= 0 ? 'text-emerald-500' : 'text-red-500 dark:text-red-400'}`} data-testid="ledger-balance">
                        {balance >= 0 ? '+' : ''}{balance.toFixed(1)}B
                    </span>
                    <span className="text-[10px] font-bold text-nature-400 uppercase tracking-wider">Beans</span>
                </div>
            </div>

            {/* Credit position — zero is the sweet spot. A brand-new member (no trades yet) has no
                credit line (floor 0); their line opens automatically on their first real trade. */}
            {creditLineCard(balanceInfo ?? {}) === 'frozen' ? (
                <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl px-5 py-4 mb-4 shadow-sm" data-testid="ledger-known-frozen">
                    <div className="flex items-start gap-3 bg-sky-50 dark:bg-sky-950/30 border border-sky-200 dark:border-sky-800 rounded-xl p-3">
                        <span className="text-xl leading-none" aria-hidden="true">❄️</span>
                        <div>
                            <h2 className="text-sm font-extrabold text-sky-800 dark:text-sky-200">{KNOWN_FROZEN_TITLE}</h2>
                            <div className="text-xs text-nature-600 dark:text-nature-300 leading-relaxed mt-0.5">{KNOWN_FROZEN_BODY}</div>
                            {frozenDebitLine(balanceInfo?.balance) && (
                                <p className="text-xs font-bold text-nature-800 dark:text-nature-100 leading-relaxed mt-1.5" data-testid="ledger-frozen-debit">{frozenDebitLine(balanceInfo?.balance)}</p>
                            )}
                        </div>
                    </div>
                </div>
            ) : activated === false ? (
                <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl px-5 py-4 mb-4 shadow-sm">
                    <div className="flex items-start gap-3 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 rounded-xl p-3">
                        <span className="text-xl leading-none">🌱</span>
                        <div>
                            <div className="text-sm font-extrabold text-emerald-700 dark:text-emerald-300">No credit line yet</div>
                            <div className="text-xs text-nature-600 dark:text-nature-300 leading-relaxed mt-0.5">
                                You can trade right now with the beans you hold. Complete your first trade and your credit line opens automatically — the more value you trade, the deeper it grows. (A community voucher can also give you a starter line.)
                            </div>
                        </div>
                    </div>
                </div>
            ) : (
                <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl px-5 pt-3 pb-4 mb-4 shadow-sm">
                    {/* The bar itself now carries the offer ladder (locked zone, rungs, unlock caption). */}
                    <CreditBar balance={balance} floor={floor} usableFloor={usableFloor} liveOffers={liveOffers} knownGrant={balanceInfo?.knownGrant ?? 0} />
                    {knownFrozenPartNote(balanceInfo ?? {}) && (
                        <p className="text-xs text-nature-600 dark:text-nature-300 leading-relaxed mt-2">{knownFrozenPartNote(balanceInfo ?? {})}</p>
                    )}
                    {/* Frozen is the one state the ladder can't fully convey — call it out explicitly. */}
                    {frozen && (
                        <div className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
                            <span>⚠️</span>
                            <span>Spending paused — your balance is below what your {liveOffers} active offer{liveOffers === 1 ? '' : 's'} unlock (−{Math.abs(usableFloor)}). Post an Offer or trade back up to lift it. You can still receive and sell.</span>
                        </div>
                    )}
                </div>
            )}

            {/* Working off a debt (#1597): what is left, and Pay the Commons (a pay-back code from an admin). */}
            {viewerIsMember && !preview && <RepaymentCard onPaid={refresh} />}

            {/* Tab Bar */}
            <div className="flex bg-white dark:bg-nature-900 border-b border-nature-200 dark:border-nature-800 rounded-t-2xl shadow-sm overflow-hidden">
                <button
                    className={`flex-1 py-3 text-center border-b-2 font-bold text-sm bg-transparent cursor-pointer transition-all flex items-center justify-center gap-1.5 ${
                        activeTab === 'trust'
                            ? 'border-indigo-500 text-indigo-600 dark:text-indigo-300 font-extrabold'
                            : 'border-transparent text-nature-400 dark:text-nature-400 hover:text-nature-600 dark:hover:text-nature-200'
                    }`}
                    onClick={() => setActiveTab('trust')}
                >
                    🛡️ Levels
                </button>
                <button
                    className={`flex-1 py-3 text-center border-b-2 font-bold text-sm bg-transparent cursor-pointer transition-all flex items-center justify-center gap-1.5 ${
                        activeTab === 'financials'
                            ? 'border-indigo-500 text-indigo-600 dark:text-indigo-300 font-extrabold'
                            : 'border-transparent text-nature-400 dark:text-nature-400 hover:text-nature-600 dark:hover:text-nature-200'
                    }`}
                    onClick={() => setActiveTab('financials')}
                >
                    💸 Wallet
                </button>
            </div>

            {/* Tab Content */}
            {activeTab === 'trust' ? (
                <div className="flex flex-col gap-4 mt-4 animate-in fade-in duration-300">

                    {/* ── Standing hero ── */}
                    <div className="bg-white dark:bg-nature-900 border rounded-2xl p-5 shadow-sm relative" style={{ borderColor: tier.border, backgroundColor: tier.bg }}>
                        <div className="flex items-center gap-4">
                            {/* Circular progress ring around the emoji */}
                            <div className="shrink-0">
                                <svg width="80" height="80" viewBox="0 0 100 100">
                                    <circle cx="50" cy="50" r="42" fill="none" style={{ stroke: 'var(--tier-track)' }} strokeWidth="6" />
                                    <circle cx="50" cy="50" r="42" fill="none" style={{ stroke: tier.color }} strokeWidth="6"
                                        strokeLinecap="round"
                                        strokeDasharray={`${journeyPct * 263.9} 263.9`}
                                        transform="rotate(-90 50 50)" />
                                    <text x="50" y="60" textAnchor="middle" fontSize="32">{tier.emoji}</text>
                                </svg>
                            </div>
                            <div className="flex-1 min-w-0">
                                <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: tier.color }}>YOUR TRUST LEVEL</span>
                                <div className="text-2xl font-black leading-tight mt-0.5" style={{ color: tier.color }}>{tier.name}</div>
                                <div className="text-xs font-semibold text-nature-500 dark:text-nature-300 mt-1">Level {tierIdx + 1} of {TIERS.length} · {ec} trust</div>
                                <div className="text-xs font-semibold mt-2 text-nature-700 dark:text-nature-300">
                                    {nextTier
                                        ? <><span className="font-black" style={{ color: tier.color }}>{creditsToNext}</span> more trust to {nextTier.emoji} {nextTier.name}</>
                                        : <span className="text-amber-500 font-black">✨ Highest level reached</span>
                                    }
                                </div>
                            </div>
                        </div>

                        {/* Capability pills */}
                        <div className="flex flex-wrap gap-2 mt-4 pt-4 border-t border-nature-100 dark:border-nature-800" style={{ borderColor: tier.border }}>
                            {/* In preview Send is the marker's action, as on the Wallet tab: never a lock. */}
                            {preview ? <LocalCommunityAction feature="beans" label={t('Send Beans')} className="text-xs" {...ways} /> : <button
                                onClick={() => { if (canSend) { setActiveTab('financials'); setShowSend(true); } }}
                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-extrabold cursor-pointer transition-all ${canSend ? 'bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-950/40' : 'bg-nature-100 dark:bg-nature-800 border-nature-200 dark:border-nature-800 text-nature-400 dark:text-nature-300 cursor-default'}`}
                                style={{ font: 'inherit' }}
                            >
                                <span>{canSend ? '💸' : '🔒'}</span>
                                <span>{canSend ? t('Send Beans') : earned <= 0 ? 'Send (needs 1st trade)' : 'Send (needs +ve balance)'}</span>
                            </button>}
                            {/* Not in preview: inviting is off on a node that previews Beans (global), and its Invites tab says so. */}
                            {!preview && <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-extrabold bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800 text-emerald-600 dark:text-emerald-400">
                                <span>✓</span>
                                <span>Invite Members</span>
                            </div>}
                        </div>
                    </div>

                    {/* ── Medallion shelf ── */}
                    {/* Levels are merit badges (#1838): one not reached yet keeps its own colours and a dashed edge, something
                        to grow into. Never a lock, never faded or greyed as if it were out of bounds. */}
                    <div>
                        <span className="text-[10px] font-bold text-nature-400 uppercase tracking-widest block mb-3">ALL LEVELS</span>
                        <div className="grid grid-cols-4 gap-2" data-testid="levels-shelf">
                            {TIERS.map((t, i) => {
                                const reached = tierIdx >= i;
                                const isSel = selLevel === i;
                                return (
                                    <button
                                        key={t.name}
                                        type="button"
                                        aria-pressed={isSel}
                                        aria-label={`View ${t.name} level details`}
                                        onClick={() => setSelectedLevel(i)}
                                        className="flex flex-col items-center py-3 px-1 rounded-xl border-2 transition-all cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1"
                                        style={{
                                            background: isSel ? t.bg : 'var(--tier-card)',
                                            borderColor: isSel ? t.color : 'var(--tier-card-border)',
                                            borderStyle: reached || isSel ? 'solid' : 'dashed',
                                            fontFamily: 'inherit',
                                        }}
                                    >
                                        <span className="text-3xl leading-none">{t.emoji}</span>
                                        <span className="text-[11px] font-black mt-2 leading-tight" style={{ color: t.color }}>{t.name}</span>
                                        <span className="text-[9px] font-semibold text-nature-400 mt-1 leading-none">
                                            {tierIdx === i ? "You're here" : reached ? 'Reached' : `${t.min} trust`}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* ── Selected-level detail ── */}
                    <div className="bg-white dark:bg-nature-900 border rounded-2xl p-5 shadow-sm" style={{ borderColor: sel.border }} data-testid="level-detail">
                        {/* Wraps: at 320px with 1.3x text the level name and badge ran 22px past the card and
                            dragged the whole Ledger page sideways. */}
                        <div className="flex flex-wrap items-center gap-3 mb-4" data-testid="level-detail-heading">
                            <span className="text-3xl leading-none">{sel.emoji}</span>
                            <div className="flex-1 min-w-[7rem]">
                                <div className="text-xl font-black" style={{ color: sel.color }}>{sel.name}</div>
                                <div className="text-xs text-nature-400 font-semibold">Level {selLevel + 1} of {TIERS.length}</div>
                            </div>
                            <span className="text-xs font-bold px-3 py-1.5 rounded-xl border whitespace-nowrap" style={{ borderColor: sel.border, borderStyle: selReached ? 'solid' : 'dashed', backgroundColor: sel.bg, color: sel.color }}>
                                {selCurrent ? "You're here" : selReached ? 'Reached ✓' : selLevel === tierIdx + 1 ? 'Next level' : 'Up ahead'}
                            </span>
                        </div>

                        <p className="text-[13px] text-nature-700 dark:text-nature-300 leading-relaxed mb-4">{sel.blurb}</p>

                        {/* Credit floor — show YOUR actual floor when viewing your own tier */}
                        <div className="flex items-start gap-3 bg-nature-50 dark:bg-nature-800 border border-nature-200 dark:border-nature-700 rounded-xl p-3 mb-4">
                            <span className="mt-0.5">⚖️</span>
                            <div className="flex-1">
                                <div className="text-[13px] text-nature-600 dark:text-nature-300 font-semibold">
                                    {selCurrent ? 'Your current floor' : selReached ? 'Floor from this tier' : 'Floor starts at'}
                                </div>
                                {selCurrent && (
                                    <div className="text-[10px] text-nature-400 dark:text-nature-300 mt-0.5">Grows deeper as you trade more</div>
                                )}
                            </div>
                            <span className="text-xl font-black font-mono" style={{ color: sel.color }}>
                                {selCurrent ? floor : sel.floor}
                            </span>
                        </div>

                        <div className="flex flex-col gap-2">
                            {sel.perks.filter(p => !(preview && p === INVITE_PERK)).map(p => (
                                <div key={p} className="flex items-start gap-2 text-[13px]">
                                    <span className="mt-0.5 shrink-0" style={{ color: selReached ? '#10b981' : sel.color }}>{selReached ? '✓' : '○'}</span>
                                    <span className="text-nature-700 dark:text-nature-300">{p}</span>
                                </div>
                            ))}
                        </div>

                        {!selReached && selNeeded > 0 && (
                            <p className="text-[11px] text-nature-400 italic mt-4">Reach {sel.min} trust ({selNeeded} to go) from the real value you trade.</p>
                        )}
                        <p className="text-[11px] text-nature-400 italic mt-2">{preview
                            ? t("Levels are merit badges — they don't gate any action. Direct sends require a positive balance and one completed trade. Higher levels mean a deeper credit line and community recognition.")
                            : t("Levels are merit badges — they don't gate any action. Anyone can invite. Direct sends require a positive balance and one completed trade. Higher levels mean a deeper credit line and community recognition.")}</p>
                    </div>

                    {/* How to reach next tier */}
                    {nextTier && (
                        <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-5 shadow-sm">
                            <h3 className="font-extrabold text-[15px] text-nature-950 dark:text-white mb-2">🚀 Reach {nextTier.emoji} {nextTier.name}</h3>
                            <p className="text-sm font-black text-indigo-650 dark:text-indigo-300 mb-2">{creditsToNext} trust to go</p>
                            <p className="text-xs text-nature-500 dark:text-nature-400 leading-relaxed mb-4">
                                Trust grows with the real value you trade. Trading with someone NEW counts fastest —
                                value with any one partner is capped, so a wide circle beats repeat trades with the same person.
                            </p>
                            <div className="grid grid-cols-2 gap-3 text-center">
                                <div className="p-3 bg-emerald-50/50 dark:bg-emerald-950/20 border border-emerald-100 dark:border-emerald-900/40 rounded-xl relative">
                                    <div className="text-2xl font-black text-emerald-600 dark:text-emerald-400">{Number.isFinite(valueToNext) ? `~${valueToNext}` : '—'}</div>
                                    <div className="text-[9px] font-bold text-nature-400 uppercase mt-1">beans of value to trade</div>
                                    <span className="absolute -top-2 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded bg-bp-commit-fill text-bp-commit-on font-black text-[8px] uppercase tracking-wider">the lever</span>
                                </div>
                                <div className="p-3 bg-indigo-50/50 dark:bg-indigo-950/20 border border-indigo-100 dark:border-indigo-900/40 rounded-xl">
                                    <div className="text-2xl font-black text-indigo-600 dark:text-indigo-400">{partnersToNext || '—'}</div>
                                    <div className="text-[9px] font-bold text-nature-400 uppercase mt-1">new partners (roughly)</div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* What builds trust: value traded, a diverse circle of partners, and reputation */}
                    <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-4 sm:p-5 shadow-sm">
                        <span className="text-[10px] font-bold text-nature-400 uppercase tracking-widest block mb-4">WHAT BUILDS YOUR TRUST</span>
                        <div className="grid grid-cols-3 gap-1.5 sm:gap-3" data-testid="trust-builders">
                            {[
                                { icon: '💰', label: 'VALUE TRADED', big: `${qualifiedValue}`, foot: `+${earned} trust`, pct: Math.min(1, qualifiedValue / valueForEarned(ELDER_MIN)), color: '#10b981' },
                                { icon: '👥', label: 'PARTNERS', big: `${uniquePartners}`, foot: 'diverse = faster', pct: Math.min(1, uniquePartners / 20), color: '#3b82f6' },
                                { icon: '⭐', label: 'RATING', big: reviewCount > 0 ? avgRating.toFixed(1) : '—', foot: reviewCount > 0 ? `${reviewCount} review${reviewCount === 1 ? '' : 's'}` : 'no reviews yet', pct: reviewCount > 0 ? avgRating / 5 : 1, color: '#f97316' },
                            ].map(a => (
                                <div key={a.label} className="min-w-0 px-1.5 py-2 sm:p-3 border border-nature-200 dark:border-nature-800 rounded-xl flex flex-col justify-between">
                                    <div>
                                        <span className="text-xl">{a.icon}</span>
                                        <div className="text-lg font-black text-nature-950 dark:text-white mt-1 leading-none">{a.big}</div>
                                        <div className="text-[9px] font-bold text-nature-400 uppercase sm:tracking-wider mt-1 [overflow-wrap:anywhere]">{a.label}</div>
                                    </div>
                                    <div className="mt-3">
                                        <div className="w-full h-1 bg-nature-100 dark:bg-nature-900 rounded-full overflow-hidden">
                                            <div className="h-full rounded-full" style={{ width: `${Math.min(100, a.pct * 100)}%`, backgroundColor: a.color }} />
                                        </div>
                                        <span className="text-[8px] font-bold text-nature-400 mt-1 block">{a.foot}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    <span className="text-[10px] font-medium text-nature-400 dark:text-nature-400 text-center italic block">
                        💡 Trust is a saturating curve over the real value you trade — diverse trades climb fastest, and it levels off near the top so no one runs away. Gifts don't build trust.
                    </span>
                </div>
            ) : (
                <div className="flex flex-col gap-4 mt-4 animate-in fade-in duration-300" data-testid="ledger-wallet">
                    {/* Financials overview details. Two tiles side by side where each gets 9rem, else one above the
                        other: at 320 px with 1.3x text the pair pushed Commons Pool past the right edge. */}
                    <div className="flex flex-wrap gap-3" data-testid="ledger-wallet-tiles">
                        <div className="flex-1 basis-[9rem] min-w-0 bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-4 sm:p-5 text-center shadow-sm">
                            <p className="text-nature-500 dark:text-nature-400 text-sm font-semibold mb-2">Overdraft Floor</p>
                            <p className="text-2xl font-black font-mono text-nature-950 dark:text-white flex flex-wrap items-center justify-center gap-1 [overflow-wrap:anywhere]">
                                {floor}
                                <img src="/assets/bean.png" className="w-[18px] h-[18px]" alt="B" />
                            </p>
                            <p className="text-nature-400 text-[10px] mt-1 font-semibold">
                                ≈ {hoursEquivalent.toFixed(1)} hrs capacity
                            </p>
                        </div>

                        <button
                            onClick={() => setShowCommonsInfo(true)}
                            className="flex-1 basis-[9rem] min-w-0 bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-4 sm:p-5 text-center shadow-sm hover:bg-nature-50 dark:hover:bg-nature-800 hover:border-nature-300 dark:hover:border-nature-700 transition-all cursor-pointer focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                        >
                            <p className="text-nature-500 dark:text-nature-300 text-sm font-semibold mb-2 flex items-center justify-center gap-1">
                                Commons Pool <span className="text-xs text-nature-400 dark:text-nature-300">ⓘ</span>
                            </p>
                            <p className="text-2xl font-black font-mono text-amber-500 flex flex-wrap items-center justify-center gap-1 [overflow-wrap:anywhere]">
                                {(balanceInfo?.commonsBalance ?? 0).toFixed(1)}
                                <img src="/assets/bean.png" className="w-[18px] h-[18px]" alt="B" />
                            </p>
                            <p className="text-nature-500 dark:text-nature-300 text-[10px] mt-1 font-semibold">
                                🌱 View Solvency & Tax
                            </p>
                        </button>
                    </div>

                    {/* Send credits */}
                    {/* In preview the marker's action: it keeps its place, and opens the sheet. */}
                    {preview ? (
                    <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-5 shadow-sm">
                        <LocalCommunityAction feature="beans" label={t('Send Beans')} className="w-full text-sm sm:text-[15px]" {...ways} />
                    </div>
                    ) : (
                    <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-5 shadow-sm">
                        {!canSend && (
                            <div className="bg-nature-50 dark:bg-nature-900/50 border border-nature-200 dark:border-nature-800 rounded-xl p-3 mb-4 text-center">
                                <p className="text-xs text-nature-500 dark:text-nature-400 font-medium">
                                    {earned <= 0
                                        ? '🔒 Direct sends unlock after your first completed trade on the Marketplace, and require a positive balance.'
                                        : '🔒 You can only send beans you currently hold — direct sends require a positive balance.'}
                                </p>
                            </div>
                        )}
                        <button
                            onClick={() => canSend && setShowSend(!showSend)}
                            disabled={!canSend}
                            className={`w-full p-4 rounded-xl text-sm sm:text-[15px] break-words font-bold border-none cursor-pointer transition-all shadow-md ${
                                !canSend ? 'bg-nature-100 dark:bg-nature-800 text-nature-500 cursor-not-allowed opacity-60' :
                                showSend ? 'bg-nature-800 text-white hover:bg-nature-900' : 'bg-bp-commit-fill text-bp-commit-on hover:bg-bp-commit-hover'
                            }`}
                        >
                            {!canSend
                                ? (earned <= 0 ? '🔒 Send Beans (needs 1 completed trade)' : '🔒 Send Beans (needs positive balance)')
                                : showSend ? '✕ Cancel' : <><span>💸</span> <span>{t('Send Beans')}</span></>}
                        </button>

                        {/* Send Form */}
                        {showSend && (
                            <div className="animate-in fade-in slide-in-from-top-2 bg-nature-50 dark:bg-nature-950 border border-nature-200 dark:border-nature-800 rounded-2xl p-4 mt-4 shadow-inner">
                                <div className="relative mb-3">
                                    <button
                                        onClick={() => setShowMemberPicker(!showMemberPicker)}
                                        className="w-full p-3.5 rounded-xl border border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-950 text-nature-900 dark:text-white text-[15px] font-medium text-left flex justify-between items-center shadow-sm cursor-pointer"
                                    >
                                        <span>{selectedMember?.callsign || 'Select recipient...'}</span>
                                        <span className="text-nature-400 text-xs">▼</span>
                                    </button>

                                    {showMemberPicker && (
                                        <div className="absolute left-0 right-0 mt-1 bg-white dark:bg-nature-950 border border-nature-200 dark:border-nature-700 rounded-xl shadow-xl z-20 max-h-56 overflow-y-auto">
                                            <input
                                                type="text"
                                                placeholder="Search members..."
                                                value={memberSearch}
                                                onChange={(e) => setMemberSearch(e.target.value)}
                                                className="w-full p-3 border-b border-nature-100 dark:border-nature-700 bg-transparent text-sm focus:outline-none text-nature-900 dark:text-white"
                                            />
                                            {pickerNote ? (
                                                <div className="p-4 text-xs text-nature-400 text-center" data-testid="ledger-picker-note">{pickerNote}</div>
                                            ) : (
                                                pickable.map(m => (
                                                    <button
                                                        key={m.publicKey}
                                                        onClick={() => { setSendTo(m.publicKey); setPickedCard({ publicKey: m.publicKey, callsign: m.callsign }); setShowMemberPicker(false); setMemberSearch(''); }}
                                                        className={`w-full p-3 text-left text-sm hover:bg-nature-50 dark:hover:bg-nature-900 flex justify-between items-center cursor-pointer border-none bg-transparent ${sendTo === m.publicKey ? 'bg-emerald-50 dark:bg-emerald-950/20 text-emerald-600 dark:text-emerald-400' : 'text-nature-900 dark:text-white'}`}
                                                    >
                                                        <span className="font-bold">{m.callsign}</span>
                                                        <span className="text-[10px] font-mono opacity-50">{m.publicKey.slice(0, 10)}...</span>
                                                    </button>
                                                ))
                                            )}
                                        </div>
                                    )}
                                </div>

                                <input
                                    type="number"
                                    placeholder="Amount (B)"
                                    value={sendAmount}
                                    onChange={(e) => setSendAmount(e.target.value)}
                                    min="0.01"
                                    step="0.01"
                                    className="w-full p-3.5 rounded-xl border border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-950 text-nature-900 dark:text-white text-[15px] font-medium mb-3 focus:ring-2 focus:ring-[#d97757] outline-none shadow-sm transition-all"
                                />
                                <input
                                    type="text"
                                    placeholder="Memo (optional)"
                                    value={sendMemo}
                                    onChange={(e) => setSendMemo(e.target.value)}
                                    className="w-full p-3.5 rounded-xl border border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-950 text-nature-900 dark:text-white text-[15px] font-medium mb-4 focus:ring-2 focus:ring-[#d97757] outline-none shadow-sm transition-all"
                                />
                                {(() => {
                                    const parsedAmount = parseFloat(sendAmount);
                                    if (!isNaN(parsedAmount) && parsedAmount > 0) {
                                        // Peer transfers are fee-free — recipient receives the full amount.
                                        return (
                                            <div className="bg-nature-100 dark:bg-nature-900 rounded-xl p-3 mb-4 text-xs space-y-1.5 border border-nature-200 dark:border-nature-800">
                                                <div className="flex justify-between items-center text-nature-700 dark:text-nature-300">
                                                    <span>Recipient receives:</span>
                                                    <span className="font-mono font-bold text-nature-950 dark:text-white">{parsedAmount.toFixed(2)} B</span>
                                                </div>
                                            </div>
                                        );
                                    }
                                    return null;
                                })()}
                                <button
                                    onClick={handleSend}
                                    disabled={sending || !sendTo || !sendAmount}
                                    className={`w-full p-3.5 rounded-xl text-[15px] font-bold border-none transition-all shadow-md ${
                                        sending || !sendTo || !sendAmount
                                            ? 'bg-nature-300 dark:bg-nature-800 text-nature-500 cursor-not-allowed'
                                            : 'bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on cursor-pointer'
                                    }`}
                                >
                                    {sending ? 'Sending...' : 'Confirm Transfer'}
                                </button>
                            </div>
                        )}
                    </div>
                    )}

                    {/* Community Circulation: the ledger's own monthly demurrage (monthlyCirculation, core's one copy of the
                        brackets), on the chip roles so it reads as a card in light and dark. At or under the fee-free line it
                        says so in words rather than showing a zero. */}
                    {balance > 0 && (() => {
                        const monthly = monthlyCirculation(balance);
                        const showAmber = balance > 1000;
                        // Two decimals; a sliver over the line shows as <0.01 rather than a zero that reads broken.
                        const twoDp = (n: number) => (n < 0.005 ? '<0.01' : n.toFixed(2));

                        return (
                            <div className={`rounded-2xl p-4 shadow-sm border border-nature-200 dark:border-nature-800 ${showAmber ? 'bg-bp-chip-warn-tint text-bp-chip-warn-ink' : 'bg-bp-chip-ok-tint text-bp-chip-ok-ink'}`} data-testid="ledger-circulation">
                                <div className="flex justify-between items-center gap-2">
                                    <span className="text-[13px] font-bold"><span aria-hidden="true">🌿 </span>{t('Community Circulation')}</span>
                                    {monthly > 0 && (
                                        <span className="text-[13px] font-bold font-mono flex items-center" data-testid="ledger-circulation-amount">
                                            −{twoDp(monthly)}
                                            <img src="/assets/bean.png" className="w-[14px] h-[14px] ml-0.5" alt="B" />
                                        </span>
                                    )}
                                </div>
                                <p className="text-[11px] mt-2 font-medium">
                                    {monthly > 0
                                        ? t('Goes to the Commons each month: about {rate}% of your balance. It funds community projects.', { rate: twoDp((monthly / balance) * 100) })
                                        : t('Nothing goes to the Commons while you hold {free} Beans or less.', { free: String(CIRCULATION_FREE_BEANS) })}
                                </p>
                            </div>
                        );
                    })()}

                    {/* Transaction history */}
                    <div className={preview ? 'flex flex-wrap justify-between items-center gap-2 mb-1 px-1' : 'flex justify-between items-center mb-1 px-1'}>
                        <h3 className="text-lg font-bold text-nature-950 dark:text-white">Recent Transactions</h3>
                        {preview ? <LocalCommunityAction feature="beans" label={t('Export mine')} className="text-[11px]" {...ways} /> : <button
                            onClick={async () => {
                                try {
                                    // Signed: the node answers with this member's own balance and transactions only (balances and
                                    // trades are private, 2026-09-28), never the whole community's.
                                    const data = await request<{ balancesCsv: string; transactionsCsv: string }>('GET', '/api/ledger/export');
                                    
                                    const balBlob = new Blob([data.balancesCsv], { type: 'text/csv' });
                                    const balUrl = window.URL.createObjectURL(balBlob);
                                    const balA = document.createElement('a');
                                    balA.href = balUrl;
                                    balA.download = 'beanpool_my_balance.csv';
                                    balA.click();
                                    window.URL.revokeObjectURL(balUrl);
                                    
                                    setTimeout(() => {
                                        const txBlob = new Blob([data.transactionsCsv], { type: 'text/csv' });
                                        const txUrl = window.URL.createObjectURL(txBlob);
                                        const txA = document.createElement('a');
                                        txA.href = txUrl;
                                        txA.download = 'beanpool_my_transactions.csv';
                                        txA.click();
                                        window.URL.revokeObjectURL(txUrl);
                                    }, 500);
                                } catch (e) {
                                    console.error('Export failed', e);
                                    alert(`Export failed${e instanceof Error && e.message ? `: ${e.message}` : ''}`);
                                }
                            }}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-nature-100 dark:bg-nature-800 text-nature-700 dark:text-nature-300 rounded-lg text-[11px] font-bold hover:bg-nature-200 dark:hover:bg-nature-700 dark:hover:text-nature-200 transition-colors border border-nature-200 dark:border-nature-700 shadow-sm cursor-pointer"
                        >
                            ⬇️ Export mine
                        </button>}
                    </div>

                    {rows.length === 0 ? (
                        <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-8 text-center text-nature-500 dark:text-nature-400 text-[14px] shadow-sm font-medium">
                            No transactions yet. Start trading on the Marketplace!
                        </div>
                    ) : (
                        <div className="flex flex-col gap-2.5">
                            {rows.map(({ id, sent: isSent, note, when, amount }) => {
                                return (
                                    <div key={id} className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-xl p-4 flex justify-between items-center shadow-sm transition-transform hover:-translate-y-0.5">
                                        <div>
                                            <p className={`text-[14px] font-bold ${isSent ? 'text-nature-900 dark:text-white' : 'text-emerald-700 dark:text-emerald-400'}`}>
                                                {isSent ? '↑ Sent' : '↓ Received'}
                                            </p>
                                            {note === BLOCKED_BEANS_NOTE ? (
                                                <p className="text-[13px] italic text-nature-500 dark:text-nature-400 mt-1 leading-snug">
                                                    {BLOCKED_BEANS_NOTE}
                                                </p>
                                            ) : note && (
                                                <p className="text-[13px] text-nature-700 dark:text-nature-400 mt-1 leading-snug">
                                                    {renderMemoText(note)}
                                                </p>
                                            )}
                                            <p className="text-[11px] font-bold text-nature-400 mt-1.5 uppercase tracking-wide">
                                                {when}
                                            </p>
                                        </div>
                                        <p style={{ whiteSpace: 'nowrap' }} className={`text-lg font-bold font-mono ${isSent ? 'text-red-500 dark:text-red-300' : 'text-emerald-500 dark:text-emerald-400'} flex items-center`}>
                                            {isSent ? '−' : '+'}{amount.toFixed(1)}
                                            <img src="/assets/bean.png" className="w-4 h-4 ml-1" alt="B" />
                                        </p>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            {error && !preview && (
                <div className="animate-in fade-in bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 rounded-xl p-3 mt-4 text-red-650 dark:text-red-400 text-sm text-center font-bold shadow-sm">
                    {error}
                </div>
            )}

            <CommonsInfoModal 
                isOpen={showCommonsInfo} 
                onClose={() => setShowCommonsInfo(false)} 
                commonsBalance={balanceInfo?.commonsBalance ?? 0} 
            />
        </div>
    );
}
