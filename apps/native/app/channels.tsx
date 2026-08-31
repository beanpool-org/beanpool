/**
 * Channels & Showcase — a member's own external publishing accounts (The Pulse, Phase 1).
 *
 * Phase 1 collects and displays channels; nothing fetches from them yet. Two decisions in here are
 * product decisions rather than layout, and are the reason this screen is not a plain form:
 *
 * ## Each platform states its ongoing cost, up front
 *
 * YouTube and RSS publish a machine-readable list of their items, so once a member adds one it
 * keeps itself current forever. Instagram, TikTok and Facebook do not — their post lists cannot be
 * read without OAuth, so those channels need a tap per post, indefinitely. A member choosing
 * between them deserves to know that before they choose, not after, so every tile is labelled
 * "updates itself" or "a tap per post".
 *
 * ## The cross-post warning fires at the moment of adding
 *
 * A creator who posts the same reel to YouTube and Instagram would otherwise appear twice on their
 * own community's feed. The server returns the member's other video channels alongside the new
 * one, so the choice can be offered immediately instead of reported as a problem later.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    View, Text, StyleSheet, Pressable, TextInput, ScrollView,
    ActivityIndicator, Switch, Alert,
} from 'react-native';
// react-native's own SafeAreaView is iOS-only — on Android it is a plain View, so under SDK 55's
// edge-to-edge the header and Back control would sit under the status bar. Every other pushed
// screen uses this one, and _layout.tsx already provides the SafeAreaProvider.
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useIdentity } from './IdentityContext';
import { useTheme, useStyles } from './ThemeContext';
import { anchorUrl, signedPost } from '../utils/node-post';

/**
 * Parse a response body without letting a non-JSON one mask the real failure.
 *
 * Behind Cloudflare a 502/524 returns an HTML error page, so an unguarded `res.json()` throws
 * "JSON Parse error: Unexpected character: <" before the status is ever checked — and that is what
 * the member reads instead of "Could not load your channels."
 */
async function readJson(res: Response): Promise<any> {
    return res.json().catch(() => ({}));
}

type Platform = 'youtube' | 'tiktok' | 'instagram' | 'facebook' | 'website' | 'rss';
type Category = 'food' | 'craft' | 'business' | 'repair' | 'art' | 'other';

interface Channel {
    id: string;
    platform: Platform;
    url: string | null;
    handle: string | null;
    category: Category;
    isPrimaryVideo: boolean;
    supportsAutolist: boolean;
    oauthVerifiedAt: string | null;
    syndicateToNode: boolean;
}

/**
 * How each platform behaves once added, in the member's terms.
 *
 * Three states, not two — and they must match the server's `AUTOLIST_PLATFORMS`, which is
 * `{youtube, rss}`. A website is neither: it has no stream of items to pull, it shows as a single
 * card. Labelling it "updates itself" would contradict the card rendered directly above, which
 * reads its `supportsAutolist` from the server and would say the opposite.
 */
type Listing = 'auto' | 'manual' | 'card';

const LISTING_LABEL: Record<Listing, string> = {
    auto: 'updates itself',
    manual: 'a tap per post',
    card: 'shows as a card',
};

const PLATFORMS: { id: Platform; icon: string; label: string; listing: Listing; hint: string }[] = [
    { id: 'youtube', icon: '🎥', label: 'YouTube', listing: 'auto', hint: 'youtube.com/@you' },
    { id: 'instagram', icon: '📷', label: 'Instagram', listing: 'manual', hint: '@yourhandle' },
    { id: 'tiktok', icon: '🎵', label: 'TikTok', listing: 'manual', hint: '@yourhandle' },
    { id: 'website', icon: '🌐', label: 'Website', listing: 'card', hint: 'yoursite.com' },
    { id: 'facebook', icon: '📘', label: 'Facebook', listing: 'manual', hint: 'facebook.com/yourpage' },
    { id: 'rss', icon: '✍️', label: 'Blog / RSS', listing: 'auto', hint: 'yourblog.com/feed' },
];

const CATEGORIES: { id: Category; icon: string; label: string }[] = [
    { id: 'food', icon: '🌱', label: 'Food' },
    { id: 'craft', icon: '🔨', label: 'Workshop' },
    { id: 'business', icon: '☕', label: 'Business' },
    { id: 'repair', icon: '🔧', label: 'Repair' },
    { id: 'art', icon: '🎨', label: 'Art' },
    { id: 'other', icon: '✨', label: 'Other' },
];

const VIDEO_PLATFORMS: Platform[] = ['youtube', 'tiktok', 'instagram', 'facebook'];

/**
 * Falling back to PLATFORMS[0] meant an unrecognised platform rendered as "🎥 YouTube · updates
 * itself" — the wrong name attached to an autolist promise nothing would keep. A platform this
 * build does not know about is labelled as exactly that, and `card` is the only honest listing for
 * something whose capabilities are unknown.
 */
function platformMeta(id: Platform): { id: Platform; icon: string; label: string; listing: Listing; hint: string } {
    return PLATFORMS.find(p => p.id === id) ?? { id, icon: '🔗', label: 'Link', listing: 'card', hint: '' };
}

export default function ChannelsScreen() {
    const { colors } = useTheme();
    const { identity } = useIdentity();
    const styles = useStyles(makeStyles);

    const [channels, setChannels] = useState<Channel[]>([]);
    // Mirrors `channels` for callbacks that would otherwise read a stale render closure — the
    // same draftRef pattern used for the offer composer, and for the same class of bug.
    const channelsRef = useRef<Channel[]>([]);
    useEffect(() => { channelsRef.current = channels; }, [channels]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [platform, setPlatform] = useState<Platform>('youtube');
    const [category, setCategory] = useState<Category>('food');
    const [value, setValue] = useState('');
    const [adding, setAdding] = useState(false);

    const load = useCallback(async () => {
        // Clear the spinner rather than returning into it — an identity that never arrives would
        // otherwise leave the screen loading forever with nothing to explain why.
        if (!identity) { setError('No identity on this device yet.'); setLoading(false); return; }
        try {
            const url = await anchorUrl();
            if (!url) { setError('No community node yet.'); setLoading(false); return; }
            const res = await signedPost(url, '/api/channels/mine', {}, identity);
            const data = await readJson(res);
            if (!res.ok) throw new Error(data?.message || data?.error || 'Could not load your channels.');
            setChannels(data.channels || []);
            setError(null);
        } catch (e: any) {
            setError(e?.message || 'Could not load your channels.');
        } finally {
            setLoading(false);
        }
    }, [identity]);

    useEffect(() => { load(); }, [load]);

    const add = async () => {
        if (!identity || !value.trim()) return;
        setSaving(true);
        try {
            const url = await anchorUrl();
            if (!url) throw new Error('No community node yet.');
            const res = await signedPost(url, '/api/member/channels',
                { platform, url: value.trim(), category }, identity);
            const data = await readJson(res);
            if (!res.ok) throw new Error(data?.message || 'Could not add that channel.');

            setValue('');
            setAdding(false);
            setError(null);
            // Fire-and-forget, as every other Haptics call site in the app is. Awaited inside the
            // try, a haptics rejection would surface as "Could not add that channel" after a
            // successful add, and skip the cross-post prompt below.
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
            await load();

            // The server hands back the member's other video channels precisely so this can be
            // asked now, while they are still thinking about it.
            const others: Channel[] = data.otherVideoChannels || [];
            if (VIDEO_PLATFORMS.includes(platform) && others.length > 0 && data.channel?.id) {
                // The channel that actually HOLDS the primary, not merely the oldest. With three
                // video channels, others[0] named one the member had not chosen, and its button
                // then demoted the primary they had set somewhere else entirely — a question about
                // YouTube vs TikTok silently moving the flag off Instagram.
                const rival = others.find(c => c.isPrimaryVideo) ?? others[0];
                // Each button describes ITS OWN channel. Deriving the "(updates itself)" note from
                // any autolisting channel in the list put it on the wrong button as soon as a
                // member had three — the exact opposite of what this screen exists to tell them.
                const label = (p: Platform, autoLists: boolean) =>
                    platformMeta(p).label + (autoLists ? ' (updates itself)' : '');
                // "two places" and "Both" are wrong once a member has three video channels: the
                // dialog still names only this one and the primary, so it is picking a winner
                // among more than the two it mentions.
                const several = others.length > 1;
                Alert.alert(
                    several ? 'You post video in more than one place' : 'You post video in two places',
                    `If you put the same videos on ${platformMeta(platform).label} and ` +
                    `${platformMeta(rival.platform).label}, they'd show up twice on the feed.\n\n` +
                    'Which should the feed use?',
                    [
                        {
                            text: label(platform, data.channel?.supportsAutolist === true),
                            onPress: () => setPrimary(data.channel.id),
                        },
                        {
                            text: label(rival.platform, rival.supportsAutolist === true),
                            onPress: () => setPrimary(rival.id),
                        },
                        { text: several ? 'Keep all — I post different things' : 'Both — I post different things', style: 'cancel' },
                    ],
                );
            }
        } catch (e: any) {
            setError(e?.message || 'Could not add that channel.');
        } finally {
            setSaving(false);
        }
    };

    /**
     * @param optimistic applied locally before the round trip, so a toggle does not visibly snap
     *   back while a signed POST and a full re-fetch complete. Reverted if the write fails.
     */
    const patch = async (id: string, body: Record<string, unknown>, optimistic?: Partial<Channel>) => {
        if (!identity) { setError('No identity on this device yet.'); return; }
        // Read through the ref, not the render closure. Two switches flipped in quick succession
        // captured the same `channels` array, so the first one's failure restored a snapshot taken
        // before the second was touched — silently reverting a change that had already succeeded.
        const prev = channelsRef.current.find(c => c.id === id);
        if (optimistic) {
            setChannels(cs => cs.map(c => (c.id === id ? { ...c, ...optimistic } : c)));
        }
        try {
            // Inside the try: AsyncStorage can reject, and a switch that snaps back with no
            // message reads as the app ignoring the tap.
            const url = await anchorUrl();
            if (!url) throw new Error('No community node yet.');
            const res = await signedPost(url, `/api/member/channels/${id}`, body, identity);
            if (!res.ok) {
                const data = await readJson(res);
                throw new Error(data?.message || 'Could not save that change.');
            }
            await load();
        } catch (e: any) {
            // Revert only the fields this call changed, on only this channel, against whatever the
            // array holds NOW — never by restoring a whole captured array.
            if (optimistic && prev) {
                setChannels(cs => cs.map(c => {
                    if (c.id !== id) return c;
                    const restored: Channel = { ...c };
                    for (const key of Object.keys(optimistic) as (keyof Channel)[]) {
                        (restored as any)[key] = (prev as any)[key];
                    }
                    return restored;
                }));
            }
            setError(e?.message || 'Could not save that change.');
        }
    };

    const setPrimary = (id: string) => patch(id, { isPrimaryVideo: true });

    const remove = (channel: Channel) => {
        Alert.alert(
            'Remove this channel?',
            `${platformMeta(channel.platform).label}${channel.handle ? ` · ${channel.handle}` : ''} will no longer appear on your profile.`,
            [
                { text: 'Keep it', style: 'cancel' },
                {
                    text: 'Remove', style: 'destructive',
                    onPress: async () => {
                        if (!identity) { setError('No identity on this device yet.'); return; }
                        try {
                            const url = await anchorUrl();
                            if (!url) throw new Error('No community node yet.');
                            const res = await signedPost(url, `/api/member/channels/${channel.id}/delete`, {}, identity);
                            if (!res.ok) {
                                // The server distinguishes "not yours" (403) from "already gone"
                                // (404); a fixed string threw all of that away, so a member
                                // deleting from a second device just saw a generic failure.
                                const data = await readJson(res);
                                // `error` as well as `message`: the auth middleware answers a
                                // 401 with `{ error: 'Signed request required' }` and no message,
                                // which would otherwise read as a generic delete failure. Same
                                // fallback chain load() uses.
                                throw new Error(data?.message || data?.error || 'Could not remove that channel.');
                            }
                            await load();
                        } catch (e: any) {
                            setError(e?.message || 'Could not remove that channel.');
                        }
                    },
                },
            ],
        );
    };

    const videoChannels = channels.filter(c => VIDEO_PLATFORMS.includes(c.platform));
    const showCrossPostBanner = videoChannels.length > 1;
    const primary = videoChannels.find(c => c.isPrimaryVideo);

    return (
        <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
            <View style={styles.header}>
                <Pressable
                    onPress={() => router.back()}
                    style={styles.backBtn}
                    accessibilityRole="button"
                    accessibilityLabel="Go back"
                >
                    <Text style={styles.backText}>‹ Back</Text>
                </Pressable>
                <Text style={styles.title}>Channels & Showcase</Text>
            </View>

            <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
                {loading ? (
                    <ActivityIndicator style={{ marginTop: 32 }} color={colors.brand.primary} />
                ) : (
                    <>
                        {error && (
                            <View style={styles.errorBox} accessibilityRole="alert">
                                <Text style={styles.errorText}>{error}</Text>
                            </View>
                        )}

                        {channels.length === 0 && !adding && (
                            <View style={styles.empty}>
                                <Text style={styles.emptyTitle}>Already posting your work somewhere?</Text>
                                <Text style={styles.emptyBody}>
                                    Add it here so your neighbours can find it — and trade with you.
                                    You won't have to post twice.
                                </Text>
                            </View>
                        )}

                        {showCrossPostBanner && (
                            <View style={styles.banner}>
                                <Text style={styles.bannerText}>
                                    {primary
                                        ? `You post video in more than one place. The feed uses your ${platformMeta(primary.platform).label} as the main one.`
                                        : 'You post video in more than one place. Pick which one the feed should use.'}
                                </Text>
                            </View>
                        )}

                        {channels.map(channel => {
                            const meta = platformMeta(channel.platform);
                            return (
                                <View key={channel.id} style={styles.card}>
                                    <View style={styles.cardTop}>
                                        <Text style={styles.cardTitle}>
                                            {meta.icon} {meta.label}
                                            {channel.handle ? ` · ${channel.handle}` : ''}
                                        </Text>
                                        {channel.oauthVerifiedAt ? <Text style={styles.verified}>✅</Text> : null}
                                    </View>

                                    <Text style={styles.cardMeta}>
                                        {channel.supportsAutolist
                                            ? 'Updates itself'
                                            // Never fall back to the platform's own label here: a
                                            // youtu.be link is stored on YouTube with
                                            // supports_autolist = 0, and YouTube's static label is
                                            // "updates itself" — the exact claim the server just
                                            // declined to make.
                                            : LISTING_LABEL[
                                                platformMeta(channel.platform).listing === 'auto'
                                                    ? 'manual'
                                                    : platformMeta(channel.platform).listing
                                            ]}
                                        {channel.isPrimaryVideo ? ' · main video channel' : ''}
                                    </Text>

                                    <View style={styles.row}>
                                        <Text style={styles.rowLabel}>Show on the local feed</Text>
                                        <Switch
                                            value={channel.syndicateToNode}
                                            onValueChange={v => patch(channel.id, { syndicateToNode: v }, { syndicateToNode: v })}
                                            accessibilityLabel={`Show ${meta.label} on the local feed`}
                                        />
                                    </View>

                                    <View style={styles.cardActions}>
                                        {VIDEO_PLATFORMS.includes(channel.platform) && !channel.isPrimaryVideo && videoChannels.length > 1 && (
                                            <Pressable
                                                onPress={() => setPrimary(channel.id)}
                                                style={styles.secondaryBtn}
                                                accessibilityRole="button"
                                                accessibilityLabel={`Make ${meta.label} the main video channel`}
                                            >
                                                <Text style={styles.secondaryBtnText}>Make main</Text>
                                            </Pressable>
                                        )}
                                        <Pressable
                                            onPress={() => remove(channel)}
                                            style={styles.removeBtn}
                                            accessibilityRole="button"
                                            accessibilityLabel={`Remove ${meta.label}`}
                                        >
                                            <Text style={styles.removeBtnText}>Remove</Text>
                                        </Pressable>
                                    </View>
                                </View>
                            );
                        })}

                        {adding ? (
                            <View style={styles.card}>
                                <Text style={styles.sectionLabel}>Where do you post?</Text>
                                <View style={styles.tiles}>
                                    {PLATFORMS.map(p => {
                                        const active = p.id === platform;
                                        return (
                                            <Pressable
                                                key={p.id}
                                                onPress={() => setPlatform(p.id)}
                                                style={[styles.tile, active && styles.tileActive]}
                                                accessibilityRole="radio"
                                                accessibilityState={{ selected: active }}
                                                accessibilityLabel={`${p.label}, ${LISTING_LABEL[p.listing]}`}
                                            >
                                                <Text style={styles.tileIcon}>{p.icon}</Text>
                                                <Text style={[styles.tileLabel, active && styles.tileLabelActive]}>{p.label}</Text>
                                                <Text style={styles.tileHint}>{LISTING_LABEL[p.listing]}</Text>
                                            </Pressable>
                                        );
                                    })}
                                </View>

                                <Text style={styles.sectionLabel}>Your link or handle</Text>
                                <TextInput
                                    value={value}
                                    onChangeText={setValue}
                                    placeholder={platformMeta(platform).hint}
                                    placeholderTextColor={colors.text.muted}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    style={styles.input}
                                    accessibilityLabel="Your link or handle"
                                />

                                <Text style={styles.sectionLabel}>What do you make?</Text>
                                <View style={styles.chips}>
                                    {CATEGORIES.map(c => {
                                        const active = c.id === category;
                                        return (
                                            <Pressable
                                                key={c.id}
                                                onPress={() => setCategory(c.id)}
                                                style={[styles.chip, active && styles.chipActive]}
                                                accessibilityRole="radio"
                                                accessibilityState={{ selected: active }}
                                                accessibilityLabel={c.label}
                                            >
                                                <Text style={[styles.chipText, active && styles.chipTextActive]}>
                                                    {c.icon} {c.label}
                                                </Text>
                                            </Pressable>
                                        );
                                    })}
                                </View>

                                <View style={styles.cardActions}>
                                    <Pressable
                                        onPress={() => { setAdding(false); setValue(''); setError(null); }}
                                        style={styles.secondaryBtn}
                                        accessibilityRole="button"
                                    >
                                        <Text style={styles.secondaryBtnText}>Cancel</Text>
                                    </Pressable>
                                    <Pressable
                                        onPress={add}
                                        disabled={saving || !value.trim()}
                                        style={[styles.primaryBtn, (saving || !value.trim()) && styles.primaryBtnDisabled]}
                                        accessibilityRole="button"
                                        accessibilityLabel="Add channel"
                                    >
                                        <Text style={styles.primaryBtnText}>{saving ? 'Adding…' : 'Add channel'}</Text>
                                    </Pressable>
                                </View>
                            </View>
                        ) : (
                            <Pressable
                                onPress={() => { setAdding(true); setError(null); }}
                                style={styles.addBtn}
                                accessibilityRole="button"
                                accessibilityLabel="Add a channel"
                            >
                                <Text style={styles.addBtnText}>+ Add a channel</Text>
                            </Pressable>
                        )}
                    </>
                )}
            </ScrollView>
        </SafeAreaView>
    );
}

const makeStyles = ({ colors }: { colors: any }) => StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.surface.app },
    header: {
        paddingHorizontal: 16, paddingVertical: 12,
        borderBottomWidth: 1, borderBottomColor: colors.border.default,
    },
    backBtn: { paddingVertical: 4, alignSelf: 'flex-start' },
    backText: { color: colors.text.link, fontSize: 16 },
    title: { fontSize: 22, fontWeight: '700', color: colors.text.heading, marginTop: 4 },
    body: { padding: 16, paddingBottom: 48 },

    empty: { paddingVertical: 12, marginBottom: 12 },
    emptyTitle: { fontSize: 17, fontWeight: '600', color: colors.text.heading, marginBottom: 6 },
    emptyBody: { fontSize: 15, lineHeight: 21, color: colors.text.secondary },

    banner: {
        backgroundColor: colors.accent.tint, borderColor: colors.accent.border, borderWidth: 1,
        borderRadius: 10, padding: 12, marginBottom: 12,
    },
    bannerText: { color: colors.text.body, fontSize: 14, lineHeight: 20 },

    errorBox: {
        backgroundColor: colors.market.need.bg, borderRadius: 10, padding: 12, marginBottom: 12,
    },
    errorText: { color: colors.market.need.fg, fontSize: 14 },

    card: {
        backgroundColor: colors.surface.card, borderRadius: 12, padding: 14, marginBottom: 12,
        borderWidth: 1, borderColor: colors.border.default,
    },
    cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    cardTitle: { fontSize: 16, fontWeight: '600', color: colors.text.heading, flexShrink: 1 },
    verified: { fontSize: 14, marginLeft: 8 },
    cardMeta: { fontSize: 13, color: colors.text.secondary, marginTop: 4 },

    row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
    rowLabel: { fontSize: 15, color: colors.text.body, flexShrink: 1, paddingRight: 12 },

    cardActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
    secondaryBtn: {
        paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8,
        borderWidth: 1, borderColor: colors.border.strong,
    },
    secondaryBtnText: { color: colors.text.body, fontSize: 15 },
    removeBtn: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8 },
    removeBtnText: { color: colors.market.need.fg, fontSize: 15 },
    primaryBtn: {
        paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8,
        backgroundColor: colors.brand.primary,
    },
    primaryBtnDisabled: { opacity: 0.5 },
    primaryBtnText: { color: colors.text.inverse, fontSize: 15, fontWeight: '600' },

    addBtn: {
        paddingVertical: 14, borderRadius: 10, alignItems: 'center',
        borderWidth: 1, borderStyle: 'dashed', borderColor: colors.border.strong,
    },
    addBtnText: { color: colors.text.body, fontSize: 16, fontWeight: '600' },

    sectionLabel: { fontSize: 14, fontWeight: '600', color: colors.text.secondary, marginTop: 8, marginBottom: 8 },
    tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    tile: {
        // Two per row at 320dp with the 16pt page padding, and it reflows to three when the
        // viewport allows — rather than a fixed percentage that overflows at 1.3x font scale.
        minWidth: 130, flexGrow: 1, flexBasis: '46%',
        borderWidth: 1, borderColor: colors.border.default, borderRadius: 10, padding: 10,
    },
    tileActive: { borderColor: colors.brand.primary, backgroundColor: colors.brand.tint },
    tileIcon: { fontSize: 20 },
    tileLabel: { fontSize: 15, fontWeight: '600', color: colors.text.heading, marginTop: 2 },
    tileLabelActive: { color: colors.brand.dark },
    tileHint: { fontSize: 12, color: colors.text.secondary, marginTop: 2 },

    input: {
        borderWidth: 1, borderColor: colors.border.strong, borderRadius: 8,
        paddingHorizontal: 12, paddingVertical: 10, fontSize: 16,
        color: colors.text.body, backgroundColor: colors.surface.app,
    },

    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: {
        paddingVertical: 8, paddingHorizontal: 12, borderRadius: 999,
        borderWidth: 1, borderColor: colors.border.default,
    },
    chipActive: { borderColor: colors.brand.primary, backgroundColor: colors.brand.tint },
    chipText: { fontSize: 14, color: colors.text.body },
    chipTextActive: { color: colors.brand.dark, fontWeight: '600' },
});
