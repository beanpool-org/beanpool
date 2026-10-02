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
    RSVP_WORDS, beansLines, communityLines, dealsLine, decideLine, enterpriseLine, eventDay, eventLine, formatBeans,
    groupLine, joinedLine, needsLineA11y, pulseTitle, sentence,
    type HomeCards, type HomeMarketItem, type StepLine,
} from '../../utils/home-cards';
import { FabAware, HomeButton, HomeLink, HomeRow, homeStyles } from './HomeParts';

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

export function StepsBody({ lines, colors, onStep }: { lines: StepLine[]; colors: AppColors; onStep: (id: StepLine['id']) => void }) {
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
    const s = homeStyles(colors);
    return (
        <>
            {items.map(p => {
                const type = p.type === 'need' ? colors.market.need : colors.market.offer;
                const word = p.type === 'need' ? 'NEED' : 'OFFER';
                const price = showsBeans && typeof p.credits === 'number' && p.credits > 0 ? `${formatBeans(p.credits)} Beans` : null;
                const far = formatDistance(p.distanceKm);
                const facts = [price, far].filter(Boolean).join(' · ');
                return (
                    <HomeRow
                        key={p.id}
                        colors={colors}
                        text={p.title}
                        sub={facts || categoryLabel(p.category)}
                        a11y={`${p.type === 'need' ? 'Need' : 'Offer'}: ${sentence(p.title)} ${facts ? `${facts}. ` : ''}${categoryLabel(p.category)}. Opens the listing.`}
                        onPress={() => router.push({ pathname: '/post/[id]', params: { id: p.id } })}
                        left={<Thumb uri={onNode(nodeUrl, p.photoUrl)} emoji={categoryEmoji(p.category)} colors={colors} />}
                        subBadge={<View style={[s.badge, { backgroundColor: type.bg }]}><Text style={[s.badgeText, { color: type.fg }]} maxFontSizeMultiplier={1.2}>{word}</Text></View>}
                        testID={`home-market-${p.id}`}
                    />
                );
            })}
            {/* A node that asks for them, with fewer than a handful of real listings: the made-up ones, each marked Example (§6.1). */}
            {examples && <View style={{ marginHorizontal: -14 }}><ExampleListings /></View>}
            <HomeLink id="market:all" colors={colors} text="See all" a11y="See all listings in the Market" onPress={onSeeAll} testID="home-market-all" />
        </>
    );
}

export function DecideBody({ card, colors, now }: { card: NonNullable<HomeCards['decide']>; colors: AppColors; now: number }) {
    const line = decideLine(card, now);
    return (
        <HomeRow colors={colors} text={line} a11y={`${sentence(line)} Opens Decide.`}
            onPress={() => router.push({ pathname: '/(tabs)/projects', params: { section: 'decide' } })} testID="home-decide-line" />
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

export function JoinedBody({ card, colors }: { card: NonNullable<HomeCards['joined']>; colors: AppColors }) {
    const s = homeStyles(colors);
    const line = joinedLine(card);
    const names = card.names ?? [];
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
                        key={p.id}
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

export function CommunityBody({ card, profile, invitesOn, colors, onEdit }: {
    card: HomeCards['community'] | undefined;
    profile: string;
    invitesOn: boolean;
    colors: AppColors;
    onEdit: () => void;
}) {
    const { line } = communityLines(card, profile, invitesOn);
    return (
        <>
            {!!line && <HomeRow colors={colors} text={line} a11y={line} lines={3} testID="home-community-line" />}
            <HomeLink id="community:edit" colors={colors} text="Edit home" a11y="Edit home: hide, show or move cards" onPress={onEdit} testID="home-edit" />
        </>
    );
}
