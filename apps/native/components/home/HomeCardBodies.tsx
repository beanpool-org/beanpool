import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import type { AppColors } from '../../constants/colors';
import { POST_CATEGORIES, categoryEmoji, categoryLabel } from '../../constants/categories';
import { MemberAvatar } from '../MemberAvatar';
import { ExampleListings } from '../ExampleListings';
import { resolvePulseThumbnailUrl } from '../../utils/pulse';
import { eventHomeWhen, formatDistance } from '../../utils/events';
import { closesInWords, type NeedsYouEntry } from '../../utils/needs-you';
import {
    SEARCH_OFFLINE_LINE, searchEmptyLine, searchFirstLine,
    RSVP_SAID, RSVP_WORDS, beansAmount, beansLines, communityLines, dealsLine, decideLines, enterpriseLine, eventLine,
    groupLine, joinedLine, joinedNames, needsLineA11y, pulseTitle, sentence, DECIDE_HREF, formatBeans,
    communitiesListed, decideOnNode, timeAgoInWords,
    type HomeAnswer, type HomeCards, type HomeMarketItem, type HomeSearchCard, type StepLine,
} from '../../utils/home-cards';
import { TIPS_DONT_SHOW, TIPS_DONT_SHOW_LABEL, formatCount, listPhotoUrl, readSearchSettings, t, tipsNextLabel, tn, type SkyToday, type TierName, type TipsView } from '@beanpool/core';
import { TIER_WORDS } from '../../utils/trust-tier';
import { getBundledGuide } from '../../utils/guide';
import { FabAware, HOME_TARGET_DP, HomeButton, HomeLink, HomeRow, communityLinksStyle, homeStyles } from './HomeParts';

/**
 * What each Home card says (design §3.1, §9), from the answer the screen holds. Every line is one target into a screen
 * that already exists; the words come from utils/home-cards.ts.
 */

/** Lines kept as word() in utils/home-cards.ts and core, shown here in the member's language. */
const LINES = { searchOffline: SEARCH_OFFLINE_LINE, tipsDontShow: TIPS_DONT_SHOW, tipsDontShowLabel: TIPS_DONT_SHOW_LABEL };

/** A path from the node ("/api/…") made an address on it; a full address as it is. */
export function onNode(nodeUrl: string | null, path: string | null | undefined): string | null {
    if (!path) return null;
    if (/^https?:\/\//i.test(path)) return path;
    if (!nodeUrl || !path.startsWith('/')) return null;
    return `${nodeUrl.replace(/\/+$/, '')}${path}`;
}

export function NeedsBody({ entries, colors, onOpen }: { entries: NeedsYouEntry[]; colors: AppColors; onOpen: (e: NeedsYouEntry) => void }) {
    const s = homeStyles(colors);
    return (
        <>
            {entries.map(e => (
                <HomeRow
                    key={e.kind}
                    colors={colors}
                    text={e.label}
                    a11y={needsLineA11y(e)}
                    strong={e.accent}
                    onPress={() => onOpen(e)}
                    testID={`home-needs-${e.kind}`}
                    // Never colour alone (§10): the accent is a ▲ too, and the words say it.
                    left={<Text style={[s.trailing, { width: 14, color: e.accent ? colors.feedback.warning.fg : colors.text.muted }]} importantForAccessibility="no">{e.accent ? '▲' : '•'}</Text>}
                />
            ))}
        </>
    );
}

export function StepsBody({ lines, note, colors, onStep }: {
    lines: StepLine[];
    /** The global node's new-account limits in a sentence (utils/home-cards.ts `probationSentence`), under the lines. */
    note?: string | null;
    colors: AppColors;
    onStep: (id: StepLine['id']) => void;
}) {
    const s = homeStyles(colors);
    const offerUndone = lines.some(l => l.id === 'offer' && !l.done);
    return (
        <>
            {lines.map(l => (
                <HomeRow
                    key={l.id}
                    colors={colors}
                    text={l.text}
                    a11y={l.done ? t('{step}, done', { step: l.text }) : t('{step}, not done yet', { step: l.text })}
                    onPress={l.done ? undefined : () => onStep(l.id)}
                    testID={`home-step-${l.id}`}
                    left={<Text style={[s.trailing, { fontSize: 18, color: l.done ? colors.brand.primary : colors.text.secondary }]} importantForAccessibility="no">{l.done ? '☑' : '☐'}</Text>}
                />
            ))}
            {!!note && <Text style={[s.note, { marginTop: 4 }]} testID="home-steps-limits">{note}</Text>}
            {offerUndone && (
                <FabAware id="steps:offer" style={s.buttonRow}>
                    <HomeButton primary colors={colors} text={t('Post an Offer')} onPress={() => onStep('offer')} testID="home-step-post-offer" />
                </FabAware>
            )}
        </>
    );
}

export function InterestsBody({ interests, colors, onToggle }: { interests: readonly string[]; colors: AppColors; onToggle: (id: string) => void }) {
    const s = homeStyles(colors);
    return (
        <>
            <Text style={s.note}>{t('Tap a few. What you star comes first here and in the Market.')}</Text>
            <FabAware id="interests:chips" style={s.chips}>
                {POST_CATEGORIES.map(c => {
                    const on = interests.includes(c.id);
                    const label = categoryLabel(c.id);
                    return (
                        <Pressable
                            key={c.id}
                            onPress={() => onToggle(c.id)}
                            style={({ pressed }) => [s.chip, on && s.chipOn, pressed && !on && s.pressed]}
                            accessibilityRole="button"
                            accessibilityState={{ selected: on }}
                            accessibilityLabel={on ? t('{category}, starred', { category: label }) : t('{category}, not starred', { category: label })}
                            testID={`home-interest-${c.id}`}
                        >
                            <Text style={[s.chipText, on && s.chipTextOn]}>{c.emoji} {label}{on ? ' ★' : ''}</Text>
                        </Pressable>
                    );
                })}
            </FabAware>
        </>
    );
}

export function DealsBody({ card, colors }: { card: NonNullable<HomeCards['deals']>; colors: AppColors }) {
    if (card.items && card.items.length > 0) {
        return (
            <>
                {card.items.slice(0, 3).map(item => {
                    const line = item.with
                        ? t('{title} · with {name}', { title: item.title, name: item.with })
                        : item.title;
                    const waitText = item.waitsOnMe ? t('waiting on you') : t('waiting on them');
                    const when = timeAgoInWords(item.at);
                    const sub = when ? `${waitText} · ${when}` : waitText;
                    const a11y = t('{line} {sub} Opens the deal.', { line: sentence(line), sub: sentence(sub) });
                    return (
                        <HomeRow
                            key={item.txId}
                            colors={colors}
                            text={line}
                            sub={sub}
                            strong={item.waitsOnMe}
                            a11y={a11y}
                            onPress={() => router.push({ pathname: '/post/[id]', params: { id: item.postId, txId: item.txId } })}
                            testID={`home-deal-${item.txId}`}
                        />
                    );
                })}
                <HomeLink
                    id="deals:all"
                    colors={colors}
                    text={t('All deals')}
                    a11y={t('All deals, in the Market')}
                    onPress={() => router.push({ pathname: '/(tabs)/market', params: { tab: 'deals' } })}
                    testID="home-deals-all"
                />
            </>
        );
    }
    const line = dealsLine(card);
    const w = card.waitingOnMe;
    return (
        <HomeRow
            colors={colors}
            text={line}
            a11y={w ? t('{line} Opens the deal.', { line: sentence(line) }) : t('{line} Opens your deals.', { line: sentence(line) })}
            strong={!!w}
            onPress={() => (w
                ? router.push({ pathname: '/post/[id]', params: { id: w.postId, txId: w.txId } })
                : router.push({ pathname: '/(tabs)/market', params: { tab: 'deals' } }))}
            testID="home-deals-line"
        />
    );
}

export function EnterpriseBody({ card, colors }: { card: NonNullable<HomeCards['enterprise']>; colors: AppColors }) {
    const s = homeStyles(colors);
    if (typeof card.keepers === 'number') {
        const lifecycleWord = card.lifecycle === 'bounded' ? t('project') : t('enterprise');
        const nameLine = t('{name} · {lifecycle}', { name: card.name, lifecycle: lifecycleWord });
        const balanceLine = typeof card.balance === 'number'
            ? t('Balance {balance} · {keepers}', {
                balance: beansAmount(card.balance),
                keepers: tn(card.keepers, '{n} keeper', '{n} keepers', { n: card.keepers }),
            })
            : tn(card.keepers, '{n} keeper', '{n} keepers', { n: card.keepers });
        const openTreasury = () => router.push({ pathname: '/treasury-detail', params: { publicKey: card.id, name: card.name } });

        let monthLine: string | null = null;
        if (card.month) {
            monthLine = t('This month: {trades} · +{in} in · −{out} out', {
                trades: tn(card.month.trades, '{n} trade', '{n} trades', { n: formatCount(card.month.trades) }),
                in: formatBeans(card.month.in),
                out: formatBeans(card.month.out),
            });
        }

        let latestLine: string | null = null;
        if (card.latest) {
            const sign = card.latest.amount > 0 ? '+' : '';
            const amountStr = `${sign}${beansAmount(card.latest.amount)}`;
            const when = timeAgoInWords(card.latest.at);
            if (card.latest.who && when) {
                latestLine = t('Latest: {amount} from {who} · {when}', { amount: amountStr, who: card.latest.who, when });
            } else if (card.latest.who) {
                latestLine = t('Latest: {amount} from {who}', { amount: amountStr, who: card.latest.who });
            } else if (when) {
                latestLine = t('Latest: {amount} · {when}', { amount: amountStr, when });
            } else {
                latestLine = t('Latest: {amount}', { amount: amountStr });
            }
        }

        const requestsText = card.requests > 0
            ? tn(card.requests, '{n} request to approve', '{n} requests to approve', { n: card.requests })
            : null;

        return (
            <>
                <HomeRow
                    colors={colors}
                    text={nameLine}
                    a11y={card.lifecycle === 'bounded' ? t('{name}. Opens the project.', { name: card.name }) : t('{name}. Opens the enterprise.', { name: card.name })}
                    onPress={openTreasury}
                    testID="home-enterprise-name"
                />
                <HomeRow
                    colors={colors}
                    text={balanceLine}
                    a11y={typeof card.balance === 'number'
                        ? t('{line}. Opens the enterprise ledger.', { line: balanceLine })
                        : (card.lifecycle === 'bounded'
                            ? t('{line}. Opens the project.', { line: balanceLine })
                            : t('{line}. Opens the enterprise.', { line: balanceLine }))}
                    onPress={openTreasury}
                    testID="home-enterprise-balance"
                />
                {monthLine && (
                    <HomeRow
                        colors={colors}
                        text={monthLine}
                        a11y={t('{line}. Opens the enterprise ledger.', { line: monthLine })}
                        onPress={openTreasury}
                        testID="home-enterprise-month"
                    />
                )}
                {latestLine && (
                    <HomeRow
                        colors={colors}
                        text={latestLine}
                        a11y={t('{line}. Opens the enterprise ledger.', { line: latestLine })}
                        onPress={openTreasury}
                        testID="home-enterprise-latest"
                    />
                )}
                {requestsText && (
                    <HomeRow
                        colors={colors}
                        text={requestsText}
                        strong
                        a11y={t('{requests}. Opens Manage.', { requests: requestsText }, "Manage: an enterprise's keepers' console")}
                        onPress={() => router.push({ pathname: '/treasury-manage', params: { publicKey: card.id, name: card.name } })}
                        testID="home-enterprise-requests"
                    />
                )}
                {card.others > 0 && (
                    <Text style={s.trailing}>{tn(card.others, 'and {n} more you keep', 'and {n} more you keep')}</Text>
                )}
            </>
        );
    }
    const line = enterpriseLine(card);
    // Its requests are approved in its keepers' console (S7), never on its page: with any waiting, the line opens Manage.
    // The card is only ever a keeper's (home-answer keeperOf).
    const manage = card.requests > 0;
    return (
        <HomeRow
            colors={colors}
            text={card.name}
            sub={line}
            strong
            a11y={manage
                ? t('{name}: {line} Opens Manage.', { name: card.name, line: sentence(line) }, "Manage: an enterprise's keepers' console")
                : card.lifecycle === 'bounded'
                    ? t('{name}: {line} Opens the project.', { name: card.name, line: sentence(line) })
                    : t('{name}: {line} Opens the enterprise.', { name: card.name, line: sentence(line) })}
            onPress={() => router.push({ pathname: manage ? '/treasury-manage' : '/treasury-detail', params: { publicKey: card.id, name: card.name } })}
            testID="home-enterprise-line"
        />
    );
}

export function EventsBody({ card, colors }: { card: NonNullable<HomeCards['events']>; colors: AppColors }) {
    const s = homeStyles(colors);
    return (
        <>
            {card.items.map(e => {
                const rsvp = e.rsvp ? t(RSVP_WORDS[e.rsvp]) : null;
                const far = formatDistance(e.distanceKm);
                const trailing = [rsvp, far].filter(Boolean).join(' · ');
                // Whole sentences for the screen reader, each in the member's language, said one after another.
                const what = e.place ? t('{title}, at {place}', { title: e.title, place: e.place }) : e.title;
                const when = t('{when}: {what}', { when: eventHomeWhen(e), what: sentence(what) });
                const marked = e.rsvp ? t(RSVP_SAID[e.rsvp]) : null;
                const away = far ? t('{distance} away.', { distance: far }) : null;
                const opens = t('Opens the event.');
                return (
                    <HomeRow
                        key={e.id}
                        colors={colors}
                        text={eventLine(e)}
                        a11y={[when, marked, away, opens].filter(Boolean).join(' ')}
                        onPress={() => router.push({ pathname: '/post/[id]', params: { id: e.id } })}
                        right={trailing ? <Text style={s.trailing}>{trailing}</Text> : undefined}
                        testID={`home-event-${e.id}`}
                    />
                );
            })}
            <HomeLink id="events:all" colors={colors} text={t('All events')} a11y={t('All events, in the Market')}
                onPress={() => router.push({ pathname: '/(tabs)/market', params: { filter: 'events' } })} testID="home-events-all" />
        </>
    );
}

function Thumb({ uri, emoji, colors }: { uri: string | null; emoji: string; colors: AppColors }) {
    const s = homeStyles(colors);
    if (uri) return <Image source={{ uri }} style={s.thumb} contentFit="cover" accessibilityIgnoresInvertColors />;
    return <View style={[s.thumb, s.thumbEmpty]}><Text style={{ fontSize: 22 }} importantForAccessibility="no">{emoji}</Text></View>;
}

export function MarketBody({ items, examples, nodeUrl, showsBeans, colors, onSeeAll }: {
    items: HomeMarketItem[];
    examples: boolean;
    nodeUrl: string | null;
    showsBeans: boolean;
    colors: AppColors;
    onSeeAll: () => void;
}) {
    return (
        <>
            {items.map(p => <MarketRow key={p.id} p={p} nodeUrl={nodeUrl} showsBeans={showsBeans} colors={colors} testID={`home-market-${p.id}`} />)}
            {/* A node that asks for them, with fewer than a handful of real listings: the made-up ones, each marked Example (§6.1). */}
            {examples && <View style={{ marginHorizontal: -14 }}><ExampleListings /></View>}
            <HomeLink id="market:all" colors={colors} text={t('See all')} a11y={t('See all listings in the Market')} onPress={onSeeAll} testID="home-market-all" />
        </>
    );
}

/** One listing as the Market card draws it: photo, title, price or distance, Offer or Need; opens the listing. */
function MarketRow({ p, nodeUrl, showsBeans, colors, testID }: { p: HomeMarketItem; nodeUrl: string | null; showsBeans: boolean; colors: AppColors; testID: string }) {
    const s = homeStyles(colors);
    const type = p.type === 'need' ? colors.market.need : colors.market.offer;
    const word = p.type === 'need' ? t('NEED') : t('OFFER');
    const price = showsBeans && typeof p.credits === 'number' && p.credits > 0 ? beansAmount(p.credits) : null;
    const far = formatDistance(p.distanceKm);
    const facts = [price, far].filter(Boolean).join(' · ');
    const category = categoryLabel(p.category);
    const values = { title: sentence(p.title), facts, category };
    const a11y = p.type === 'need'
        ? (facts ? t('Need: {title} {facts}. {category}. Opens the listing.', values) : t('Need: {title} {category}. Opens the listing.', values))
        : (facts ? t('Offer: {title} {facts}. {category}. Opens the listing.', values) : t('Offer: {title} {category}. Opens the listing.', values));
    return (
        <HomeRow
            colors={colors}
            text={p.title}
            sub={facts || category}
            a11y={a11y}
            onPress={() => router.push({ pathname: '/post/[id]', params: { id: p.id } })}
            left={<Thumb uri={listPhotoUrl(onNode(nodeUrl, p.photoUrl))} emoji={categoryEmoji(p.category)} colors={colors} />}
            subBadge={<View style={[s.badge, { backgroundColor: type.bg }]}><Text style={[s.badgeText, { color: type.fg }]} maxFontSizeMultiplier={1.2}>{word}</Text></View>}
            testID={testID}
        />
    );
}

/** One line per place (utils/home-cards.ts `decideLines`): Decisions open Commons → Decide, polls the Market's Polls. */
export function DecideBody({ card, features, colors, now }: { card: NonNullable<HomeCards['decide']>; features: HomeAnswer['features']; colors: AppColors; now: number }) {
    if ((card.items && card.items.length > 0) || card.poll) {
        return (
            <>
                {(card.items || []).slice(0, 3).map(item => {
                    const closes = closesInWords(item.closesAt, now);
                    const vote = item.voted ? t('You voted') : t('Not yet');
                    const sub = `${closes} · ${vote}`;
                    const subA11y = t('{closes}, {vote}', { closes, vote });
                    const a11y = t('{title} {sub} Opens Decide.', {
                        title: sentence(item.title),
                        sub: sentence(subA11y),
                    });
                    return (
                        <HomeRow
                            key={item.id}
                            colors={colors}
                            text={item.title}
                            sub={sub}
                            a11y={a11y}
                            onPress={() => router.push(DECIDE_HREF)}
                            testID={`home-decide-${item.id}`}
                        />
                    );
                })}
                {card.poll && (
                    <HomeRow
                        colors={colors}
                        text={t('Poll: {title}', { title: card.poll.title })}
                        sub={closesInWords(card.poll.closesAt, now)}
                        a11y={t('Poll: {title} {closes} Opens the poll.', {
                            title: sentence(card.poll.title),
                            closes: sentence(closesInWords(card.poll.closesAt, now)),
                        })}
                        onPress={() => router.push({ pathname: '/post/[id]', params: { id: card.poll!.id } })}
                        testID="home-decide-poll"
                    />
                )}
                {decideOnNode(features) && (card.items?.length ?? 0) > 0 && (
                    <HomeLink id="decide:all" colors={colors} text={t('Decide')} a11y={t('Open Decide, in Commons')}
                        onPress={() => router.push(DECIDE_HREF)} testID="home-decide-all" />
                )}
            </>
        );
    }
    return (
        <>
            {decideLines(card, features, now).map(l => (
                <HomeRow key={l.id} colors={colors} text={l.text} a11y={l.a11y} onPress={() => router.push(l.href)} testID={`home-decide-${l.id}`} />
            ))}
        </>
    );
}

export function GroupsBody({ card, colors }: { card: NonNullable<HomeCards['groups']>; colors: AppColors }) {
    return (
        <>
            {card.items.map(g => {
                const line = groupLine(g);
                let sub: string | null = null;
                if (g.last) {
                    const when = timeAgoInWords(g.last.at);
                    if (g.last.who && when) {
                        sub = t('{who}, {when}: {text}', { who: g.last.who, when, text: g.last.text });
                    } else if (g.last.who) {
                        sub = t('{who}: {text}', { who: g.last.who, text: g.last.text });
                    } else {
                        sub = g.last.text;
                    }
                }
                return (
                    <HomeRow
                        key={g.id}
                        colors={colors}
                        text={line}
                        sub={sub}
                        strong={g.unread > 0 && !g.muted}
                        a11y={sub
                            ? t('{line} {sub} Opens the chat.', { line: sentence(line), sub: sentence(sub) })
                            : t('{line} Opens the chat.', { line: sentence(line) })}
                        onPress={() => router.push(g.kind === 'event'
                            ? { pathname: '/chat/[id]', params: { id: g.id, event: '1' } }
                            : { pathname: '/chat/[id]', params: { id: g.id, [g.kind]: '1' } })}
                        testID={`home-group-${g.id}`}
                    />
                );
            })}
            {card.total > card.items.length && (
                <HomeLink id="groups:all" colors={colors} text={tn(card.total, 'All {n} group', 'All {n} groups')} a11y={tn(card.total, 'Your {n} group, in Talk', 'All {n} of your groups, in Talk')}
                    onPress={() => router.push({ pathname: '/(tabs)/chats', params: { view: 'groups' } })} testID="home-groups-all" />
            )}
        </>
    );
}

/** Faces and names on a local community; on the global node a count by area and nothing to open (utils/home-cards.ts `joinedNames`). */
export function JoinedBody({ card, profile, colors }: { card: NonNullable<HomeCards['joined']>; profile: string; colors: AppColors }) {
    const s = homeStyles(colors);
    const line = joinedLine(card, profile);
    const names = joinedNames(card, profile);
    return (
        <>
            <HomeRow
                colors={colors}
                text={line}
                a11y={names.length ? t('{line} Opens People.', { line }) : line}
                onPress={names.length ? () => router.push('/(tabs)/people') : undefined}
                left={names.length ? (
                    <View style={s.faces} importantForAccessibility="no-hide-descendants">
                        {names.slice(0, 3).map((n, i) => (
                            <View key={`${n.callsign}-${i}`} style={{ marginLeft: i ? -10 : 0 }}>
                                <MemberAvatar avatarUrl={n.avatarUrl} pubkey={n.callsign} callsign={n.callsign} size={32} />
                            </View>
                        ))}
                    </View>
                ) : undefined}
                testID="home-joined-line"
            />
        </>
    );
}

export function PulseBody({ card, nodeUrl, colors }: { card: NonNullable<HomeCards['pulse']>; nodeUrl: string | null; colors: AppColors }) {
    return (
        <>
            {card.items.map(p => {
                const title = pulseTitle(p);
                const when = timeAgoInWords(p.publishedAt);
                const sub = when
                    ? t('by {name} · {when}', { name: p.callsign, when })
                    : t('by {name}', { name: p.callsign });
                const a11y = when
                    ? t('{title}, by {name}, {when}. Opens the Pulse.', { title, name: p.callsign, when })
                    : t('{title}, by {name} Opens the Pulse.', { title, name: sentence(p.callsign) });
                return (
                    <HomeRow
                        key={p.id}
                        colors={colors}
                        text={title}
                        sub={sub}
                        a11y={a11y}
                        onPress={() => router.push('/(tabs)/pulse')}
                        left={<Thumb uri={resolvePulseThumbnailUrl(nodeUrl, p)} emoji="📡" colors={colors} />}
                        testID={`home-pulse-${p.id}`}
                    />
                );
            })}
            <HomeLink id="pulse:all" colors={colors} text={t('See all')} a11y={t('See all of the Pulse')} onPress={() => router.push('/(tabs)/pulse')} testID="home-pulse-all" />
        </>
    );
}

export function BeansBody({ card, colors }: { card: NonNullable<HomeCards['beans']>; colors: AppColors }) {
    const s = homeStyles(colors);
    const { main, sub } = beansLines(card);
    if (card.month) {
        const monthText = t('This month: {trades} · +{in} in · −{out} out', {
            trades: tn(card.month.trades, '{n} trade', '{n} trades', { n: formatCount(card.month.trades) }),
            in: formatBeans(card.month.in),
            out: formatBeans(card.month.out),
        });
        const tier = card.tier && Object.prototype.hasOwnProperty.call(TIER_WORDS, card.tier) ? t(TIER_WORDS[card.tier as keyof typeof TIER_WORDS]) : card.tier || null;
        const tierKey = card.tier ? card.tier.toLowerCase() : undefined;
        const trustToken = tierKey && tierKey !== 'star' && tierKey in colors.trust
            ? colors.trust[tierKey as 'resident' | 'newcomer' | 'parent' | 'steward' | 'elder' | 'founding']
            : colors.trust.resident;
        const badgeNode = tier ? (
            <View style={[s.badge, { backgroundColor: trustToken.bg, borderColor: trustToken.border, borderWidth: 1 }]}>
                <Text style={[s.badgeText, { color: trustToken.fg }]} maxFontSizeMultiplier={1.2}>{tier}</Text>
            </View>
        ) : undefined;
        const operationalSub = (card.frozen || !card.activated) ? sub : undefined;
        return (
            <>
                <HomeRow
                    colors={colors}
                    text={main}
                    sub={operationalSub}
                    strong
                    a11y={operationalSub
                        ? t('{main} {sub} Opens your Ledger.', { main: sentence(main), sub: sentence(operationalSub) })
                        : t('{main} Opens your Ledger.', { main: sentence(main) })}
                    onPress={() => router.push('/(tabs)/ledger')}
                    testID="home-beans-line"
                />
                <HomeRow
                    colors={colors}
                    text={monthText}
                    lines={3}
                    right={badgeNode}
                    a11y={tier ? t('{month}. {tier}. Opens your Ledger.', { month: monthText, tier }) : t('{month}. Opens your Ledger.', { month: monthText })}
                    onPress={() => router.push('/(tabs)/ledger')}
                    testID="home-beans-month"
                />
            </>
        );
    }
    return (
        <HomeRow colors={colors} text={main} sub={sub} strong
            a11y={sub ? t('{main} {sub} Opens your Ledger.', { main: sentence(main), sub: sentence(sub) }) : t('{main} Opens your Ledger.', { main: sentence(main) })}
            onPress={() => router.push('/(tabs)/ledger')} testID="home-beans-line" />
    );
}

export function NoticesBody({ card, colors, onOpen }: { card: NonNullable<HomeCards['notices']>; colors: AppColors; onOpen: (id: string) => void }) {
    const more = card.unseen - 1;
    const values = { title: sentence(card.first.title), line: sentence(card.first.line) };
    return (
        <HomeRow colors={colors} text={card.first.title} sub={more > 0 ? tn(more, '{line} · {n} more', '{line} · {n} more', { line: card.first.line }) : card.first.line} strong
            a11y={more > 0 ? tn(more, '{title} {line} {n} more unread. Opens it.', '{title} {line} {n} more unread. Opens it.', values) : t('{title} {line} Opens it.', values)}
            onPress={() => onOpen(card.first.id)} testID="home-notice-line" />
    );
}

export function InviteBody({ colors }: { colors: AppColors }) {
    const s = homeStyles(colors);
    return (
        <FabAware id="invite:button" style={s.buttonRow}>
            <HomeButton colors={colors} text={t('Invite someone')} onPress={() => router.push({ pathname: '/(tabs)/people', params: { view: 'invites' } })} testID="home-invite" />
        </FabAware>
    );
}

/**
 * The community's card, last on Home, with the frame's two ways in (CARD-FRAME §1.1): "Add a card ›" and "Edit home ›",
 * each its own 48 dp target in a row that wraps (at 320 dp with text at 1.3× they stand on two rows, right-aligned).
 */
export function CommunityBody({ card, profile, invitesOn, colors, onAdd, onEdit }: {
    card: HomeCards['community'] | undefined;
    profile: string;
    invitesOn: boolean;
    colors: AppColors;
    /** Absent for a visitor, who tailors nothing here (utils/home-cards.ts `canTailor`). */
    onAdd?: () => void;
    onEdit?: () => void;
}) {
    const isFirstMember = profile !== 'global' && (card?.members ?? 0) <= 1;
    const hasNarrowSlice = !isFirstMember && card && (card.joined7d !== undefined || card.commonsPot !== undefined || card.eventsSoon !== undefined || (profile === 'global' && card.listings !== undefined));
    if (hasNarrowSlice) {
        const membersStr = tn(card.members, '{n} member', '{n} members', { n: formatCount(card.members) });
        const joinedStr = typeof card.joined7d === 'number'
            ? tn(card.joined7d, '{n} joined this week', '{n} joined this week', { n: formatCount(card.joined7d) })
            : null;
        const row1Text = joinedStr ? t('{members} · {joined}', { members: membersStr, joined: joinedStr }) : membersStr;

        const tradesStr = typeof card.tradesThisMonth === 'number'
            ? tn(card.tradesThisMonth, '{n} trade this month', '{n} trades this month', { n: formatCount(card.tradesThisMonth) })
            : null;
        const potStr = typeof card.commonsPot === 'number'
            ? t('Commons pot {amount}', { amount: beansAmount(card.commonsPot) })
            : null;
        const communitiesStr = typeof card.communities === 'number'
            ? communitiesListed(card.communities)
            : null;
        const row2Text = profile === 'global'
            ? communitiesStr
            : (tradesStr && potStr
                ? t('{trades} · {pot}', { trades: tradesStr, pot: potStr })
                : (tradesStr || potStr || null));

        const listingsStr = typeof card.listings === 'number'
            ? tn(card.listings, '{n} listing', '{n} listings', { n: formatCount(card.listings) })
            : null;
        const eventsStr = typeof card.eventsSoon === 'number'
            ? tn(card.eventsSoon, '{n} event coming up', '{n} events coming up', { n: formatCount(card.eventsSoon) })
            : null;
        const row3Text = listingsStr && eventsStr
            ? t('{listings} · {events}', { listings: listingsStr, events: eventsStr })
            : (listingsStr || eventsStr || null);

        return (
            <>
                <HomeRow colors={colors} text={row1Text} a11y={row1Text} lines={2} testID="home-community-row-members" />
                {row2Text && <HomeRow colors={colors} text={row2Text} a11y={row2Text} lines={2} testID="home-community-row-trades" />}
                {row3Text && <HomeRow colors={colors} text={row3Text} a11y={row3Text} lines={2} testID="home-community-row-listings" />}
                {(onAdd || onEdit) && (
                    <View style={communityLinksStyle}>
                        {onAdd && <HomeLink id="community:add" colors={colors} text={t('Add a card')} a11y={t('Add a card to Home')} onPress={onAdd} testID="home-add-card" />}
                        {onEdit && <HomeLink id="community:edit" colors={colors} text={t('Edit home')} a11y={t('Edit home: move or remove cards')} onPress={onEdit} testID="home-edit" />}
                    </View>
                )}
            </>
        );
    }
    const { line } = communityLines(card, profile, invitesOn);
    return (
        <>
            {!!line && <HomeRow colors={colors} text={line} a11y={line} lines={3} testID="home-community-line" />}
            {(onAdd || onEdit) && (
                <View style={communityLinksStyle}>
                    {onAdd && <HomeLink id="community:add" colors={colors} text={t('Add a card')} a11y={t('Add a card to Home')} onPress={onAdd} testID="home-add-card" />}
                    {onEdit && <HomeLink id="community:edit" colors={colors} text={t('Edit home')} a11y={t('Edit home: move or remove cards')} onPress={onEdit} testID="home-edit" />}
                </View>
            )}
        </>
    );
}

/**
 * Tips (scratch/home/TIPS-DESIGN-fable.md §1, §5): one tip, its whole text; Next (Done on the last) and Read more when the
 * tip names a guide page, in a band the floating button steps aside for; then "Don't show tips again", full width,
 * allowed to wrap. Next is the same element from tip to tip, so focus stays on it.
 */
export function TipsBody({ view, colors, onNext, onReadMore, onDontShow }: {
    view: TipsView;
    colors: AppColors;
    onNext: () => void;
    onReadMore: (slug: string) => void;
    onDontShow: () => void;
}) {
    const s = homeStyles(colors);
    const slug = view.tip.guide;
    const page = slug ? getBundledGuide().guides.find(g => g.slug === slug) : undefined;
    return (
        <>
            <Text style={{ fontSize: 15, lineHeight: 21, color: colors.text.body }} testID="home-tip-text">{t(view.tip.text)}</Text>
            <FabAware id="tips:buttons" style={s.buttonRow}>
                <HomeButton primary colors={colors} text={view.last ? t('Done') : t('Next')} a11y={tipsNextLabel(view)} onPress={onNext} testID="home-tip-next" />
                {page && slug && (
                    <HomeButton colors={colors} text={t('Read more')} a11y={t('Read more in the guide: {page}', { page: page.title })} onPress={() => onReadMore(slug)} testID="home-tip-read-more" />
                )}
            </FabAware>
            <FabAware id="tips:dont-show">
                <Pressable
                    onPress={onDontShow}
                    style={({ pressed }) => [{ minHeight: HOME_TARGET_DP, justifyContent: 'center', alignSelf: 'stretch' }, pressed && s.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel={t(LINES.tipsDontShowLabel)}
                    testID="home-tips-dont-show"
                >
                    <Text style={s.linkText}>{t(LINES.tipsDontShow)}</Text>
                </Pressable>
            </FabAware>
        </>
    );
}

/**
 * Sun and moon (CARD-FRAME §4): one line worked out on the phone ("🌔 Waxing gibbous, 72% · Sunrise 6:12 · Sunset 17:48"),
 * nothing to open. It wraps at the floor and is never cut; a screen reader hears it in words, no picture read aloud.
 */
export function SkyBody({ sky, colors }: { sky: SkyToday; colors: AppColors }) {
    const s = homeStyles(colors);
    return (
        <View accessible accessibilityLabel={sky.label} testID="home-sky-line">
            <Text style={[s.rowLine, s.rowStrong]}>{sky.text}</Text>
        </View>
    );
}

/**
 * A saved search (CARD-FRAME §4): its caption is fixed and its words stand in the first row, bounded, with the distance
 * ("eggs · within 5 km"), never in the caption (member text clips there). Then up to four listings as the Market card
 * draws them, each opening the listing, and "See more" opening the Market with the words filled in. A search that finds
 * nothing says so; before the node has answered for these words, it says it shows when the community answers.
 */
export function SearchBody({ settings, card, nodeUrl, showsBeans, colors, onMore }: {
    settings: unknown;
    /** The node's body for these words (utils/home-cards.ts `searchCardFor`), or null when it hasn't answered for them. */
    card: HomeSearchCard | null;
    nodeUrl: string | null;
    showsBeans: boolean;
    colors: AppColors;
    onMore: (q: string) => void;
}) {
    const s = homeStyles(colors);
    const { q, km } = readSearchSettings(settings);
    // The distance as the node applied it (none where it had no point); the stored one until it answers.
    const shownKm = card ? card.km : km ?? null;
    const first = searchFirstLine(q, shownKm);
    return (
        <>
            <HomeRow colors={colors} text={first} a11y={t('Looks for {words}.', { words: first })} strong testID="home-search-words" />
            {!card && <Text style={s.note} testID="home-search-offline">{t(LINES.searchOffline)}</Text>}
            {card && !card.items.length && <Text style={s.note} testID="home-search-empty">{searchEmptyLine(q, card.km)}</Text>}
            {card?.items.map(p => <MarketRow key={p.id} p={p} nodeUrl={nodeUrl} showsBeans={showsBeans} colors={colors} testID={`home-search-row-${p.id}`} />)}
            {card?.more && (
                <HomeLink id="search:more" colors={colors} text={t('See more')}
                    a11y={q ? t('See more listings for {words} in the Market', { words: q }) : t('See more listings for this search in the Market')} onPress={() => onMore(q)} testID="home-search-more" />
            )}
        </>
    );
}

/**
 * Getting started (scratch/global-node/DESIGN-getting-started-fable.md §1): a newcomer's Home until the tour ends. Its
 * words, Look around › (or "Pick up the tour at step 3 ›" while one is part way) and Skip. It blocks nothing: every tab,
 * Add a card and Edit home work with it sitting there. No "…": Skip is its remove.
 */
export function StartBody({ words, button, colors, onLookAround, onSkip }: {
    words: string;
    button: string;
    colors: AppColors;
    onLookAround: () => void;
    onSkip: () => void;
}) {
    const s = homeStyles(colors);
    return (
        <View>
            <Text style={{ fontSize: 15, lineHeight: 21, color: colors.text.body }} testID="home-start-words">{words}</Text>
            <View style={[s.buttonRow, { flexWrap: 'wrap', alignItems: 'center' }]}>
                <HomeButton colors={colors} primary text={button} onPress={onLookAround} testID="home-start-look" />
                <Pressable
                    onPress={onSkip}
                    style={{ minHeight: HOME_TARGET_DP, minWidth: HOME_TARGET_DP, paddingHorizontal: 12, justifyContent: 'center' }}
                    accessibilityRole="button"
                    accessibilityLabel={t('Skip the tour')}
                    testID="home-start-skip"
                >
                    <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text.link }}>{t('Skip')}</Text>
                </Pressable>
            </View>
        </View>
    );
}
