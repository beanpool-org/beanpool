/**
 * Manual Pulse Ingestion Screen (The Pulse, Phase 4 / Package 05).
 *
 * Allows a community member to share a post to The Pulse manually.
 *
 * Flows & Features:
 * 1. URL Input: Member pastes or types a post URL (or arrives with URL prefilled
 *    from a clipboard nudge / share intent).
 * 2. URL formatting: `autoCapitalize="none" autoCorrect={false} spellCheck={false} keyboardType="url"`
 *    with automatic live whitespace stripping.
 * 3. Channel matching: Auto-detects matching channel or allows picking from member's connected channels.
 * 4. Live SSRF-safe Preview: Resolves title, thumbnail, and deduplication status via `POST /api/member/pulse/preview`.
 * 5. Review & Confirm: Displays facade preview card with opt-in toggle before publishing.
 * 6. Submission: Submits to `POST /api/member/pulse/submit` using `signedPost`.
 * 7. Inline Errors: Displays error messages directly next to the input and submit buttons.
 *
 * Rules:
 * - Must render at 320dp width and 1.3x font scale without horizontal scroll.
 * - Keyboard avoidance: KeyboardAvoidingView from react-native-keyboard-controller (behavior="padding", keyboardVerticalOffset={64}).
 * - SafeAreaView from react-native-safe-area-context.
 * - Uses flexGrow/flexBasis, never fixed percentages.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    View,
    Text,
    StyleSheet,
    Pressable,
    TextInput,
    ScrollView,
    ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { router, useLocalSearchParams } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import {
    type ChannelPlatform as Platform,
    type ChannelCategory as Category,
    CATEGORIES,
    PLATFORMS,
    platformMeta,
    categoryMeta,
    isWebUrl,
} from '@beanpool/core';
import { lightColors } from '../constants/colors';
import { useIdentity } from './IdentityContext';
import { useTheme, useStyles } from './ThemeContext';
import { anchorUrl, signedPost } from '../utils/node-post';
import { PulsePreviewCard, type PulsePreviewData } from '../components/PulsePreviewCard';

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

export function safeDecodeURIComponent(value: string | undefined): string {
    if (!value) return '';
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

export default function PulseIntakeScreen() {
    const { colors, theme } = useTheme();
    const { identity } = useIdentity();
    const styles = useStyles(makeStyles);
    const params = useLocalSearchParams<{ url?: string; channelId?: string }>();

    const [channels, setChannels] = useState<Channel[]>([]);
    const [loadingChannels, setLoadingChannels] = useState(true);
    const [channelError, setChannelError] = useState<string | null>(null);

    // Form inputs
    const [urlInput, setUrlInput] = useState<string>(safeDecodeURIComponent(params.url));
    const [selectedChannelId, setSelectedChannelId] = useState<string | null>(params.channelId || null);
    const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);

    // Live preview resolution state
    const [resolving, setResolving] = useState(false);
    const [previewData, setPreviewData] = useState<PulsePreviewData | null>(null);
    const [urlError, setUrlError] = useState<string | null>(null);
    const [isOptedIn, setIsOptedIn] = useState(true);

    // Submission state
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);
    const [submitSuccess, setSubmitSuccess] = useState(false);

    const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastResolvedUrlRef = useRef<string | null>(null);

    /**
     * Load member's connected channels
     */
    const loadChannels = useCallback(async () => {
        if (!identity) {
            setChannelError('No identity available on this device.');
            setLoadingChannels(false);
            return;
        }
        try {
            const url = await anchorUrl();
            if (!url) {
                setChannelError('No community node configured.');
                setLoadingChannels(false);
                return;
            }
            const res = await signedPost(url, '/api/channels/mine', {}, identity);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.message || 'Could not load your channels.');
            const list: Channel[] = data.channels || [];
            setChannels(list);
            setChannelError(null);

            // Auto-select initial channel if provided or if only 1 exists
            if (params.channelId && list.some(c => c.id === params.channelId)) {
                setSelectedChannelId(params.channelId);
            } else if (list.length === 1) {
                setSelectedChannelId(list[0].id);
                setSelectedCategory(list[0].category);
            }
        } catch (e: any) {
            setChannelError(e?.message || 'Failed to load channels.');
        } finally {
            setLoadingChannels(false);
        }
    }, [identity, params.channelId]);

    useEffect(() => {
        loadChannels();
    }, [loadChannels]);

    /**
     * Resolve post preview from server
     */
    const resolvePreview = useCallback(async (urlToResolve: string, channelIdOverride?: string | null) => {
        const cleanUrl = urlToResolve.trim();
        if (!cleanUrl || !isWebUrl(cleanUrl)) {
            setPreviewData(null);
            setUrlError(null);
            return;
        }

        if (!identity) return;

        setResolving(true);
        setUrlError(null);
        setSubmitError(null);

        try {
            const serverUrl = await anchorUrl();
            if (!serverUrl) throw new Error('No community node available.');

            const res = await signedPost(
                serverUrl,
                '/api/member/pulse/preview',
                {
                    url: cleanUrl,
                    channelId: channelIdOverride || selectedChannelId || undefined,
                },
                identity
            );

            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(data?.message || data?.error || 'Could not preview post URL.');
            }

            const p = data.preview;
            if (p) {
                setPreviewData({
                    url: p.url,
                    title: p.title,
                    thumbnailUrl: p.thumbnailUrl,
                    platform: p.platform,
                    category: p.category,
                    isDuplicate: p.isDuplicate || p.alreadyImported,
                    duplicateItemId: p.duplicateItemId || p.existingItemId,
                    authorCallsign: identity.callsign,
                    publishedAt: p.publishedAt,
                });

                // Auto-sync channel & category if determined by preview
                if (p.channelId && !selectedChannelId) {
                    setSelectedChannelId(p.channelId);
                }
                if (p.category && !selectedCategory) {
                    setSelectedCategory(p.category);
                }
            }
        } catch (e: any) {
            setUrlError(e?.message || 'Unable to resolve post preview.');
            setPreviewData(null);
        } finally {
            setResolving(false);
        }
    }, [identity, selectedChannelId, selectedCategory]);

    /**
     * Handle URL input change with live whitespace stripping and debounced preview resolution
     */
    const handleUrlChange = (text: string) => {
        // House Rule: Strip whitespace as it is typed
        const cleaned = text.replace(/\s+/g, '');
        setUrlInput(cleaned);
        setUrlError(null);
        setSubmitError(null);
        setSubmitSuccess(false);

        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
        }

        if (cleaned && isWebUrl(cleaned)) {
            debounceTimerRef.current = setTimeout(() => {
                resolvePreview(cleaned);
            }, 500);
        } else {
            setPreviewData(null);
        }
    };

    // Trigger preview if prefilled URL exists
    useEffect(() => {
        if (params.url) {
            const decoded = safeDecodeURIComponent(params.url).replace(/\s+/g, '');
            if (decoded && decoded !== lastResolvedUrlRef.current) {
                lastResolvedUrlRef.current = decoded;
                setUrlInput(decoded);
                resolvePreview(decoded);
            }
        }
    }, [params.url]);

    useEffect(() => {
        return () => {
            if (debounceTimerRef.current) {
                clearTimeout(debounceTimerRef.current);
            }
        };
    }, []);

    /**
     * Paste URL from clipboard
     */
    const pasteFromClipboard = async () => {
        try {
            const clip = await Clipboard.getStringAsync();
            if (clip) {
                const cleaned = clip.trim().replace(/\s+/g, '');
                handleUrlChange(cleaned);
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
            }
        } catch {
            // ignore clipboard failure
        }
    };

    /**
     * Submit post to The Pulse
     */
    const handleSubmit = async () => {
        if (!identity) return;
        if (!urlInput.trim()) {
            setUrlError('Please enter a post URL.');
            return;
        }
        if (!selectedChannelId) {
            setSubmitError('Please select which of your channels this post belongs to.');
            return;
        }
        if (!isOptedIn) {
            setSubmitError('Review toggle is currently opted out. Toggle "Publish to Pulse" to submit.');
            return;
        }

        setSubmitting(true);
        setSubmitError(null);

        try {
            const serverUrl = await anchorUrl();
            if (!serverUrl) throw new Error('No community node available.');

            const res = await signedPost(
                serverUrl,
                '/api/member/pulse/submit',
                {
                    url: urlInput.trim(),
                    channelId: selectedChannelId,
                    title: previewData?.title || undefined,
                    thumbnailUrl: previewData?.thumbnailUrl || undefined,
                    category: selectedCategory || previewData?.category || undefined,
                    externalId: previewData?.duplicateItemId || undefined,
                },
                identity
            );

            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(data?.message || data?.error || 'Could not submit post to Pulse.');
            }

            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
            setSubmitSuccess(true);

            // Return back to previous screen or channels after a brief delay
            setTimeout(() => {
                if (router.canGoBack()) {
                    router.back();
                } else {
                    router.replace('/channels');
                }
            }, 1200);
        } catch (e: any) {
            setSubmitError(e?.message || 'Submission failed. Please check the details and retry.');
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        } finally {
            setSubmitting(false);
        }
    };

    const selectedChannel = channels.find(c => c.id === selectedChannelId);

    return (
        <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
            <KeyboardAvoidingView
                style={styles.keyboardAvoid}
                behavior="padding"
                keyboardVerticalOffset={64}
            >
                {/* Screen Header */}
                <View style={styles.header}>
                    <Pressable
                        onPress={() => router.back()}
                        style={styles.backButton}
                        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                        accessibilityRole="button"
                        accessibilityLabel="Go back"
                    >
                        <Text style={styles.backIcon} allowFontScaling={false}>←</Text>
                        <Text style={styles.backText}>Back</Text>
                    </Pressable>

                    <Text style={styles.headerTitle} numberOfLines={1}>
                        Add to Pulse
                    </Text>
                    <View style={styles.headerSpacer} />
                </View>

                <ScrollView
                    contentContainerStyle={styles.scrollContent}
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator={false}
                >
                    {/* Intro subtitle */}
                    <Text style={styles.introText}>
                        Share a single post or video from your external channels to your local community feed.
                    </Text>

                    {/* No Channels Notice */}
                    {!loadingChannels && channels.length === 0 ? (
                        <View style={styles.noChannelsCard} accessibilityRole="alert">
                            <Text style={styles.noChannelsIcon} allowFontScaling={false}>ℹ️</Text>
                            <Text style={styles.noChannelsTitle}>No Channels Connected</Text>
                            <Text style={styles.noChannelsBody}>
                                To share a post, you need to add your Instagram, TikTok, YouTube, or Blog channel first.
                            </Text>
                            <Pressable
                                onPress={() => router.push('/channels')}
                                style={styles.addChannelButton}
                                accessibilityRole="button"
                                accessibilityLabel="Manage Channels"
                            >
                                <Text style={styles.addChannelButtonText}>Add a Channel</Text>
                            </Pressable>
                        </View>
                    ) : null}

                    {channelError ? (
                        <View style={styles.errorBanner}>
                            <Text style={styles.errorBannerText}>{channelError}</Text>
                        </View>
                    ) : null}

                    {/* URL Input Section */}
                    <View style={styles.section}>
                        <View style={styles.sectionHeaderRow}>
                            <Text style={styles.label}>Post URL</Text>
                            <Pressable
                                onPress={pasteFromClipboard}
                                style={styles.pasteButton}
                                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                                accessibilityRole="button"
                                accessibilityLabel="Paste link from clipboard"
                            >
                                <Text style={styles.pasteText}>Paste</Text>
                            </Pressable>
                        </View>

                        <TextInput
                            style={[styles.input, urlError ? styles.inputError : null]}
                            value={urlInput}
                            onChangeText={handleUrlChange}
                            placeholder="https://instagram.com/p/... or tiktok.com/..."
                            placeholderTextColor={colors.text.muted}
                            autoCapitalize="none"
                            autoCorrect={false}
                            spellCheck={false}
                            keyboardType="url"
                            returnKeyType="done"
                            onSubmitEditing={() => resolvePreview(urlInput)}
                        />

                        {/* Inline URL Error */}
                        {urlError ? (
                            <View style={styles.inlineErrorRow} accessibilityRole="alert">
                                <Text style={styles.inlineErrorIcon} allowFontScaling={false}>⚠️</Text>
                                <Text style={styles.inlineErrorText}>{urlError}</Text>
                            </View>
                        ) : null}

                        {resolving ? (
                            <View style={styles.resolvingRow}>
                                <ActivityIndicator size="small" color={colors.brand.primary} />
                                <Text style={styles.resolvingText}>Resolving post preview...</Text>
                            </View>
                        ) : null}
                    </View>

                    {/* Channel Selector Section (if member has channels) */}
                    {channels.length > 0 ? (
                        <View style={styles.section}>
                            <Text style={styles.label}>Post from Channel</Text>
                            <View style={styles.chipsRow}>
                                {channels.map((ch) => {
                                    const meta = platformMeta(ch.platform);
                                    const isSelected = selectedChannelId === ch.id;
                                    const handleText = ch.handle ? ` · ${ch.handle}` : '';

                                    return (
                                        <Pressable
                                            key={ch.id}
                                            onPress={() => {
                                                setSelectedChannelId(ch.id);
                                                setSelectedCategory(ch.category);
                                                if (urlInput) resolvePreview(urlInput, ch.id);
                                            }}
                                            style={[
                                                styles.chip,
                                                isSelected && styles.chipSelected,
                                            ]}
                                            accessibilityRole="radio"
                                            accessibilityState={{ selected: isSelected }}
                                            accessibilityLabel={`${meta.label}${handleText}`}
                                        >
                                            <Text style={styles.chipIcon} allowFontScaling={false}>
                                                {meta.icon}
                                            </Text>
                                            <Text
                                                style={[
                                                    styles.chipText,
                                                    isSelected && styles.chipTextSelected,
                                                ]}
                                                numberOfLines={1}
                                            >
                                                {meta.label}{handleText}
                                            </Text>
                                        </Pressable>
                                    );
                                })}
                            </View>
                        </View>
                    ) : null}

                    {/* Category Selector Section */}
                    {channels.length > 0 ? (
                        <View style={styles.section}>
                            <Text style={styles.label}>Category</Text>
                            <View style={styles.chipsRow}>
                                {CATEGORIES.map((cat) => {
                                    const isSelected = selectedCategory === cat.id;

                                    return (
                                        <Pressable
                                            key={cat.id}
                                            onPress={() => setSelectedCategory(cat.id)}
                                            style={[
                                                styles.chip,
                                                isSelected && styles.chipSelected,
                                            ]}
                                            accessibilityRole="radio"
                                            accessibilityState={{ selected: isSelected }}
                                            accessibilityLabel={cat.label}
                                        >
                                            <Text style={styles.chipIcon} allowFontScaling={false}>
                                                {cat.icon}
                                            </Text>
                                            <Text
                                                style={[
                                                    styles.chipText,
                                                    isSelected && styles.chipTextSelected,
                                                ]}
                                                numberOfLines={1}
                                            >
                                                {cat.label}
                                            </Text>
                                        </Pressable>
                                    );
                                })}
                            </View>
                        </View>
                    ) : null}

                    {/* Review List & Facade Preview Card */}
                    {previewData ? (
                        <View style={styles.section}>
                            <Text style={styles.label}>Review & Confirm</Text>
                            <PulsePreviewCard
                                preview={{
                                    ...previewData,
                                    category: selectedCategory || previewData.category,
                                }}
                                callsign={identity?.callsign}
                                isOptedIn={isOptedIn}
                                onToggleOptIn={setIsOptedIn}
                                showReviewToggle={true}
                            />
                        </View>
                    ) : null}

                    {/* Inline Submit Error */}
                    {submitError ? (
                        <View style={styles.inlineErrorRow} accessibilityRole="alert">
                            <Text style={styles.inlineErrorIcon} allowFontScaling={false}>⚠️</Text>
                            <Text style={styles.inlineErrorText}>{submitError}</Text>
                        </View>
                    ) : null}

                    {/* Submit Success Confirmation */}
                    {submitSuccess ? (
                        <View style={styles.successBanner} accessibilityRole="alert">
                            <Text style={styles.successIcon} allowFontScaling={false}>✓</Text>
                            <Text style={styles.successText}>
                                Post shared to The Pulse! Returning to channels...
                            </Text>
                        </View>
                    ) : null}

                    {/* Submit Action Button */}
                    <View style={styles.actionContainer}>
                        <Pressable
                            onPress={handleSubmit}
                            disabled={submitting || submitSuccess || !urlInput.trim() || channels.length === 0}
                            style={({ pressed }) => [
                                styles.submitButton,
                                (submitting || submitSuccess || !urlInput.trim() || channels.length === 0) && styles.submitButtonDisabled,
                                pressed && styles.submitButtonPressed,
                            ]}
                            accessibilityRole="button"
                            accessibilityLabel="Share to Pulse"
                        >
                            {submitting ? (
                                <ActivityIndicator size="small" color={colors.text.inverse} />
                            ) : (
                                <Text style={styles.submitButtonText}>
                                    {previewData?.isDuplicate ? 'Update on Pulse' : 'Share to Pulse'}
                                </Text>
                            )}
                        </Pressable>
                    </View>
                </ScrollView>
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}

export const makeStyles = ({ colors, theme }: { colors: typeof lightColors; theme: string }) =>
    StyleSheet.create({
        safeArea: {
            flex: 1,
            backgroundColor: colors.surface.app,
        },
        keyboardAvoid: {
            flex: 1,
        },
        header: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
            paddingVertical: 12,
            borderBottomWidth: 1,
            borderBottomColor: colors.border.default,
            backgroundColor: colors.surface.card,
        },
        backButton: {
            flexDirection: 'row',
            alignItems: 'center',
            minHeight: 38,
        },
        backIcon: {
            fontSize: 18,
            color: colors.brand.primary,
            marginRight: 4,
            fontWeight: 'bold',
        },
        backText: {
            fontSize: 15,
            fontWeight: '600',
            color: colors.brand.primary,
        },
        headerTitle: {
            fontSize: 17,
            fontWeight: '700',
            color: colors.text.heading,
        },
        headerSpacer: {
            width: 50,
        },
        scrollContent: {
            padding: 16,
            paddingBottom: 40,
        },
        introText: {
            fontSize: 14,
            lineHeight: 20,
            color: colors.text.muted,
            marginBottom: 16,
        },
        section: {
            marginBottom: 20,
            width: '100%',
        },
        sectionHeaderRow: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 6,
        },
        label: {
            fontSize: 14,
            fontWeight: '600',
            color: colors.text.heading,
            marginBottom: 6,
        },
        pasteButton: {
            paddingHorizontal: 10,
            paddingVertical: 4,
            borderRadius: 8,
            backgroundColor: colors.surface.subtle,
            borderWidth: 1,
            borderColor: colors.border.default,
        },
        pasteText: {
            fontSize: 12,
            fontWeight: '600',
            color: colors.brand.primary,
        },
        input: {
            backgroundColor: colors.surface.card,
            borderWidth: 1,
            borderColor: colors.border.default,
            borderRadius: 12,
            paddingHorizontal: 14,
            paddingVertical: 12,
            fontSize: 15,
            color: colors.text.heading,
            minHeight: 48,
        },
        inputError: {
            borderColor: colors.feedback.danger.solid,
        },
        inlineErrorRow: {
            flexDirection: 'row',
            alignItems: 'center',
            marginTop: 6,
            marginBottom: 8,
            gap: 6,
        },
        inlineErrorIcon: {
            fontSize: 14,
        },
        inlineErrorText: {
            fontSize: 13,
            color: colors.feedback.danger.fg,
            flex: 1,
            lineHeight: 18,
        },
        resolvingRow: {
            flexDirection: 'row',
            alignItems: 'center',
            marginTop: 8,
            gap: 8,
        },
        resolvingText: {
            fontSize: 13,
            color: colors.text.muted,
        },
        chipsRow: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 8,
            marginTop: 4,
        },
        chip: {
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: colors.surface.card,
            borderWidth: 1,
            borderColor: colors.border.default,
            borderRadius: 18,
            paddingVertical: 8,
            paddingHorizontal: 12,
            minHeight: 38,
        },
        chipSelected: {
            borderColor: colors.brand.primary,
            backgroundColor: theme === 'dark' ? colors.brand.tint : colors.surface.subtle,
        },
        chipIcon: {
            fontSize: 13,
            marginRight: 6,
        },
        chipText: {
            fontSize: 13,
            fontWeight: '500',
            color: colors.text.body,
        },
        chipTextSelected: {
            fontWeight: '700',
            color: theme === 'dark' ? colors.text.heading : colors.brand.primary,
        },
        noChannelsCard: {
            backgroundColor: colors.surface.card,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: colors.border.default,
            padding: 16,
            marginBottom: 20,
            alignItems: 'center',
        },
        noChannelsIcon: {
            fontSize: 28,
            marginBottom: 8,
        },
        noChannelsTitle: {
            fontSize: 16,
            fontWeight: '700',
            color: colors.text.heading,
            marginBottom: 6,
        },
        noChannelsBody: {
            fontSize: 13,
            color: colors.text.muted,
            textAlign: 'center',
            lineHeight: 18,
            marginBottom: 14,
        },
        addChannelButton: {
            backgroundColor: colors.brand.primary,
            paddingVertical: 10,
            paddingHorizontal: 20,
            borderRadius: 10,
        },
        addChannelButtonText: {
            color: colors.text.inverse,
            fontSize: 14,
            fontWeight: '600',
        },
        errorBanner: {
            backgroundColor: theme === 'dark' ? 'rgba(239, 68, 68, 0.2)' : colors.feedback.danger.bg,
            padding: 12,
            borderRadius: 10,
            marginBottom: 14,
        },
        errorBannerText: {
            color: colors.feedback.danger.fg,
            fontSize: 13,
        },
        successBanner: {
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: theme === 'dark' ? 'rgba(34, 197, 94, 0.2)' : '#dcfce7',
            padding: 12,
            borderRadius: 10,
            marginBottom: 14,
            gap: 8,
            borderWidth: 1,
            borderColor: theme === 'dark' ? 'rgba(34, 197, 94, 0.4)' : '#86efac',
        },
        successIcon: {
            fontSize: 16,
            color: '#16a34a',
            fontWeight: 'bold',
        },
        successText: {
            fontSize: 13,
            color: theme === 'dark' ? '#4ade80' : '#15803d',
            fontWeight: '600',
            flex: 1,
        },
        actionContainer: {
            marginTop: 10,
            width: '100%',
        },
        submitButton: {
            backgroundColor: colors.brand.primary,
            borderRadius: 14,
            paddingVertical: 14,
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 50,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.1,
            shadowRadius: 4,
            elevation: 3,
        },
        submitButtonDisabled: {
            opacity: 0.5,
        },
        submitButtonPressed: {
            opacity: 0.85,
            transform: [{ scale: 0.99 }],
        },
        submitButtonText: {
            fontSize: 16,
            fontWeight: '700',
            color: colors.text.inverse,
        },
    });
