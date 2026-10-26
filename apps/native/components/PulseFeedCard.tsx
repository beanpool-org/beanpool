/**
 * PulseFeedCard — Facade presentation card for Pulse community feed items (Phase 3).
 *
 * Rules:
 * - Facade cards until the member asks for more. A card renders a static thumbnail, title, platform,
 *   category and author, and fetches nothing from the platform it came from.
 * - YouTube, and only YouTube, then plays in place: tapping ▶ mounts YouTube's own embedded player
 *   in the card (`PulseYouTubePlayer`). Before that tap there is no WebView and nothing has been
 *   requested from Google — `pulseCardMedia` is what decides, and it is unit-tested. Every other
 *   platform opens its own app exactly as it always has. Marty's call, 2026-09-23; the standing
 *   rejection of proxying or re-hosting video is untouched.
 * - External linking: Tapping the card opens the post URL in the device browser/app via Linking.openURL,
 *   strictly validated via `isWebUrl` before invocation.
 * - Emphasizes community: "my neighbour made this" — shows author avatar, callsign, and verified status.
 * - Owner Mute: When the item is owned by the current viewer, provides a mute action with confirmation.
 * - Report: a signed-in viewer can flag someone else's item for the node's operators. The flag opens
 *   an inline reason picker (the post-detail report reasons) — no text input, so no keyboard handling.
 * - Responsive at 320dp and 1.3x font scale: cards reflow and titles wrap cleanly with no horizontal overflow.
 */

import React, { useEffect, useState, useSyncExternalStore } from 'react';
import {
    View,
    Text,
    StyleSheet,
    Pressable,
    Linking,
    Alert,
    Platform,
    Modal,
    ActivityIndicator,
    ScrollView,
    useWindowDimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import {
    isWebUrl,
    platformMeta,
    platformName,
    categoryMeta,
    formatDate,
    t,
} from '@beanpool/core';
import { type PulseFeedItem, type DailyPulseReflection, fetchDailyPulse, pulseAge, isOfficialSource, canReportPulseItem, resolvePulseThumbnailUrl, PULSE_REPORT_REASONS } from '../utils/pulse';
import { CHILD_SAFETY_REASON, CHILD_SAFETY_HINT } from '../utils/reportReasons';
import { pulseLineWords } from './pulse-lines';
import { Sentence } from './Sentence';
import {
    pulseCardMedia,
    playPulseVideo,
    playingPulseVideo,
    subscribeToPulseVideo,
} from '../utils/pulse-video-player';
import { YOUTUBE_MIN_VIEWPORT_PX } from '../utils/youtube-embed';
import { MemberAvatar } from './MemberAvatar';
import { PulseYouTubePlayer } from './PulseYouTubePlayer';
import { useTheme, useStyles } from '../app/ThemeContext';

interface PulseFeedCardProps {
    item: PulseFeedItem;
    currentPubkey?: string | null;
    onMute?: (itemId: string) => void | Promise<void>;
    /** Sends the report; the card shows the flag only when this is provided. */
    onReport?: (item: PulseFeedItem, reason: string) => Promise<void>;
    /** The node the feed came from; preview images load through its thumbnail proxy. */
    nodeUrl?: string | null;
}

/** The report box's line about Child safety: word() keys from utils/reportReasons, shown through t(). */
const LINES = { childSafety: CHILD_SAFETY_REASON, childSafetyHint: CHILD_SAFETY_HINT };

/** When the item was published, in the member's language: "Just now", "25m ago", "3h ago", "2d ago", then the date. */
function publishedWords(dateString: string | null | undefined): string {
    const age = pulseAge(dateString);
    if (!age) return '';
    switch (age.unit) {
        case 'now': return t('Just now');
        case 'minutes': return t('{n}m ago', { n: age.n });
        case 'hours': return t('{n}h ago', { n: age.n });
        case 'days': return t('{n}d ago', { n: age.n });
        case 'date': return formatDate(age.date, 'day-month');
    }
}

export function PulseFeedCard({ item, currentPubkey, onMute, onReport, nodeUrl }: PulseFeedCardProps) {
    const { colors, theme } = useTheme();
    const styles = useStyles(makeStyles);
    const { width: windowWidth, fontScale } = useWindowDimensions();
    // At 320dp with 1.3x text the header cannot fit the author, a labelled category pill and the
    // 48dp flag on one row — the author name collapsed to one letter. On narrow text-scaled
    // screens the pill shows its icon only (as the web card does below its xs breakpoint).
    const compactHeader = windowWidth / fontScale < 360;
    const [imageFailed, setImageFailed] = useState(false);
    const thumbnailUri = resolvePulseThumbnailUrl(nodeUrl, item);

    useEffect(() => {
        setImageFailed(false);
    }, [item.id, thumbnailUri]);
    const [showReport, setShowReport] = useState(false);
    const [reportReason, setReportReason] = useState<string | null>(null);
    const [submittingReport, setSubmittingReport] = useState(false);

    const [playerError, setPlayerError] = useState<string | null>(null);

    // Which card — of all of them — is playing. One player at a time is a property of the feed, not
    // of any single card, so it lives in a store the cards subscribe to rather than in state here.
    const playingItemId = useSyncExternalStore(subscribeToPulseVideo, playingPulseVideo, playingPulseVideo);
    const media = pulseCardMedia(item, playingItemId);
    const isPlaying = media.kind === 'player';

    // A card that starts playing again has left its last failure behind.
    useEffect(() => { if (isPlaying) setPlayerError(null); }, [isPlaying]);

    const isDailyPulse = Boolean(
        item.id?.startsWith('item_pulse_') ||
        item.external_id?.startsWith('daily_pulse_') ||
        item.channel_id === 'chan_daily_pulse'
    );

    const [showReflection, setShowReflection] = useState(false);
    const [reflection, setReflection] = useState<DailyPulseReflection | null>(null);
    const [reflectionLoading, setReflectionLoading] = useState(false);
    const [reflectionError, setReflectionError] = useState(false);

    const loadReflection = async () => {
        setReflectionLoading(true);
        setReflectionError(false);
        try {
            const itemDate = item.id?.startsWith('item_pulse_')
                ? item.id.replace('item_pulse_', '')
                : item.external_id?.startsWith('daily_pulse_')
                ? item.external_id.replace('daily_pulse_', '')
                : undefined;
            const data = await fetchDailyPulse(itemDate);
            setReflection(data);
        } catch {
            setReflectionError(true);
        } finally {
            setReflectionLoading(false);
        }
    };

    const handleOpenDailyPulse = () => {
        setShowReflection(true);
        void loadReflection();
    };

    const isOwner = Boolean(currentPubkey && item.ownerPubkey === currentPubkey);
    const canReport = Boolean(onReport) && canReportPulseItem(item, currentPubkey);
    const isInstagram = item.platform === 'instagram';
    const isInstagramFallback = isInstagram && (!thumbnailUri || imageFailed);
    const platMeta = platformMeta(item.platform);
    const platName = platformName(item.platform);
    const catMeta = categoryMeta(item.category);
    const isVideo = media.kind === 'poster' && media.isVideo;
    const canPlayInApp = media.kind === 'poster' && media.canPlayInApp;
    const timeAgo = publishedWords(item.publishedAt);
    const authorName = item.callsign?.trim() || (item.ownerPubkey ? `${item.ownerPubkey.slice(0, 8)}…` : t('Neighbour'));
    const postTitle = item.title?.trim() || t('View post on {platform}', { platform: platName });
    const titleFirstLine =
        item.title?.split('\n').map((l) => l.trim()).find(Boolean) || postTitle;

    const handleOpenPost = async () => {
        if (!item.url) return;
        const targetUrl = item.url.trim();
        if (!isWebUrl(targetUrl)) {
            console.warn('[PulseFeedCard] Refusing non-web URL scheme:', targetUrl);
            return;
        }

        try {
            await Linking.openURL(targetUrl);
        } catch (e) {
            console.warn('[PulseFeedCard] Error opening URL:', e);
            Alert.alert(t('Cannot Open Link'), t('The link could not be opened on this device.'));
        }
    };

    /** The tap that — and only that — makes this card reach YouTube for the first time. */
    const handlePlayInApp = () => {
        setPlayerError(null);
        playPulseVideo(item.id);
    };

    const handleAuthorPress = () => {
        if (!item.ownerPubkey) return;
        router.push({
            pathname: '/public-profile',
            params: { publicKey: item.ownerPubkey },
        });
    };

    const handleMutePress = () => {
        if (!onMute) return;
        Alert.alert(
            t('Hide this post from feed?'),
            t('"{title}" will no longer be visible to your neighbours on the community feed.', { title: item.title || t('This item') }),
            [
                { text: t('Keep post'), style: 'cancel' },
                {
                    text: t('Hide from feed'),
                    style: 'destructive',
                    onPress: () => onMute(item.id),
                },
            ],
        );
    };

    const closeReport = () => {
        setShowReport(false);
        setReportReason(null);
    };

    const submitReport = async () => {
        if (!onReport || !reportReason || submittingReport) return;
        setSubmittingReport(true);
        try {
            await onReport(item, reportReason);
            closeReport();
            Alert.alert(t('Reported'), t("Thanks. This community's moderators will review it."));
        } catch (e: any) {
            // utils/pulse.ts signs the report and writes English: its sentences are translated here.
            Alert.alert(t('Could not report'), e?.message ? pulseLineWords(e.message) : t('Please try again.'));
        } finally {
            setSubmittingReport(false);
        }
    };

    const postWords = { title: item.title || t('Community post'), name: authorName, platform: platName };
    const cardAccessibilityLabel = item.isVerified
        ? t('{title} by {name} on {platform}, verified creator', postWords)
        : t('{title} by {name} on {platform}', postWords);

    return (
        <View style={styles.cardContainer}>
            {/* Header: Neighbour details + Category */}
            <View style={styles.headerRow}>
                <Pressable
                    onPress={handleAuthorPress}
                    style={styles.authorButton}
                    accessibilityRole="button"
                    accessibilityLabel={t("View {name}'s public profile", { name: authorName })}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                    <MemberAvatar
                        avatarUrl={item.avatarUrl}
                        pubkey={item.ownerPubkey}
                        callsign={authorName}
                        size={38}
                    />
                    <View style={styles.authorInfo}>
                        <View style={styles.callsignRow}>
                            <Text style={styles.callsign} numberOfLines={1}>
                                {authorName}
                            </Text>
                            {item.isVerified ? (
                                <View style={styles.verifiedBadge} accessibilityLabel={t('Verified account')}>
                                    <Text style={styles.verifiedText} allowFontScaling={false}>✓</Text>
                                </View>
                            ) : null}
                        </View>
                        {/* An official source rendered identically to a neighbour's post
                            reads as the community endorsing it, so it is labelled as a
                            source rather than by the platform that carried it. "Blog /
                            RSS" also means nothing to someone reading the local paper.
                            Both stay on one line: without numberOfLines they wrapped letter by
                            letter once the column got narrow, and spilled under the pill. The
                            label gives way first — the footer repeats it, nothing repeats the time. */}
                        <View style={styles.metaRow}>
                            <Text style={isOfficialSource(item) ? styles.sourceBadge : styles.platformBadge} numberOfLines={1}>
                                {isOfficialSource(item) ? t('\u{1F4F0} Local source') : `${platMeta.icon} ${platName}`}
                            </Text>
                            {timeAgo ? (
                                <Text style={styles.timeText} numberOfLines={1}> · {timeAgo}</Text>
                            ) : null}
                        </View>
                    </View>
                </Pressable>

                <View style={styles.headerActions}>
                    <View style={styles.categoryPill} accessibilityLabel={t('Category: {category}', { category: t(catMeta.label) })}>
                        <Text style={styles.categoryText} numberOfLines={1} maxFontSizeMultiplier={1.3}>
                            {compactHeader ? catMeta.icon : t('{emoji} {label}', { emoji: catMeta.icon, label: t(catMeta.label) })}
                        </Text>
                    </View>

                    {canReport && (
                        <Pressable
                            onPress={() => (showReport ? closeReport() : setShowReport(true))}
                            style={styles.reportFlagBtn}
                            accessibilityRole="button"
                            accessibilityLabel={t('Report this post')}
                            accessibilityState={{ expanded: showReport }}
                        >
                            <Text style={styles.reportFlagText} aria-hidden={true}>⚑</Text>
                        </Pressable>
                    )}

                    {isOwner && onMute && (
                        <Pressable
                            onPress={handleMutePress}
                            style={styles.muteBtn}
                            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                            accessibilityRole="button"
                            accessibilityLabel={t('Hide this item from feed')}
                        >
                            <Text style={styles.muteBtnText}>{t('Hide')}</Text>
                        </Pressable>
                    )}
                </View>
            </View>

            {showReport && canReport && (
                <View style={styles.reportBox}>
                    <Text style={styles.reportBoxLabel}>{t('Report this post — why?')}</Text>
                    <View style={styles.reportReasons}>
                        {PULSE_REPORT_REASONS.map((r, i) => {
                            // The reason goes to the node as it is written (English: the server reads Child safety); shown translated.
                            const isSelected = reportReason === r;
                            return (
                                <Pressable
                                    key={r}
                                    onPress={() => setReportReason(r)}
                                    style={[styles.reportReasonChip, isSelected && styles.reportReasonChipSelected]}
                                    accessibilityRole="button"
                                    accessibilityState={{ selected: isSelected }}
                                >
                                    <Text style={[styles.reportReasonText, isSelected && styles.reportReasonTextSelected]}>
                                        {isSelected ? t('✓ {reason}', { reason: t(PULSE_REPORT_REASONS[i]) }) : t(PULSE_REPORT_REASONS[i])}
                                    </Text>
                                </Pressable>
                            );
                        })}
                    </View>
                    <Text style={styles.reportHint}>
                        <Sentence text={t('{reason}: {hint}', { hint: t(LINES.childSafetyHint) })} parts={{ reason: <Text style={styles.reportHintLabel}>{t(LINES.childSafety)}</Text> }} />
                    </Text>
                    <View style={styles.reportActions}>
                        <Pressable
                            onPress={closeReport}
                            disabled={submittingReport}
                            style={styles.reportCancelBtn}
                            accessibilityRole="button"
                        >
                            <Text style={styles.reportCancelText}>{t('Cancel')}</Text>
                        </Pressable>
                        <Pressable
                            onPress={submitReport}
                            disabled={!reportReason || submittingReport}
                            style={[styles.reportSubmitBtn, (!reportReason || submittingReport) && styles.reportSubmitDisabled]}
                            accessibilityRole="button"
                            accessibilityState={{ disabled: !reportReason || submittingReport }}
                        >
                            <Text style={styles.reportSubmitText}>{submittingReport ? t('Sending…') : t('Submit report')}</Text>
                        </Pressable>
                    </View>
                </View>
            )}

            {/* The media area: YouTube's player once the member has tapped ▶, a plain line if that
                player failed, and otherwise the facade poster this feed has always shown. The
                three are mutually exclusive, which is how "nothing is drawn over a playing player"
                is guaranteed structurally rather than by a z-index.
                For Instagram with no thumbnail (or failed image), we render a designed link card
                with title, author, and one clear button to open on Instagram. */}
            {isInstagramFallback ? (
                <View style={styles.instagramCardBody}>
                    <View style={styles.instagramBadgeRow}>
                        <View style={styles.instagramBadge}>
                            <Text style={styles.instagramGlyph}>{platMeta.icon}</Text>
                            <Text style={styles.instagramBadgeText}>{platName}</Text>
                        </View>
                    </View>
                    <Text style={styles.instagramTitle} numberOfLines={3}>
                        {titleFirstLine}
                    </Text>
                    <Text style={styles.instagramAuthor} numberOfLines={1}>
                        {authorName}
                    </Text>
                    {item.url ? (
                        <Pressable
                            onPress={handleOpenPost}
                            style={({ pressed }) => [
                                styles.instagramButton,
                                pressed && styles.contentPressed,
                            ]}
                            accessibilityRole="link"
                            accessibilityLabel={t('Open on Instagram')}
                        >
                            <Text style={styles.instagramButtonText}>{t('Open on Instagram')}</Text>
                        </Pressable>
                    ) : null}
                </View>
            ) : media.kind === 'player' ? (
                // Grown to at least 200px tall while playing: at 320dp a 16:9 card is about 162px,
                // and YouTube's terms require a viewport of at least 200x200. The player letterboxes
                // inside it rather than the video being cropped.
                <View style={[styles.thumbnailWrap, styles.playerWrap]}>
                    <PulseYouTubePlayer
                        itemId={item.id}
                        html={media.html}
                        baseUrl={media.baseUrl}
                        embedUrl={media.embedUrl}
                        onError={setPlayerError}
                    />
                </View>
            ) : playerError ? (
                <View style={[styles.thumbnailWrap, styles.playerErrorWrap]}>
                    <Text style={styles.playerErrorText}>{playerError}</Text>
                    {item.url ? (
                        <Pressable
                            onPress={handleOpenPost}
                            style={styles.playerErrorBtn}
                            accessibilityRole="link"
                            accessibilityLabel={item.title
                                ? t('Open {post} on {platform}', { post: item.title, platform: platName })
                                : t('Open this video on {platform}', { platform: platName })}
                        >
                            <Text style={styles.playerErrorBtnText}>{t('Open on {platform} ↗', { platform: platName })}</Text>
                        </Pressable>
                    ) : null}
                </View>
            ) : (
                <Pressable
                    disabled={!item.url && !isDailyPulse}
                    onPress={canPlayInApp ? handlePlayInApp : (isDailyPulse ? handleOpenDailyPulse : (item.url ? handleOpenPost : undefined))}
                    style={({ pressed }) => [
                        styles.contentPressable,
                        (item.url || isDailyPulse) && pressed && styles.contentPressed,
                    ]}
                    accessibilityRole={canPlayInApp || isDailyPulse ? 'button' : (item.url ? 'link' : undefined)}
                    accessibilityLabel={canPlayInApp ? t('Play {post}', { post: cardAccessibilityLabel }) : (isDailyPulse ? t('🌱 Daily Reflection') : cardAccessibilityLabel)}
                    accessibilityHint={
                        canPlayInApp
                            ? t('Plays the video here, in this card')
                            : (item.url ? t('Opens external post in browser or app') : undefined)
                    }
                >
                    {thumbnailUri && !imageFailed ? (
                        <View style={styles.thumbnailWrap}>
                            <Image
                                source={{ uri: thumbnailUri }}
                                style={styles.thumbnail}
                                contentFit="cover"
                                transition={200}
                                onError={() => setImageFailed(true)}
                                accessible={false}
                            />
                            {isVideo && (
                                <View style={styles.playOverlay} aria-hidden={true}>
                                    <View style={styles.playCircle}>
                                        <Text style={styles.playIcon} allowFontScaling={false}>▶</Text>
                                    </View>
                                </View>
                            )}
                            {item.url ? (
                                <View style={styles.externalBadge}>
                                    <Text style={styles.externalBadgeText}>{platName} ↗</Text>
                                </View>
                            ) : null}
                        </View>
                    ) : (
                        <View style={[styles.thumbnailWrap, styles.placeholderThumbnail]}>
                            <Text style={styles.placeholderIcon}>{isDailyPulse ? '🌱' : platMeta.icon}</Text>
                            {item.url ? (
                                <View style={styles.externalBadge}>
                                    <Text style={styles.externalBadgeText}>{platName} ↗</Text>
                                </View>
                            ) : null}
                        </View>
                    )}
                </Pressable>
            )}

            {/* Title and permalink action. "Open on YouTube ↗" stays under every card, playing or
                not: playing here is an extra, never the only way to reach the video.
                On Instagram cards, we drop the duplicate second link (keep one way out). */}
            {!isInstagramFallback && (
                isInstagram ? (
                    <View style={styles.bodyWrap}>
                        <Text style={styles.title} numberOfLines={3}>
                            {titleFirstLine}
                        </Text>
                    </View>
                ) : (
                    <Pressable
                        disabled={!item.url && !isDailyPulse}
                        onPress={isDailyPulse ? handleOpenDailyPulse : (item.url ? handleOpenPost : undefined)}
                        style={({ pressed }) => [
                            styles.contentPressable,
                            (item.url || isDailyPulse) && pressed && styles.contentPressed,
                        ]}
                        accessibilityRole={isDailyPulse ? 'button' : (item.url ? 'link' : undefined)}
                        accessibilityLabel={isDailyPulse ? t('🌱 Daily Reflection') : (item.url ? t('Open {post} on {platform}', { post: cardAccessibilityLabel, platform: platName }) : undefined)}
                        accessibilityHint={item.url ? t('Opens external post in browser or app') : undefined}
                    >
                        <View style={styles.bodyWrap}>
                            <Text style={styles.title} numberOfLines={3}>
                                {item.title || t('View post on {platform}', { platform: platName })}
                            </Text>
                            {item.url ? (
                                <View style={styles.footerLinkRow}>
                                    <Text style={styles.footerLinkText}>
                                        <Sentence text={t('Open on {platform} {arrow}', { platform: platName })} parts={{ arrow: <Text style={styles.arrowIcon}>↗</Text> }} />
                                    </Text>
                                </View>
                            ) : (
                                <View style={styles.footerLinkRow}>
                                    <Text style={styles.footerLinkText}>
                                        {t('🌱 Daily Reflection')}
                                    </Text>
                                </View>
                            )}
                        </View>
                    </Pressable>
                )
            )}

            {/* Daily Pulse reflection sheet */}
            {isDailyPulse && (
                <Modal
                    visible={showReflection}
                    animationType="slide"
                    transparent
                    onRequestClose={() => setShowReflection(false)}
                    statusBarTranslucent
                >
                    <View style={styles.modalBackdrop}>
                        <Pressable
                            style={styles.modalBackdropPressable}
                            onPress={() => setShowReflection(false)}
                            accessibilityLabel={t('Close')}
                            accessibilityRole="button"
                        />
                        <View style={styles.modalSheet} testID="pulse-reflection-modal">
                            <View style={styles.modalHandleBar} />
                            <View style={styles.modalHeader}>
                                <View style={styles.modalTitleWrap}>
                                    <Text style={styles.modalTitle} accessibilityRole="header">
                                        {t('🌱 Daily Reflection')}
                                    </Text>
                                    {reflection?.date ? (
                                        <Text style={styles.modalDate}>{reflection.date}</Text>
                                    ) : null}
                                </View>
                                <Pressable
                                    onPress={() => setShowReflection(false)}
                                    style={styles.modalCloseButton}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('Close')}
                                >
                                    <Text style={styles.modalCloseText}>{t('Close')}</Text>
                                </Pressable>
                            </View>

                            <ScrollView style={styles.modalContent} contentContainerStyle={styles.modalContentInner}>
                                {reflectionLoading ? (
                                    <View style={styles.modalLoadingWrap}>
                                        <ActivityIndicator size="small" color={colors.primary} />
                                        <Text style={styles.modalLoadingText}>{t('Loading')}</Text>
                                    </View>
                                ) : reflectionError ? (
                                    <View style={styles.modalErrorWrap}>
                                        <Text style={styles.modalErrorText}>{t('Failed to load')}</Text>
                                        <Pressable
                                            onPress={loadReflection}
                                            style={styles.modalRetryButton}
                                            accessibilityRole="button"
                                            accessibilityLabel={t('Retry')}
                                        >
                                            <Text style={styles.modalRetryText}>{t('Retry')}</Text>
                                        </Pressable>
                                    </View>
                                ) : reflection ? (
                                    <View style={styles.modalBodyWrap}>
                                        <Text style={styles.reflectionHeadline}>
                                            {reflection.headline}
                                        </Text>
                                        <Text style={styles.reflectionBody}>
                                            {reflection.body}
                                        </Text>
                                    </View>
                                ) : null}
                            </ScrollView>
                        </View>
                    </View>
                </Modal>
            )}
        </View>
    );
}

const makeStyles = ({ colors, theme }: { colors: any; theme: string }) =>
    StyleSheet.create({
        cardContainer: {
            backgroundColor: colors.surface.card,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: colors.border.default,
            marginBottom: 16,
            overflow: 'hidden',
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: theme === 'dark' ? 0.3 : 0.06,
            shadowRadius: 6,
            elevation: 2,
        },
        headerRow: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 14,
            paddingTop: 12,
            paddingBottom: 10,
        },
        authorButton: {
            flexDirection: 'row',
            alignItems: 'center',
            flex: 1,
            minWidth: 0,
            marginRight: 8,
        },
        authorInfo: {
            marginLeft: 10,
            flex: 1,
            minWidth: 0,
            justifyContent: 'center',
        },
        callsignRow: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
        },
        callsign: {
            fontSize: 15,
            fontWeight: '700',
            color: colors.text.heading,
            flexShrink: 1,
        },
        verifiedBadge: {
            width: 15,
            height: 15,
            borderRadius: 7.5,
            backgroundColor: colors.brand.fill,
            alignItems: 'center',
            justifyContent: 'center',
            marginLeft: 2,
        },
        verifiedText: {
            color: colors.text.inverse,
            fontSize: 9,
            fontWeight: '900',
            lineHeight: 11,
        },
        metaRow: {
            flexDirection: 'row',
            alignItems: 'center',
            marginTop: 2,
        },
        platformBadge: {
            flexShrink: 1,
            fontSize: 12,
            fontWeight: '600',
            color: colors.text.secondary,
        },
        sourceBadge: {
            flexShrink: 1,
            fontSize: 12,
            fontWeight: '700',
            color: colors.accent.primary,
        },
        timeText: {
            flexShrink: 0,
            fontSize: 12,
            color: colors.text.muted,
        },
        headerActions: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            flexShrink: 0,
        },
        categoryPill: {
            backgroundColor: colors.surface.subtle,
            borderRadius: 12,
            paddingVertical: 4,
            paddingHorizontal: 8,
            borderWidth: 1,
            borderColor: colors.border.default,
        },
        categoryText: {
            fontSize: 12,
            fontWeight: '600',
            color: colors.text.secondary,
        },
        muteBtn: {
            paddingVertical: 6,
            paddingHorizontal: 10,
            borderRadius: 8,
            backgroundColor: theme === 'dark' ? 'rgba(239, 68, 68, 0.15)' : '#fee2e2',
        },
        muteBtnText: {
            fontSize: 12,
            fontWeight: '600',
            color: colors.market.need.fg,
        },
        reportFlagBtn: {
            minWidth: 48,
            minHeight: 48,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 8,
            marginVertical: -8,
        },
        reportFlagText: {
            fontSize: 18,
            color: colors.text.muted,
        },
        reportBox: {
            marginHorizontal: 14,
            marginBottom: 12,
            padding: 12,
            borderRadius: 10,
            borderWidth: 1,
            backgroundColor: colors.feedback.danger.bg,
            borderColor: colors.feedback.danger.border,
        },
        reportBoxLabel: {
            fontSize: 13,
            fontWeight: '700',
            color: colors.text.heading,
            marginBottom: 8,
        },
        reportReasons: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 8,
            marginBottom: 12,
        },
        reportHint: {
            fontSize: 13,
            color: colors.text.body,
            marginBottom: 12,
        },
        reportHintLabel: {
            fontWeight: '700',
        },
        reportReasonChip: {
            minHeight: 48,
            justifyContent: 'center',
            paddingHorizontal: 14,
            paddingVertical: 8,
            borderRadius: 24,
            borderWidth: 1,
            backgroundColor: colors.surface.card,
            borderColor: colors.border.default,
            maxWidth: '100%',
        },
        reportReasonChipSelected: {
            backgroundColor: colors.feedback.danger.solid,
            borderColor: colors.feedback.danger.solid,
        },
        reportReasonText: {
            fontSize: 13,
            fontWeight: '700',
            color: colors.text.body,
        },
        reportReasonTextSelected: {
            color: colors.text.inverse,
        },
        reportActions: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 8,
        },
        reportCancelBtn: {
            flexGrow: 1,
            minHeight: 48,
            paddingHorizontal: 14,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 10,
            borderWidth: 1,
            borderColor: colors.border.default,
            backgroundColor: colors.surface.card,
        },
        reportCancelText: {
            fontSize: 14,
            fontWeight: '600',
            color: colors.text.body,
        },
        reportSubmitBtn: {
            flexGrow: 1,
            minHeight: 48,
            paddingHorizontal: 14,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 10,
            backgroundColor: colors.feedback.danger.solid,
        },
        reportSubmitDisabled: {
            opacity: 0.5,
        },
        reportSubmitText: {
            fontSize: 14,
            fontWeight: '700',
            color: colors.text.inverse,
        },
        contentPressable: {
            width: '100%',
        },
        contentPressed: {
            opacity: 0.92,
        },
        thumbnailWrap: {
            width: '100%',
            aspectRatio: 16 / 9,
            backgroundColor: colors.surface.subtle,
            position: 'relative',
            justifyContent: 'center',
            alignItems: 'center',
            overflow: 'hidden',
        },
        thumbnail: {
            width: '100%',
            height: '100%',
        },
        placeholderThumbnail: {
            backgroundColor: theme === 'dark' ? '#1f2937' : '#f3f4f6',
        },
        // YouTube requires at least 200x200 CSS pixels for its player. `aspectRatio` sets the
        // height from the width first and these clamp it, so a 16:9 card that would be ~162px tall
        // at 320dp becomes 200px and the video letterboxes inside it.
        playerWrap: {
            minHeight: YOUTUBE_MIN_VIEWPORT_PX,
            minWidth: YOUTUBE_MIN_VIEWPORT_PX,
            backgroundColor: '#000000',
        },
        playerErrorWrap: {
            paddingHorizontal: 16,
            gap: 12,
            backgroundColor: theme === 'dark' ? '#1f2937' : '#f3f4f6',
        },
        playerErrorText: {
            fontSize: 14,
            lineHeight: 20,
            textAlign: 'center',
            color: colors.text.body,
        },
        playerErrorBtn: {
            minHeight: 48,
            justifyContent: 'center',
            paddingHorizontal: 16,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: colors.border.default,
            backgroundColor: colors.surface.card,
        },
        playerErrorBtnText: {
            fontSize: 14,
            fontWeight: '700',
            color: colors.text.link,
        },
        placeholderIcon: {
            fontSize: 48,
            opacity: 0.6,
        },
        playOverlay: {
            ...StyleSheet.absoluteFillObject,
            justifyContent: 'center',
            alignItems: 'center',
            backgroundColor: 'rgba(0, 0, 0, 0.2)',
        },
        playCircle: {
            width: 48,
            height: 48,
            borderRadius: 24,
            backgroundColor: 'rgba(0, 0, 0, 0.65)',
            justifyContent: 'center',
            alignItems: 'center',
            borderWidth: 1.5,
            borderColor: 'rgba(255, 255, 255, 0.85)',
        },
        playIcon: {
            color: '#ffffff',
            fontSize: 18,
            marginLeft: 3, // visual optical center
        },
        externalBadge: {
            position: 'absolute',
            bottom: 8,
            right: 8,
            backgroundColor: 'rgba(0, 0, 0, 0.72)',
            paddingVertical: 3,
            paddingHorizontal: 7,
            borderRadius: 6,
        },
        externalBadgeText: {
            color: '#ffffff',
            fontSize: 11,
            fontWeight: '600',
        },
        bodyWrap: {
            padding: 14,
            paddingTop: 12,
        },
        title: {
            fontSize: 16,
            fontWeight: '600',
            lineHeight: 22,
            color: colors.text.heading,
            flexShrink: 1,
        },
        footerLinkRow: {
            flexDirection: 'row',
            alignItems: 'center',
            marginTop: 8,
        },
        footerLinkText: {
            fontSize: 13,
            fontWeight: '600',
            color: colors.text.link,
        },
        arrowIcon: {
            fontSize: 13,
        },
        instagramCardBody: {
            padding: 14,
            gap: 10,
        },
        instagramBadgeRow: {
            flexDirection: 'row',
            alignItems: 'center',
        },
        instagramBadge: {
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: colors.surface.subtle,
            borderWidth: 1,
            borderColor: colors.border.default,
            borderRadius: 8,
            paddingVertical: 4,
            paddingHorizontal: 8,
            gap: 5,
        },
        instagramGlyph: {
            fontSize: 14,
        },
        instagramBadgeText: {
            fontSize: 12,
            fontWeight: '700',
            color: colors.text.secondary,
        },
        instagramTitle: {
            fontSize: 16,
            fontWeight: '600',
            lineHeight: 22,
            color: colors.text.heading,
        },
        instagramAuthor: {
            fontSize: 13,
            fontWeight: '500',
            color: colors.text.secondary,
        },
        instagramButton: {
            minHeight: 44,
            minWidth: 44,
            justifyContent: 'center',
            alignItems: 'center',
            paddingHorizontal: 16,
            paddingVertical: 10,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: colors.border.default,
            backgroundColor: colors.surface.card,
            marginTop: 4,
        },
        instagramButtonText: {
            fontSize: 14,
            fontWeight: '700',
            color: colors.text.heading,
        },
        modalBackdrop: {
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.5)',
            justifyContent: 'flex-end',
        },
        modalBackdropPressable: {
            ...StyleSheet.absoluteFillObject,
        },
        modalSheet: {
            backgroundColor: colors.surface.card,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            maxHeight: '85%',
            paddingBottom: 24,
        },
        modalHandleBar: {
            width: 36,
            height: 4,
            borderRadius: 2,
            backgroundColor: colors.border.default,
            alignSelf: 'center',
            marginTop: 8,
            marginBottom: 8,
        },
        modalHeader: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
            paddingBottom: 12,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: colors.border.default,
        },
        modalTitleWrap: {
            flex: 1,
        },
        modalTitle: {
            fontSize: 16,
            fontWeight: '700',
            color: colors.text.heading,
        },
        modalDate: {
            fontSize: 12,
            color: colors.text.muted,
            marginTop: 2,
        },
        modalCloseButton: {
            minHeight: 44,
            minWidth: 44,
            justifyContent: 'center',
            alignItems: 'flex-end',
            paddingHorizontal: 8,
        },
        modalCloseText: {
            fontSize: 15,
            fontWeight: '600',
            color: colors.text.link,
        },
        modalContent: {
            paddingHorizontal: 16,
        },
        modalContentInner: {
            paddingVertical: 16,
        },
        modalLoadingWrap: {
            paddingVertical: 32,
            alignItems: 'center',
            gap: 8,
        },
        modalLoadingText: {
            fontSize: 14,
            color: colors.text.muted,
        },
        modalErrorWrap: {
            paddingVertical: 32,
            alignItems: 'center',
            gap: 12,
        },
        modalErrorText: {
            fontSize: 14,
            color: colors.text.danger || '#ef4444',
        },
        modalRetryButton: {
            minHeight: 44,
            minWidth: 88,
            paddingHorizontal: 16,
            paddingVertical: 10,
            borderRadius: 8,
            backgroundColor: colors.surface.sunken || '#e5e7eb',
            alignItems: 'center',
            justifyContent: 'center',
        },
        modalRetryText: {
            fontSize: 14,
            fontWeight: '600',
            color: colors.text.heading,
        },
        modalBodyWrap: {
            gap: 12,
        },
        reflectionHeadline: {
            fontSize: 18,
            fontWeight: '700',
            color: colors.text.heading,
            marginBottom: 12,
            lineHeight: 24,
        },
        reflectionBody: {
            fontSize: 15,
            lineHeight: 22,
            color: colors.text.body,
        },
    });
