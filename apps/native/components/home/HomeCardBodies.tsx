import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import type { AppColors } from '../../constants/colors';
import { POST_CATEGORIES, categoryEmoji, categoryLabel } from '../../constants/categories';
import { MemberAvatar } from '../MemberAvatar';
import { ExampleListings } from '../ExampleListings';
import { resolvePulseThumbnailUrl } from '../../utils/pulse';
import { formatDistance } from '../../utils/events';
import type { NeedsYouEntry } from '../../utils/needs-you';
import {
    SEARCH_OFFLINE_LINE, searchEmptyLine, searchFirstLine,
    RSVP_WORDS, beansLines, communityLines, dealsLine, decideLines, enterpriseLine, eventDay, eventLine, formatBeans,
    groupLine, joinedLine, joinedNames, needsLineA11y, pulseTitle, sentence,
    type HomeAnswer, type HomeCards, type HomeMarketItem, type HomeSearchCard, type StepLine,
} from '../../utils/home-cards';
import { TIPS_DONT_SHOW, TIPS_DONT_SHOW_LABEL, readSearchSettings, tipsNextLabel, type TipsView } from '@beanpool/core';
import { getBundledGuide } from '../../utils/guide';
import { FabAware, HOME_TARGET_DP, HomeButton, HomeLink, HomeRow, communityLinksStyle, homeStyles } from './HomeParts';

/**
 * What each Home card says (design §3.1, §9), from the answer the screen holds. Every line is one target into a screen
 * that already exists; the words come from utils/home-cards.ts.
 */

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
                    a11y={`${l.text}, ${l.done ? 'done' : 'not done yet'}`}
                    onPress={l.done ? undefined : () => onStep(l.id)}
                    testID={`home-step-${l.id}`}
                    left={<Text style={[s.trailing, { fontSize: 18, color: l.done ? colors.brand.primary : colors.text.secondary }]} importantForAccessibility="no">{l.done ? '☑' : '☐'}</Text>}
                />
            ))}
            {!!note && <Text style={[s.note, { marginTop: 4 }]} testID="home-steps-limits">{note}</Text>}
            {offerUndone && (
                <FabAware id="steps:offer" style={s.buttonRow}>
                    <HomeButton primary colors={colors} text="Post an Offer" onPress={() => onStep('offer')} testID="home-step-post-offer" />
                </FabAware>
            )}
        </>
    );
}

export function InterestsBody({ interests, colors, onToggle }: { interests: readonly string[]; colors: AppColors; onToggle: (id: string) => void }) {
    const s = homeStyles(colors);
    return (
        <>
            <Text style={s.note}>Tap a few. What you star comes first here and in the Market.</Text>
            <FabAware id="interests:chips" style={s.chips}>
                {POST_CATEGORIES.map(c => {
                    const on = interests.includes(c.id);
                    return (
                        <Pressable
                            key={c.id}
                            onPress={() => onToggle(c.id)}
                            style={({ pressed }) => [s.chip, on && s.chipOn, pressed && !on && s.pressed]}
                            accessibilityRole="button"
                            accessibilityState={{ selected: on }}
                            accessibilityLabel={`${c.label}, ${on ? 'starred' : 'not starred'}`}
                            testID={`home-interest-${c.id}`}
                        >
                            <Text style={[s.chipText, on && s.chipTextOn]}>{c.emoji} {c.label}{on ? ' ★' : ''}</Text>
                        </Pressable>
                    );
                })}
            </FabAware>
        </>
    );
}

export function DealsBody({ card, colors }: { card: NonNullable<HomeCards['deals']>; colors: AppColors }) {
    const line = dealsLine(card);
    const w = card.waitingOnMe;
    return (
        <HomeRow
            colors={colors}
            text={line}
            a11y={`${sentence(line)} Opens ${w ? 'the deal' : 'your deals'}.`}
            strong={!!w}
            onPress={() => (w
                ? router.push({ pathname: '/post/[id]', params: { id: w.postId, txId: w.txId } })
                : router.push({ pathname: '/(tabs)/market', params: { tab: 'deals' } }))}
            testID="home-deals-line"
        />
    );
}

export function EnterpriseBody({ card, colors }: { card: NonNullable<HomeCards['enterprise']>; colors: AppColors }) {
    const line = enterpriseLine(card);
    return (
        <HomeRow
            colors={colors}
            text={card.name}
            sub={line}
            strong
            a11y={`${card.name}: ${sentence(line)} Opens the enterprise.`}
            onPress={() => router.push({ pathname: '/treasury-detail', params: { publicKey: card.id, name: card.name } })}
            testID="home-enterprise-line"
        />
    );
}

export function EventsBody({ card, colors }: { card: NonNullable<HomeCards['events']>; colors: AppColors }) {
    const s = homeStyles(colors);
    return (
        <>
            {card.items.map(e => {
                const rsvp = e.rsvp ? RSVP_WORDS[e.rsvp] : null;
                const far = formatDistance(e.distanceKm);
                const trailing = [rsvp, far].filter(Boolean).join(' · ');
                return (
                    <HomeRow
                        key={e.id}
                        colors={colors}
                        text={eventLine(e)}
                        a11y={`${eventDay(e.startsAt)}: ${sentence(`${e.title}${e.place ? `, at ${e.place}` : ''}`)}${rsvp ? ` You're marked ${rsvp.toLowerCase()}.` : ''}${far ? ` ${far} away.` : ''} Opens the event.`}
                        onPress={() => router.push({ pathname: '/post/[id]', params: { id: e.id } })}
                        right={trailing ? <Text style={s.trailing}>{trailing}</Text> : undefined}
                        testID={`home-event-${e.id}`}
                    />
                );
            })}
            <HomeLink id="events:all" colors={colors} text="All events" a11y="All events, in the Market"
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
            <HomeLink id="market:all" colors={colors} text="See all" a11y="See all listings in the Market" onPress={onSeeAll} testID="home-market-all" />
        </>
    );
}

/** One listing as the Market card draws it: photo, title, price or distance, Offer or Need; opens the listing. */
function MarketRow({ p, nodeUrl, showsBeans, colors, testID }: { p: HomeMarketItem; nodeUrl: string | null; showsBeans: boolean; colors: AppColors; testID: string }) {
    const s = homeStyles(colors);
        const type = p.type === 'need' ? colors.market.need : colors.market.offer;
        const word = p.type === 'need' ? 'NEED' : 'OFFER';
        const price = showsBeans && typeof p.credits === 'number' && p.credits > 0 ? `${formatBeans(p.credits)} Beans` : null;
        const far = formatDistance(p.distanceKm);
        const facts = [price, far].filter(Boolean).join(' · ');
        return (
            <HomeRow
                colors={colors}
                text={p.title}
                sub={facts || categoryLabel(p.category)}
                a11y={`${p.type === 'need' ? 'Need' : 'Offer'}: ${sentence(p.title)} ${facts ? `${facts}. ` : ''}${categoryLabel(p.category)}. Opens the listing.`}
                onPress={() => router.push({ pathname: '/post/[id]', params: { id: p.id } })}
                left={<Thumb uri={onNode(nodeUrl, p.photoUrl)} emoji={categoryEmoji(p.category)} colors={colors} />}
                subBadge={<View style={[s.badge, { backgroundColor: type.bg }]}><Text style={[s.badgeText, { color: type.fg }]} maxFontSizeMultiplier={1.2}>{word}</Text></View>}
                testID={testID}
            />
        );
}

/** One line per place (utils/home-cards.ts `decideLines`): Decisions open Commons → Decide, polls the Market's Polls. */
export function DecideBody({ card, features, colors, now }: { card: NonNullable<HomeCards['decide']>; features: HomeAnswer['features']; colors: AppColors; now: number }) {
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
                return (
                    <HomeRow
                        key={g.id}
                        colors={colors}
                        text={line}
                        strong={g.unread > 0 && !g.muted}
                        a11y={`${sentence(line)} Opens the chat.`}
                        onPress={() => router.push(g.kind === 'event'
                            ? { pathname: '/chat/[id]', params: { id: g.id, event: '1' } }
                            : { pathname: '/chat/[id]', params: { id: g.id, [g.kind]: '1' } })}
                        testID={`home-group-${g.id}`}
                    />
                );
            })}
            {card.total > card.items.length && (
                <HomeLink id="groups:all" colors={colors} text={`All ${card.total} groups`} a11y={`All ${card.total} of your groups, in Talk`}
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
                a11y={names.length ? `${line} Opens People.` : line}
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
                return (
                    <HomeRow
                        colors={colors}
                        text={title}
                        sub={`by ${p.callsign}`}
                        a11y={`${title}, by ${sentence(p.callsign)} Opens the Pulse.`}
                        onPress={() => router.push('/(tabs)/pulse')}
                        left={<Thumb uri={resolvePulseThumbnailUrl(nodeUrl, p)} emoji="📡" colors={colors} />}
                        testID={`home-pulse-${p.id}`}
                    />
                );
            })}
            <HomeLink id="pulse:all" colors={colors} text="See all" a11y="See all of the Pulse" onPress={() => router.push('/(tabs)/pulse')} testID="home-pulse-all" />
        </>
    );
}

export function BeansBody({ card, colors }: { card: NonNullable<HomeCards['beans']>; colors: AppColors }) {
    const { main, sub } = beansLines(card);
    return (
        <HomeRow colors={colors} text={main} sub={sub} strong a11y={`${sentence(main)}${sub ? ` ${sentence(sub)}` : ''} Opens your Ledger.`}
            onPress={() => router.push('/(tabs)/ledger')} testID="home-beans-line" />
    );
}

export function NoticesBody({ card, colors, onOpen }: { card: NonNullable<HomeCards['notices']>; colors: AppColors; onOpen: (id: string) => void }) {
    const more = card.unseen > 1 ? ` · ${card.unseen - 1} more` : '';
    return (
        <HomeRow colors={colors} text={card.first.title} sub={`${card.first.line}${more}`} strong
            a11y={`${sentence(card.first.title)} ${sentence(card.first.line)}${card.unseen > 1 ? ` ${card.unseen - 1} more unread.` : ''} Opens it.`}
            onPress={() => onOpen(card.first.id)} testID="home-notice-line" />
    );
}

export function InviteBody({ colors }: { colors: AppColors }) {
    const s = homeStyles(colors);
    return (
        <FabAware id="invite:button" style={s.buttonRow}>
            <HomeButton colors={colors} text="Invite someone" onPress={() => router.push({ pathname: '/(tabs)/people', params: { view: 'invites' } })} testID="home-invite" />
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
    const { line } = communityLines(card, profile, invitesOn);
    return (
        <>
            {!!line && <HomeRow colors={colors} text={line} a11y={line} lines={3} testID="home-community-line" />}
            {(onAdd || onEdit) && (
                <View style={communityLinksStyle}>
                    {onAdd && <HomeLink id="community:add" colors={colors} text="Add a card" a11y="Add a card to Home" onPress={onAdd} testID="home-add-card" />}
                    {onEdit && <HomeLink id="community:edit" colors={colors} text="Edit home" a11y="Edit home: move or remove cards" onPress={onEdit} testID="home-edit" />}
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
            <Text style={{ fontSize: 15, lineHeight: 21, color: colors.text.body }} testID="home-tip-text">{view.tip.text}</Text>
            <FabAware id="tips:buttons" style={s.buttonRow}>
                <HomeButton primary colors={colors} text={view.last ? 'Done' : 'Next'} a11y={tipsNextLabel(view)} onPress={onNext} testID="home-tip-next" />
                {page && slug && (
                    <HomeButton colors={colors} text="Read more" a11y={`Read more in the guide: ${page.title}`} onPress={() => onReadMore(slug)} testID="home-tip-read-more" />
                )}
            </FabAware>
            <FabAware id="tips:dont-show">
                <Pressable
                    onPress={onDontShow}
                    style={({ pressed }) => [{ minHeight: HOME_TARGET_DP, justifyContent: 'center', alignSelf: 'stretch' }, pressed && s.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel={TIPS_DONT_SHOW_LABEL}
                    testID="home-tips-dont-show"
                >
                    <Text style={s.linkText}>{TIPS_DONT_SHOW}</Text>
                </Pressable>
            </FabAware>
        </>
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
            <HomeRow colors={colors} text={first} a11y={`Looks for ${first}.`} strong testID="home-search-words" />
            {!card && <Text style={s.note} testID="home-search-offline">{SEARCH_OFFLINE_LINE}</Text>}
            {card && !card.items.length && <Text style={s.note} testID="home-search-empty">{searchEmptyLine(q, card.km)}</Text>}
            {card?.items.map(p => <MarketRow key={p.id} p={p} nodeUrl={nodeUrl} showsBeans={showsBeans} colors={colors} testID={`home-search-row-${p.id}`} />)}
            {card?.more && (
                <HomeLink id="search:more" colors={colors} text="See more" a11y={`See more listings for ${q || 'this search'} in the Market`} onPress={() => onMore(q)} testID="home-search-more" />
            )}
        </>
    );
}
