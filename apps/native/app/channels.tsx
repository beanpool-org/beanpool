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
// The house keyboard pattern: RN's own KeyboardAvoidingView is broken under Android edge-to-edge.
// KeyboardProvider already wraps the app in _layout.tsx, so a pushed screen needs no provider.
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useIdentity } from './IdentityContext';
import { useTheme, useStyles } from './ThemeContext';
import { anchorUrl, signedPost } from '../utils/node-post';
import { PulseNudges } from '../components/PulseNudges';

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

import {
    type ChannelPlatform as Platform,
    type ChannelCategory as Category,
    type Listing,
    LISTING_LABEL,
    PLATFORMS,
    CATEGORIES,
    VIDEO_PLATFORMS,
    platformMeta,
    categoryMeta,
} from '@beanpool/core';
import {
    fetchPulseOAuthConfig,
    connectTikTokChannel,
    connectInstagramChannel,
    syncChannelVideos,
    disconnectOAuthChannel,
    type PulseOAuthConfig,
    PulseOAuthError,
} from '../utils/pulse-oauth';

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
    postCountSeen?: number | null;
}


export default function ChannelsScreen() {
    const { colors } = useTheme();
    const { identity } = useIdentity();
    const styles = useStyles(makeStyles);

    const [channels, setChannels] = useState<Channel[]>([]);
    const [oauthConfig, setOAuthConfig] = useState<PulseOAuthConfig>({
        tiktok: { enabled: false, clientKey: null },
        instagram: { enabled: false, appId: null },
    });
    const [connectingId, setConnectingId] = useState<string | null>(null);
    const [syncingId, setSyncingId] = useState<string | null>(null);
    const [cardErrors, setCardErrors] = useState<Record<string, string | null>>({});

    // A list-level error renders above the cards, which is off-screen once the member has scrolled
    // to the form at the bottom — so the view is scrolled back to it rather than reporting silently.
    const scrollRef = useRef<ScrollView>(null);
    // Mirrors `channels` for callbacks that would otherwise read a stale render closure — the
    // same draftRef pattern used for the offer composer, and for the same class of bug.
    const channelsRef = useRef<Channel[]>([]);
    useEffect(() => { channelsRef.current = channels; }, [channels]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    // Two errors, not one. A card mutation failing while the add form is open used to render its
    // message INSIDE that form — where it read as an add failure — and the scroll-to-top then moved
    // the member away from the only copy of it on screen. A list error and a form error are
    // different things and belong in different places.
    const [listError, setListError] = useState<string | null>(null);
    const [formError, setFormError] = useState<string | null>(null);

    const [platform, setPlatform] = useState<Platform>('youtube');
    // No preselection. Defaulting to 'food' quietly filed a community media account under produce,
    // and this field exists only to let the Phase 3 feed filter honestly — one tap is cheaper than
    // a feed full of confidently wrong categories.
    const [category, setCategory] = useState<Category | null>(null);
    // Which card has its category picker open. Editing is category-only: the server's updateChannel
    // deliberately cannot change a link, since the URL is the channel's identity.
    const [editingId, setEditingId] = useState<string | null>(null);
    const [value, setValue] = useState('');
    const [adding, setAdding] = useState(false);

    const load = useCallback(async () => {
        // Clear the spinner rather than returning into it — an identity that never arrives would
        // otherwise leave the screen loading forever with nothing to explain why.
        if (!identity) { setListError('No identity on this device yet.'); setLoading(false); return; }
        try {
            const url = await anchorUrl();
            if (!url) { setListError('No community node yet.'); setLoading(false); return; }
            const res = await signedPost(url, '/api/channels/mine', {}, identity);
            const data = await readJson(res);
            if (!res.ok) throw new Error(data?.message || data?.error || 'Could not load your channels.');
            setChannels(data.channels || []);
            setListError(null);

            const conf = await fetchPulseOAuthConfig(url);
            setOAuthConfig(conf);
        } catch (e: any) {
            setListError(e?.message || 'Could not load your channels.');
        } finally {
            setLoading(false);
        }
    }, [identity]);

    useEffect(() => { load(); }, [load]);

    const add = async () => {
        if (!identity || !value.trim() || !category) return;
        setSaving(true);
        try {
            const url = await anchorUrl();
            if (!url) throw new Error('No community node yet.');
            const res = await signedPost(url, '/api/member/channels',
                { platform, url: value.trim(), category }, identity);
            const data = await readJson(res);
            if (!res.ok) throw new Error(data?.message || 'Could not add that channel.');

            setValue('');
            setCategory(null);
            setAdding(false);
            setFormError(null);
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
            setFormError(e?.message || 'Could not add that channel.');
        } finally {
            setSaving(false);
        }
    };

    /**
     * @param optimistic applied locally before the round trip, so a toggle does not visibly snap
     *   back while a signed POST and a full re-fetch complete. Reverted if the write fails.
     */
    const patch = async (id: string, body: Record<string, unknown>, optimistic?: Partial<Channel>) => {
        if (!identity) { setListError('No identity on this device yet.'); return; }
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
            setListError(e?.message || 'Could not save that change.');
            // The banner lives above the cards; a switch toggled near the bottom would otherwise
            // fail with no visible explanation.
            scrollRef.current?.scrollTo({ y: 0, animated: true });
        }
    };

    const setPrimary = (id: string) => patch(id, { isPrimaryVideo: true });
    const changeCategory = (id: string, next: Category) => {
        setEditingId(null);
        // Tapping the chip that is already selected is a way of closing the picker, not a change.
        // Read through the ref for the same reason patch() does — the render closure can be stale.
        if (channelsRef.current.find(c => c.id === id)?.category === next) return;
        patch(id, { category: next }, { category: next });
    };

    const connectChannel = async (channel: Channel) => {
        if (!identity) { setListError('No identity on this device yet.'); return; }
        setConnectingId(channel.id);
        setCardErrors(prev => ({ ...prev, [channel.id]: null }));

        try {
            const url = await anchorUrl();
            if (!url) throw new Error('No community node yet.');

            if (channel.platform === 'tiktok') {
                const res = await connectTikTokChannel(channel, identity, url, oauthConfig.tiktok.clientKey);
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
                await load();
                if (res.newItemsCount > 0) {
                    Alert.alert(
                        'TikTok Connected',
                        `Imported ${res.newItemsCount} recent video${res.newItemsCount === 1 ? '' : 's'} to the community feed.`
                    );
                }
            } else if (channel.platform === 'instagram') {
                await connectInstagramChannel(channel, identity, url, oauthConfig.instagram.appId);
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
                await load();
            }
        } catch (e: any) {
            if (e instanceof PulseOAuthError && e.reason === 'cancelled') {
                return;
            }
            const msg = e?.message || 'Could not connect channel.';
            setCardErrors(prev => ({ ...prev, [channel.id]: msg }));
        } finally {
            setConnectingId(null);
        }
    };

    const syncChannel = async (channel: Channel) => {
        if (!identity) { setListError('No identity on this device yet.'); return; }
        setSyncingId(channel.id);
        setCardErrors(prev => ({ ...prev, [channel.id]: null }));

        try {
            const url = await anchorUrl();
            if (!url) throw new Error('No community node yet.');

            const res = await syncChannelVideos(channel.id, identity, url);
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
            await load();
            if (res.synced > 0) {
                Alert.alert(
                    'Channel Synced',
                    `Synced ${res.synced} video${res.synced === 1 ? '' : 's'} from ${platformMeta(channel.platform).label}.`
                );
            }
        } catch (e: any) {
            const msg = e?.message || 'Could not sync channel videos.';
            setCardErrors(prev => ({ ...prev, [channel.id]: msg }));
        } finally {
            setSyncingId(null);
        }
    };

    const disconnectChannel = (channel: Channel) => {
        const meta = platformMeta(channel.platform);
        Alert.alert(
            `Disconnect ${meta.label}?`,
            `Your ${meta.label} account will be disconnected from automatic updates and fall back to manual post sharing. Existing posts will remain on the community feed.`,
            [
                { text: 'Keep connected', style: 'cancel' },
                {
                    text: 'Disconnect',
                    style: 'destructive',
                    onPress: async () => {
                        if (!identity) { setListError('No identity on this device yet.'); return; }
                        setCardErrors(prev => ({ ...prev, [channel.id]: null }));
                        try {
                            const url = await anchorUrl();
                            if (!url) throw new Error('No community node yet.');
                            await disconnectOAuthChannel(channel.id, identity, url);
                            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
                            await load();
                        } catch (e: any) {
                            const msg = e?.message || 'Could not disconnect channel.';
                            setCardErrors(prev => ({ ...prev, [channel.id]: msg }));
                        }
                    },
                },
            ]
        );
    };

    const remove = (channel: Channel) => {
        Alert.alert(
            'Remove this channel?',
            `${platformMeta(channel.platform).label}${channel.handle ? ` · ${channel.handle}` : ''} will no longer appear on your profile.`,
            [
                { text: 'Keep it', style: 'cancel' },
                {
                    text: 'Remove', style: 'destructive',
                    onPress: async () => {
                        if (!identity) { setListError('No identity on this device yet.'); return; }
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
                            setListError(e?.message || 'Could not remove that channel.');
                            scrollRef.current?.scrollTo({ y: 0, animated: true });
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
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Pressable
                        onPress={() => router.back()}
                        style={styles.backBtn}
                        accessibilityRole="button"
                        accessibilityLabel="Go back"
                    >
                        <Text style={styles.backText}>‹ Back</Text>
                    </Pressable>
                    <Pressable
                        onPress={() => router.push('/pulse')}
                        style={styles.feedLinkBtn}
                        accessibilityRole="button"
                        accessibilityLabel="View The Pulse community feed"
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                        <Text style={styles.feedLinkText}>View Feed ↗</Text>
                    </Pressable>
                </View>
                <Text style={styles.title}>Channels & Showcase</Text>
            </View>

            <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={64} style={{ flex: 1 }}>
                <ScrollView ref={scrollRef} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
                    {loading ? (
                        <ActivityIndicator style={{ marginTop: 32 }} color={colors.brand.primary} />
                    ) : (
                        <>
                            {listError && (
                                <View style={styles.errorBox} accessibilityRole="alert">
                                    <Text style={styles.errorText}>{listError}</Text>
                                </View>
                            )}

                            <PulseNudges channels={channels} onNudgeDismissed={load} />

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
                                const isConnecting = connectingId === channel.id;
                                const isSyncing = syncingId === channel.id;
                                const cardError = cardErrors[channel.id];
                                const isOauthPlatform = channel.platform === 'tiktok' || channel.platform === 'instagram';
                                const isOauthEnabled = (channel.platform === 'tiktok' && oauthConfig.tiktok.enabled) ||
                                    (channel.platform === 'instagram' && oauthConfig.instagram.enabled);

                                return (
                                    <View key={channel.id} style={styles.card}>
                                        <View style={styles.cardTop}>
                                            <Text style={styles.cardTitle}>
                                                {meta.icon} {meta.label}
                                                {channel.handle ? ` · ${channel.handle}` : ''}
                                            </Text>
                                            {channel.oauthVerifiedAt ? (
                                                <View style={styles.verifiedBadgeRow}>
                                                    <Text style={styles.verifiedText}>✓ Verified</Text>
                                                </View>
                                            ) : null}
                                        </View>

                                        <Text style={styles.cardMeta}>
                                            {channel.supportsAutolist
                                                ? (channel.oauthVerifiedAt ? 'Updates itself (connected)' : 'Updates itself')
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

                                        {/* Category is the only editable field: updateChannel cannot
                                            change a link, because the URL is the channel's identity —
                                            a different URL is a different channel. Fixing a typo is
                                            still Remove and re-add. */}
                                        <View style={styles.row}>
                                            <Text style={styles.rowLabel}>
                                                {categoryMeta(channel.category).icon} {categoryMeta(channel.category).label}
                                            </Text>
                                            <Pressable
                                                onPress={() => setEditingId(editingId === channel.id ? null : channel.id)}
                                                // 14pt text plus hitSlop 8 came to ~34dp of height —
                                                // under the 44dp floor, on a control sitting beside a
                                                // Switch that has a comfortable one.
                                                style={styles.changeBtn}
                                                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                                                accessibilityRole="button"
                                                accessibilityLabel={editingId === channel.id
                                                    ? `Stop changing the category for ${meta.label}`
                                                    : `Change the category for ${meta.label}`}
                                            >
                                                <Text style={styles.editLink}>
                                                    {editingId === channel.id ? 'Done' : 'Change'}
                                                </Text>
                                            </Pressable>
                                        </View>

                                        {editingId === channel.id && (
                                            <View style={styles.chips}>
                                                {CATEGORIES.map(c => {
                                                    const on = c.id === channel.category;
                                                    return (
                                                        <Pressable
                                                            key={c.id}
                                                            onPress={() => changeCategory(channel.id, c.id)}
                                                            style={[styles.chip, on && styles.chipActive]}
                                                            accessibilityRole="radio"
                                                            accessibilityState={{ selected: on }}
                                                            accessibilityLabel={c.label}
                                                        >
                                                            <Text style={[styles.chipText, on && styles.chipTextActive]}>
                                                                {c.icon} {c.label}
                                                            </Text>
                                                        </Pressable>
                                                    );
                                                })}
                                            </View>
                                        )}

                                        {cardError && (
                                            <View style={styles.cardErrorBox} accessibilityRole="alert">
                                                <Text style={styles.cardErrorText}>{cardError}</Text>
                                            </View>
                                        )}

                                        <View style={styles.cardActions}>
                                            {/* OAuth Actions */}
                                            {isOauthPlatform && (
                                                channel.oauthVerifiedAt ? (
                                                    <>
                                                        <Pressable
                                                            onPress={() => syncChannel(channel)}
                                                            disabled={isSyncing}
                                                            style={[styles.oauthSyncBtn, isSyncing && styles.btnDisabled]}
                                                            accessibilityRole="button"
                                                            accessibilityLabel={`Sync latest videos from ${meta.label}`}
                                                        >
                                                            <Text style={styles.oauthSyncBtnText}>
                                                                {isSyncing ? 'Syncing…' : '↻ Sync videos'}
                                                            </Text>
                                                        </Pressable>
                                                        <Pressable
                                                            onPress={() => disconnectChannel(channel)}
                                                            style={styles.oauthDisconnectBtn}
                                                            accessibilityRole="button"
                                                            accessibilityLabel={`Disconnect ${meta.label} account`}
                                                        >
                                                            <Text style={styles.oauthDisconnectBtnText}>Disconnect</Text>
                                                        </Pressable>
                                                    </>
                                                ) : isOauthEnabled ? (
                                                    <Pressable
                                                        onPress={() => connectChannel(channel)}
                                                        disabled={isConnecting}
                                                        style={[styles.oauthConnectBtn, isConnecting && styles.btnDisabled]}
                                                        accessibilityRole="button"
                                                        accessibilityLabel={`Connect ${meta.label} account`}
                                                    >
                                                        <Text style={styles.oauthConnectBtnText}>
                                                            {isConnecting ? 'Connecting…' : `Connect ${meta.label}`}
                                                        </Text>
                                                    </Pressable>
                                                ) : null
                                            )}

                                            {!channel.supportsAutolist && (
                                                <Pressable
                                                    onPress={() => router.push({ pathname: '/pulse-intake', params: { channelId: channel.id } })}
                                                    style={styles.shareBtn}
                                                    accessibilityRole="button"
                                                    accessibilityLabel={`Share a post from ${meta.label} to Pulse`}
                                                >
                                                    <Text style={styles.shareBtnText}>+ Share post</Text>
                                                </Pressable>
                                            )}
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
                                        // Whitespace stripped as it arrives. autoCorrect={false} does not
                                        // stop Android's gesture typing and suggestion strip inserting a
                                        // space mid-string — "bean pool.org" is a link a member typed
                                        // correctly and the parser then rejected.
                                        onChangeText={t => setValue(t.replace(/\s/g, ''))}
                                        placeholder={platformMeta(platform).hint}
                                        placeholderTextColor={colors.text.muted}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                        spellCheck={false}
                                        // A URL keyboard: no space bar suggestions, and / and . are
                                        // on the primary layer.
                                        keyboardType="url"
                                        style={styles.input}
                                        accessibilityLabel="Your link or handle"
                                    />

                                    <Text style={styles.sectionLabel}>What's it about?</Text>
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

                                    {/* Beside the button that caused it. The page-top banner is
                                        off-screen by the time a member has scrolled down to this form,
                                        so an add failure read as nothing happening at all. */}
                                    {formError && (
                                        <View style={styles.errorBox} accessibilityRole="alert">
                                            <Text style={styles.errorText}>{formError}</Text>
                                        </View>
                                    )}

                                    <View style={styles.cardActions}>
                                        <Pressable
                                            onPress={() => { setAdding(false); setValue(''); setCategory(null); setFormError(null); }}
                                            style={styles.secondaryBtn}
                                            accessibilityRole="button"
                                        >
                                            <Text style={styles.secondaryBtnText}>Cancel</Text>
                                        </Pressable>
                                        <Pressable
                                            onPress={add}
                                            disabled={saving || !value.trim() || !category}
                                            style={[styles.primaryBtn, (saving || !value.trim() || !category) && styles.primaryBtnDisabled]}
                                            accessibilityRole="button"
                                            accessibilityLabel="Add channel"
                                            // Disabled and busy were conveyed by colour alone.
                                            accessibilityState={{
                                                disabled: Boolean(saving || !value.trim() || !category),
                                                busy: saving,
                                            }}
                                        >
                                            <Text style={styles.primaryBtnText}>{saving ? 'Adding…' : 'Add channel'}</Text>
                                        </Pressable>
                                    </View>
                                </View>
                            ) : (
                                <View style={styles.bottomActions}>
                                    <Pressable
                                        onPress={() => { setAdding(true); setFormError(null); }}
                                        style={styles.addBtn}
                                        accessibilityRole="button"
                                        accessibilityLabel="Add a channel"
                                    >
                                        <Text style={styles.addBtnText}>+ Add a channel</Text>
                                    </Pressable>

                                    {channels.length > 0 && (
                                        <Pressable
                                            onPress={() => router.push('/pulse-intake')}
                                            style={styles.manualIntakeBtn}
                                            accessibilityRole="button"
                                            accessibilityLabel="Share a post manually to Pulse"
                                        >
                                            <Text style={styles.manualIntakeBtnText}>Share a post to Pulse →</Text>
                                        </Pressable>
                                    )}
                                </View>
                            )}
                        </>
                    )}
                </ScrollView>
            </KeyboardAvoidingView>
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
    feedLinkBtn: {
        paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8,
        backgroundColor: colors.surface.subtle, borderWidth: 1, borderColor: colors.border.default,
    },
    feedLinkText: { color: colors.text.body, fontSize: 13, fontWeight: '600' },
    title: { fontSize: 22, fontWeight: '700', color: colors.text.heading, marginTop: 4 },
    body: { padding: 16, paddingBottom: 48 },

    empty: { paddingVertical: 12, marginBottom: 12 },
    emptyTitle: { fontSize: 17, fontWeight: '600', color: colors.text.heading, marginBottom: 6 },
    emptyBody: { fontSize: 15, lineHeight: 21, color: colors.text.secondary },

    // paddingVertical carries the touch target rather than hitSlop alone, so the tappable area is
    // also the visible area at 1.3x font scale.
    changeBtn: { paddingVertical: 10, paddingHorizontal: 4, justifyContent: 'center' },
    editLink: { color: colors.text.link, fontSize: 14, fontWeight: '600' },

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
    shareBtn: {
        paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8,
        backgroundColor: colors.brand.primary,
    },
    shareBtnText: { color: colors.text.inverse, fontSize: 15, fontWeight: '600' },
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

    bottomActions: {
        gap: 12,
        marginTop: 4,
    },
    addBtn: {
        paddingVertical: 14, borderRadius: 10, alignItems: 'center',
        borderWidth: 1, borderStyle: 'dashed', borderColor: colors.border.strong,
    },
    addBtnText: { color: colors.text.body, fontSize: 16, fontWeight: '600' },
    manualIntakeBtn: {
        paddingVertical: 12, borderRadius: 10, alignItems: 'center',
        backgroundColor: colors.surface.card,
        borderWidth: 1, borderColor: colors.border.default,
    },
    manualIntakeBtnText: { color: colors.brand.primary, fontSize: 15, fontWeight: '600' },

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

    verifiedBadgeRow: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.brand.tint,
        paddingVertical: 3,
        paddingHorizontal: 8,
        borderRadius: 12,
    },
    verifiedText: {
        color: colors.brand.dark,
        fontSize: 12,
        fontWeight: '700',
    },
    oauthConnectBtn: {
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 8,
        backgroundColor: colors.brand.primary,
    },
    oauthConnectBtnText: {
        color: colors.text.inverse,
        fontSize: 15,
        fontWeight: '600',
    },
    oauthSyncBtn: {
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 8,
        backgroundColor: colors.surface.subtle,
        borderWidth: 1,
        borderColor: colors.border.default,
    },
    oauthSyncBtnText: {
        color: colors.text.body,
        fontSize: 15,
        fontWeight: '600',
    },
    oauthDisconnectBtn: {
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.border.default,
    },
    oauthDisconnectBtnText: {
        color: colors.text.secondary,
        fontSize: 15,
    },
    btnDisabled: {
        opacity: 0.5,
    },
    cardErrorBox: {
        backgroundColor: colors.market.need.bg,
        borderRadius: 8,
        padding: 10,
        marginTop: 10,
    },
    cardErrorText: {
        color: colors.market.need.fg,
        fontSize: 13,
    },
});
