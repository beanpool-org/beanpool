/**
 * The preview mode of the Ledger, the Commons' enterprises and Decide, and My Deals (scratch/global-node/
 * DESIGN-global-showcase-fable.md §1 rows 3, 5, 6; §2): the member's screen drawn from Example Valley, the sample
 * community in @beanpool/core, under the 🏘️ Local community strip. The ONLY web file that imports the sample.
 *
 * - **Nothing here talks to the node.** No fetch, no write: the sample is bundled, and every action that would move
 *   Beans, vote or pledge is a marker action that opens the sheet. The explainers stay live (CommonsInfoModal).
 * - **The Ledger is the real screen.** LedgerPage draws itself from `sampleLedger()` in preview, as the phone's Ledger
 *   does from components/showcase/sample-screens.ts; the Commons and My Deals previews are drawn here.
 * - **Obviously a sample.** The Example chip and dashed cards; nobody is named ("a neighbour").
 * - **Levels are merit badges**, never shown as locked; currency is Beans.
 */

import { useState } from 'react';
import { SAMPLE_COMMUNITY, LOCAL_COMMUNITY_STRIP, TIER_LEVELS, sampleRowNote, t, tn, type SampleDeal } from '@beanpool/core';
import { LocalCommunityAction, LocalCommunityPill, LocalCommunityStrip, type LocalCommunityWays } from './LocalCommunityMark';
import { CommonsInfoModal } from './CommonsInfoModal';
import type { BalanceInfo, InviteCode } from '../lib/api';

const S = SAMPLE_COMMUNITY;

const CARD = 'rounded-2xl border-2 border-dashed border-nature-300 dark:border-nature-600 bg-nature-50 dark:bg-nature-950 p-4';

function beans(n: number): string {
    const abs = Math.abs(n);
    const s = Number.isInteger(abs) ? String(abs) : abs.toFixed(1);
    return `${n < 0 ? '−' : n > 0 ? '+' : ''}${s} Beans`;
}

function ago(days: number): string {
    return days === 1 ? t('yesterday') : tn(days, '{n} day ago', '{n} days ago');
}

function ExampleChip() {
    return (
        <span className="inline-flex shrink-0 items-center rounded-full border border-dashed border-nature-400 dark:border-nature-500 px-2 py-0.5 text-[11px] font-black uppercase text-nature-600 dark:text-nature-300">
            Example
        </span>
    );
}

/** "Example Valley · an example member", with the Example chip. */
export function SampleHeader() {
    return (
        <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="sample-header">
            <ExampleChip />
            <span className="min-w-0 text-sm font-bold text-nature-700 dark:text-nature-200">{LOCAL_COMMUNITY_STRIP.header}</span>
        </div>
    );
}

/** One row of the Ledger's Wallet as LedgerPage draws it: in or out, its note, the small line under it, the Beans. */
export interface LedgerRowView {
    id: string;
    sent: boolean;
    note: string;
    when: string;
    amount: number;
}

/**
 * Example Valley's "example member" in the shapes LedgerPage reads, so the Ledger in preview is the member's own screen
 * fed the sample (design §1 row 3): the balance answer (85 Beans, floor −200, one live Offer, level 2 of 4 with the
 * sample's own trust, value traded, partners and rating, the figures the phone's Ledger reads too) and the recent rows,
 * newest first, each with who it was with and when; the held deal's row says its Beans are held in trust, and when.
 */
export function sampleLedger(): { member: string; balance: BalanceInfo; rows: LedgerRowView[] } {
    const c = SAMPLE_COMMUNITY;
    const tier = TIER_LEVELS[Math.max(0, Math.min(TIER_LEVELS.length - 1, c.level - 1))];
    return {
        member: c.member,
        balance: {
            balance: c.balance,
            floor: c.floor,
            usableFloor: c.floor,
            liveOffers: c.liveOffers,
            activated: true,
            frozen: false,
            knownGrant: 0,
            tier: { name: tier.name, emoji: tier.emoji },
            tierCredit: c.trust,
            earnedCredit: c.trust,
            qualifiedValue: c.valueTraded,
            avgRating: c.rating,
            reviewCount: c.reviews,
            commonsBalance: c.pool,
            callsign: c.member,
            trustStats: { tradeCount: c.transactions.filter(x => x.kind === 'trade' || x.kind === 'deal').length, uniquePartners: c.partners, ageDays: 0 },
        },
        rows: c.transactions.map(x => ({
            id: x.id,
            sent: x.amount < 0,
            note: sampleRowNote(x),
            when: x.kind === 'hold' ? ago(x.daysAgo)
                : x.amount < 0
                ? t('to {who} · {when}', { who: x.who, when: ago(x.daysAgo) })
                : t('from {who} · {when}', { who: x.who, when: ago(x.daysAgo) }),
            amount: Math.abs(x.amount),
        })),
    };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Example Valley's invitations in the shape InvitePage reads (design §1 row 8, Marty's 16 Oct pick):
 * - one pending invite (EXAMPLE-1234), waiting on a neighbour;
 * - two used invites (EXAMPLE-5678, EXAMPLE-9012), by the two members the example member brought in.
 */
export function sampleInvites(now: number = Date.now()): InviteCode[] {
    const at = (daysAgo: number) => new Date(now - daysAgo * DAY_MS).toISOString();
    return S.invites.map((inv) => ({
        code: inv.code,
        createdBy: 'sample-member-example',
        createdAt: at(inv.daysAgo),
        usedBy: inv.status === 'used' ? (inv.usedBy ?? 'sample-member-second') : null,
        usedAt: inv.status === 'used' ? at(inv.usedDaysAgo ?? inv.daysAgo) : null,
        intendedFor: inv.intendedFor ? t(inv.intendedFor) : undefined,
    }));
}

export interface SampleTreeNode {
    publicKey: string;
    callsign: string;
    joinedAt: string;
    inviteCode: string;
    children: SampleTreeNode[];
}

/**
 * The community invite tree for Example Valley (InvitePage): the example member at the root, and the two members they brought in.
 */
export function sampleInviteTree(viewerKey?: string, now: number = Date.now()): SampleTreeNode[] {
    const at = (daysAgo: number) => new Date(now - daysAgo * DAY_MS).toISOString();
    const tree = S.inviteTree;
    return [{
        publicKey: viewerKey ?? tree.id,
        callsign: t(tree.who),
        joinedAt: at(tree.joinedDaysAgo),
        inviteCode: 'EXAMPLE-ROOT',
        children: tree.invited.map((child) => ({
            publicKey: child.id,
            callsign: t(child.who),
            joinedAt: at(child.joinedDaysAgo),
            inviteCode: child.id === 'sample-member-second' ? 'EXAMPLE-5678' : 'EXAMPLE-9012',
            children: [],
        })),
    }];
}

/**
 * The Commons in preview: the pool and an enterprise where enterprises are previewed, a Decision where Decisions are,
 * each by its own mode, so a node that turns one on loses only that one's sample (design §4).
 */
export function CommonsPreview({ enterprises = true, decisions = true, ...ways }: { enterprises?: boolean; decisions?: boolean } & LocalCommunityWays) {
    const [commonsInfo, setCommonsInfo] = useState(false);
    const e = S.enterprises[0];
    const d = S.decisions[0];
    if (!enterprises && !decisions) return null;
    return (
        <div data-testid="commons-preview">
            <LocalCommunityStrip feature={enterprises ? 'enterprises' : 'decisions'} {...ways} />
            <SampleHeader />
            {enterprises && (<>
            <section className={`${CARD} mb-4`}>
                <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-bold uppercase tracking-wide text-nature-500 dark:text-nature-400">Commons pool</p>
                    <button type="button" onClick={() => setCommonsInfo(true)} className="-my-2 -mr-2 inline-flex min-h-[44px] min-w-[44px] items-center justify-center shrink-0 text-sm font-semibold text-blue-700 dark:text-blue-300" aria-label="How the Commons works">ⓘ</button>
                </div>
                <p className="text-2xl font-black text-nature-900 dark:text-nature-50">{S.pool} Beans</p>
            </section>
            <section className={`${CARD} mb-4`} data-testid="sample-enterprise">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                    <h3 className="font-bold text-nature-900 dark:text-nature-50">🏛️ {e.name}</h3>
                    <LocalCommunityPill />
                </div>
                <p className="text-sm text-nature-600 dark:text-nature-300">{e.what}</p>
                <p className="mt-1 text-sm text-nature-600 dark:text-nature-300">{e.keepers} keepers · this season {beans(e.season)}</p>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <LocalCommunityAction feature="enterprises" label="Pledge" className="w-full" {...ways} />
                    <LocalCommunityAction feature="enterprises" label="Pause" className="w-full" {...ways} />
                </div>
            </section>
            </>)}
            {decisions && (
            <section className={`${CARD} mb-4`} data-testid="sample-decision">
                <p className="text-xs font-bold uppercase tracking-wide text-nature-500 dark:text-nature-400">Decide · closes in {d.closesInDays} days</p>
                <h3 className="font-bold text-nature-900 dark:text-nature-50">{d.question}</h3>
                <p className="text-sm text-nature-600 dark:text-nature-300">{d.fromPool} Beans from the pool · {d.yesWeight} for, {d.noWeight} against</p>
                <div className="mt-3">
                    <LocalCommunityAction feature="decisions" label="Vote" className="w-full" {...ways} />
                </div>
            </section>
            )}
            <CommonsInfoModal isOpen={commonsInfo} onClose={() => setCommonsInfo(false)} commonsBalance={S.pool} />
        </div>
    );
}

/**
 * Where one sample deal stands, by its state as a node records it and the member's side, as the phone's My Deals reads
 * the same three (Action Required, Held in Trust, the sold + 30): `requested` holds nothing yet, and the member's Approve
 * is what holds the Beans; `pending` holds them until the job is done; `completed` and sold earned them, the Ledger's +30
 * row. Each state has its own branch, so a deal in a new state is never drawn as done.
 */
function DealLine({ deal: d, ...ways }: { deal: SampleDeal } & LocalCommunityWays) {
    const line = 'mb-2 text-sm text-nature-600 dark:text-nature-300';
    switch (d.state) {
        case 'requested':
            return (
                <div className="mt-3" data-testid="sample-deal-line">
                    <p className={line}>{t('A neighbour offered to do this. Approve to hold the Beans safely.')}</p>
                    <LocalCommunityAction feature="escrow" label={t('Approve and hold in trust')} className="w-full" {...ways} />
                </div>
            );
        case 'pending':
            return (
                <div className="mt-3" data-testid="sample-deal-line">
                    <p className={line}>{t('Held in trust until the job is done.')}</p>
                    <LocalCommunityAction feature="escrow" label={t('Approve and release')} className="w-full" {...ways} />
                </div>
            );
        case 'completed':
            return (
                <p className="mt-2 text-sm font-semibold text-emerald-700 dark:text-emerald-400" data-testid="sample-deal-line">
                    {d.side === 'sold' ? t('Done: you earned {beans}.', { beans: beans(d.amount) }) : t('Done: the Beans were released.')}
                </p>
            );
    }
}

export function DealsPreview(ways: LocalCommunityWays) {
    return (
        <div data-testid="deals-preview">
            <LocalCommunityStrip feature="escrow" {...ways} />
            <SampleHeader />
            <ul className="flex flex-col gap-3">
                {S.deals.map((d) => (
                    <li key={d.id} className={CARD} data-testid={`sample-deal-${d.id}`}>
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <p className="font-bold text-nature-900 dark:text-nature-50">{d.what}</p>
                                <p className="text-xs text-nature-500 dark:text-nature-400">with {d.who} · {ago(d.daysAgo)}</p>
                            </div>
                            <span className="shrink-0 font-bold tabular-nums text-nature-800 dark:text-nature-100">{d.state === 'completed' && d.side === 'sold' ? beans(d.amount) : `${d.amount} Beans`}</span>
                        </div>
                        <DealLine deal={d} {...ways} />
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** My Deals in preview, as a dialog over the Market. */
export function DealsPreviewDialog({ onClose, ...ways }: { onClose: () => void } & LocalCommunityWays) {
    return (
        <div className="fixed inset-0 z-[150] flex items-end justify-center bg-black/50 sm:items-center" onClick={onClose}>
            <div role="dialog" aria-modal="true" aria-label="My Deals" onClick={(e) => e.stopPropagation()}
                className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl sm:rounded-2xl bg-white dark:bg-nature-900 p-4 shadow-xl">
                <div className="mb-3 flex items-center justify-between gap-2">
                    <h2 className="text-lg font-extrabold text-nature-900 dark:text-nature-50">🤝 My Deals</h2>
                    <button type="button" onClick={onClose} aria-label="Close" className="-mr-2 inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-nature-500 dark:text-nature-400 hover:bg-nature-100 dark:hover:bg-nature-800 dark:hover:text-nature-200">✕</button>
                </div>
                <DealsPreview {...ways} />
            </div>
        </div>
    );
}
