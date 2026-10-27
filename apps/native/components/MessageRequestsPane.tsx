import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Pressable, Alert, Animated } from 'react-native';
import { t, tn } from '@beanpool/core';
import { decideMessageRequest, ignoreAllMessageRequests, getMessages, syncSingleConversation } from '../utils/db';
import { blockUser } from '../utils/blocklist';
import { MemberAvatar } from './MemberAvatar';
import { useTheme, useStyles } from '../app/ThemeContext';
import { palette } from '../constants/colors';

const REQUEST_CARDS_SHOWN = 50;
const IGNORE_ALL_FROM = 6;

interface RequestCardProps {
    entry: any;
    myPubkey: string;
    onOpen: (entry: any) => void;
    onAccepted: (entry: any) => void;
    onChanged: () => void;
}

function RequestCard({ entry, myPubkey, onOpen, onAccepted, onChanged }: RequestCardProps) {
    const { theme, colors } = useTheme();
    const peer = entry.participants?.find((p: string) => p !== myPubkey) || entry.request?.from || '';
    const name = entry.peerCallsign || entry.name || peer.slice(0, 8);
    const [preview, setPreview] = useState<{ text?: string; photo?: boolean; loading: boolean }>({ loading: true });
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let alive = true;
        const loadPreview = async () => {
            try {
                let msgs = await getMessages(entry.id, { limit: 20 });
                if (msgs.length === 0) {
                    await syncSingleConversation(entry.id).catch(() => {});
                    msgs = await getMessages(entry.id, { limit: 20 });
                }
                if (!alive) return;
                const last = msgs[msgs.length - 1];
                if (last) {
                    const hasPhoto = last.type === 'image' || !!(last.attachment_mime || last.attachment_filename || last.metadata?.attachment);
                    setPreview({ text: last.text, photo: hasPhoto, loading: false });
                } else {
                    setPreview({ loading: false });
                }
            } catch {
                if (alive) setPreview({ loading: false });
            }
        };
        loadPreview();
        return () => { alive = false; };
    }, [entry.id]);

    const handleDecide = async (decision: 'accept' | 'ignore') => {
        if (busy) return;
        setBusy(true);
        try {
            await decideMessageRequest(entry.id, decision);
            if (decision === 'accept') {
                onAccepted(entry);
            } else {
                onChanged();
            }
        } catch (e: any) {
            Alert.alert(t('That did not go through. Please try again.'));
        } finally {
            setBusy(false);
        }
    };

    const handleBlock = () => {
        if (busy) return;
        Alert.alert(
            t('Block {name}?', { name }),
            t('This will hide their messages and posts, and notify moderation.'),
            [
                { text: t('Cancel'), style: 'cancel' },
                {
                    text: t('Block', undefined, 'button: block a member'),
                    style: 'destructive',
                    onPress: async () => {
                        setBusy(true);
                        try {
                            await blockUser(peer, myPubkey, 'Blocked from a message request');
                            onChanged();
                        } catch {
                            Alert.alert(t('That did not go through. Please try again.'));
                        } finally {
                            setBusy(false);
                        }
                    },
                },
            ]
        );
    };

    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        card: {
            backgroundColor: colors.surface.card,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: colors.border.default,
            padding: 14,
            marginBottom: 12,
        },
        header: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
        },
        headerInfo: {
            flex: 1,
        },
        peerName: {
            fontSize: 16,
            fontWeight: '700',
            color: colors.text.body,
        },
        subtitle: {
            fontSize: 13,
            color: colors.text.secondary,
            marginTop: 2,
        },
        addedYouBadge: {
            alignSelf: 'flex-start',
            backgroundColor: theme === 'dark' ? colors.feedback.success.bg : palette.emerald100,
            borderRadius: 6,
            paddingHorizontal: 6,
            paddingVertical: 2,
            marginTop: 4,
        },
        addedYouText: {
            fontSize: 11,
            fontWeight: '700',
            color: theme === 'dark' ? colors.feedback.success.fg : palette.emerald800,
        },
        previewBtn: {
            backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.gray50,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: colors.border.default,
            padding: 12,
            marginVertical: 10,
            minHeight: 44,
            justifyContent: 'center',
        },
        previewText: {
            fontSize: 14,
            color: colors.text.body,
            lineHeight: 19,
        },
        previewPhoto: {
            fontSize: 13,
            fontStyle: 'italic',
            color: colors.text.secondary,
            marginBottom: preview.text ? 4 : 0,
        },
        previewPlaceholder: {
            fontSize: 13,
            color: colors.text.muted,
        },
        actionsRow: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 8,
            marginTop: 4,
        },
        acceptBtn: {
            flex: 1,
            minWidth: 90,
            minHeight: 44,
            backgroundColor: colors.brand.fill,
            borderRadius: 10,
            justifyContent: 'center',
            alignItems: 'center',
            paddingHorizontal: 12,
        },
        acceptBtnText: {
            color: colors.text.inverse,
            fontWeight: '800',
            fontSize: 14,
        },
        ignoreBtn: {
            flex: 1,
            minWidth: 80,
            minHeight: 44,
            backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.gray100,
            borderWidth: 1,
            borderColor: colors.border.default,
            borderRadius: 10,
            justifyContent: 'center',
            alignItems: 'center',
            paddingHorizontal: 12,
        },
        ignoreBtnText: {
            color: colors.text.body,
            fontWeight: '700',
            fontSize: 14,
        },
        blockBtn: {
            minWidth: 70,
            minHeight: 44,
            backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.red50,
            borderWidth: 1,
            borderColor: theme === 'dark' ? colors.border.default : palette.red200,
            borderRadius: 10,
            justifyContent: 'center',
            alignItems: 'center',
            paddingHorizontal: 12,
        },
        blockBtnText: {
            color: colors.feedback.danger.fg,
            fontWeight: '700',
            fontSize: 14,
        },
    }));

    return (
        <View style={styles.card} testID="request-card">
            <View style={styles.header}>
                <MemberAvatar avatarUrl={entry.peerAvatar} pubkey={peer} callsign={name} size={44} />
                <View style={styles.headerInfo}>
                    <Text style={styles.peerName} numberOfLines={1}>{name}</Text>
                    <Text style={styles.subtitle}>{t('{name} wants to message you', { name })}</Text>
                    {entry.addedYou && (
                        <View style={styles.addedYouBadge}>
                            <Text style={styles.addedYouText}>{t('{name} added you', { name })}</Text>
                        </View>
                    )}
                </View>
            </View>

            <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('Open the chat to read it.')}
                testID="request-card-open"
                style={styles.previewBtn}
                onPress={() => onOpen(entry)}
            >
                {preview.loading ? (
                    <Text style={styles.previewPlaceholder}>{t('Loading…')}</Text>
                ) : (preview.text || preview.photo) ? (
                    <View>
                        {preview.photo && (
                            <Text style={styles.previewPhoto}>
                                <Text aria-hidden={true} importantForAccessibility="no">🖼️ </Text>
                                {t('Photo: shown when you accept')}
                            </Text>
                        )}
                        {preview.text && (
                            <Text style={styles.previewText} numberOfLines={4}>{preview.text}</Text>
                        )}
                    </View>
                ) : (
                    <Text style={styles.previewPlaceholder}>{t('Open the chat to read it.')}</Text>
                )}
            </Pressable>

            <View style={styles.actionsRow}>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('Accept', undefined, 'button: accept a message request')}
                    testID="request-accept"
                    style={[styles.acceptBtn, busy && { opacity: 0.7 }]}
                    disabled={busy}
                    onPress={() => handleDecide('accept')}
                >
                    <Text style={styles.acceptBtnText}>{t('Accept', undefined, 'button: accept a message request')}</Text>
                </Pressable>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('Ignore', undefined, 'button: ignore a message request')}
                    testID="request-ignore"
                    style={[styles.ignoreBtn, busy && { opacity: 0.7 }]}
                    disabled={busy}
                    onPress={() => handleDecide('ignore')}
                >
                    <Text style={styles.ignoreBtnText}>{t('Ignore', undefined, 'button: ignore a message request')}</Text>
                </Pressable>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('Block', undefined, 'button: block a member')}
                    testID="request-block"
                    style={[styles.blockBtn, busy && { opacity: 0.7 }]}
                    disabled={busy}
                    onPress={handleBlock}
                >
                    <Text style={styles.blockBtnText}>{t('Block', undefined, 'button: block a member')}</Text>
                </Pressable>
            </View>
        </View>
    );
}

interface MessageRequestsPaneProps {
    entries: any[];
    count: number;
    identity: any;
    qr?: any;
    onOpen: (entry: any) => void;
    onAccepted: (entry: any) => void;
    onChanged: () => void;
}

export function MessageRequestsPane({ entries, count, identity, qr, onOpen, onAccepted, onChanged }: MessageRequestsPaneProps) {
    const { theme, colors } = useTheme();
    const [ignoringAll, setIgnoringAll] = useState(false);
    const shown = entries.slice(0, REQUEST_CARDS_SHOWN);
    const more = count - shown.length;

    const handleIgnoreAll = () => {
        if (ignoringAll) return;
        Alert.alert(
            tn(count, "Ignore {n} request? They won't be told.", "Ignore all {n} requests? They won't be told."),
            '',
            [
                { text: t('Cancel'), style: 'cancel' },
                {
                    text: t('Ignore all'),
                    style: 'destructive',
                    onPress: async () => {
                        setIgnoringAll(true);
                        try {
                            await ignoreAllMessageRequests();
                            onChanged();
                        } catch {
                            Alert.alert(t('That did not go through. Please try again.'));
                        } finally {
                            setIgnoringAll(false);
                        }
                    },
                },
            ]
        );
    };

    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: {
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: 100,
        },
        emptyCard: {
            padding: 24,
            borderRadius: 16,
            backgroundColor: colors.surface.card,
            borderWidth: 1,
            borderColor: colors.border.default,
            alignItems: 'center',
            justifyContent: 'center',
            marginTop: 16,
        },
        emptyText: {
            fontSize: 14,
            lineHeight: 20,
            color: colors.text.secondary,
            textAlign: 'center',
        },
        title: {
            fontSize: 15,
            fontWeight: '700',
            color: colors.text.body,
            marginBottom: 12,
        },
        moreText: {
            fontSize: 13,
            color: colors.text.muted,
            marginBottom: 12,
            textAlign: 'center',
        },
        ignoreAllBtn: {
            minHeight: 44,
            backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.gray100,
            borderWidth: 1,
            borderColor: colors.border.default,
            borderRadius: 10,
            justifyContent: 'center',
            alignItems: 'center',
            paddingHorizontal: 16,
            marginTop: 8,
            width: '100%',
        },
        ignoreAllBtnText: {
            color: colors.text.body,
            fontWeight: '700',
            fontSize: 14,
        },
    }));

    return (
        <Animated.ScrollView
            {...(qr ? qr.listProps : {})}
            contentContainerStyle={[styles.container, qr ? { paddingTop: styles.container.paddingTop + qr.listInset } : {}]}
            showsVerticalScrollIndicator={false}
            accessibilityRole="region"
            accessibilityLabel={t('Requests')}
            testID="message-requests"
        >
            {count === 0 ? (
                <View style={styles.emptyCard}>
                    <Text style={styles.emptyText}>
                        {t("No requests. A first message from someone you haven't added or talked to arrives here.")}
                    </Text>
                </View>
            ) : (
                <>
                    <Text style={styles.title}>
                        {tn(count, '{n} person wants to message you', '{n} people want to message you')}
                    </Text>
                    {shown.map((entry: any) => (
                        <RequestCard
                            key={entry.id}
                            entry={entry}
                            myPubkey={identity?.publicKey || ''}
                            onOpen={onOpen}
                            onAccepted={onAccepted}
                            onChanged={onChanged}
                        />
                    ))}
                    {more > 0 && (
                        <Text style={styles.moreText}>{tn(more, 'and {n} more', 'and {n} more')}</Text>
                    )}
                    {count >= IGNORE_ALL_FROM && (
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={t('Ignore all')}
                            style={[styles.ignoreAllBtn, ignoringAll && { opacity: 0.7 }]}
                            disabled={ignoringAll}
                            onPress={handleIgnoreAll}
                        >
                            <Text style={styles.ignoreAllBtnText}>{t('Ignore all')}</Text>
                        </Pressable>
                    )}
                </>
            )}
        </Animated.ScrollView>
    );
}
