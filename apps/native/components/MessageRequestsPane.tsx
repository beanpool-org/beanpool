import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Pressable, Alert, Animated } from 'react-native';
import { GUEST_CHAT_WORDS, requestReportNotSentWords, t, tn, type GuestChat } from '@beanpool/core';
import { decideMessageRequest, ignoreAllMessageRequests, getMessages, syncSingleConversation } from '../utils/db';
import { reportRequestAndBlock, ReportedNotBlockedError, requestLineIn } from '../utils/request-report';
import { reportedAlertBody } from '../utils/reportReasons';
import { chatActionErrorMessage, requestDecisionFailureWords, requestIsGone } from '../utils/chat-actions';
import { ReportMessageSheet } from './ReportMessageSheet';
import { MemberAvatar } from './MemberAvatar';
import { useTheme, useStyles } from '../app/ThemeContext';
import { palette } from '../constants/colors';
import type { OutsideChat } from '../utils/outside-chat-store';
import type { RequestsPlace } from '../utils/requests-elsewhere';
import type { RequestsInPlaceGroup } from '../utils/requests-in-place';
import { RequestsElsewhereCards } from './RequestsElsewhereCards';

const REQUEST_CARDS_SHOWN = 50;
const IGNORE_ALL_FROM = 6;

interface RequestCardProps {
    entry: any;
    myPubkey: string;
    onOpen: (entry: any) => void;
    onAccepted: (entry: any) => void;
    onChanged: () => void;
    /**
     * Another community this phone holds, by its saved address (slice S3): the card's request lives there, and its preview,
     * Accept, Decline and Report each go to that community's copy and server by name (db.ts chatCopyForRequest), never the
     * one in use. Left out: the community in use, as before.
     */
    community?: string;
}

function RequestCard({ entry, myPubkey, onOpen, onAccepted, onChanged, community }: RequestCardProps) {
    // Every request this card makes names its community in place (slice S3); for the community in use, none, as before.
    const there = community ? [community] as const : [] as const;
    const { theme, colors } = useTheme();
    const peer = entry.participants?.find((p: string) => p !== myPubkey) || entry.request?.from || '';
    const name = entry.peerCallsign || entry.name || peer.slice(0, 8);
    // In place, a photo's path is that community's: made whole there, never left for MemberAvatar to ask the community in
    // use, which would be handed the person's key and that community's face key (#3309 review F2; db.ts requestsInPlace
    // makes it whole first, and this holds for any other way a card in place is filled).
    const avatarUrl = community && typeof entry.peerAvatar === 'string' && entry.peerAvatar.startsWith('/')
        ? `${community.replace(/\/+$/, '')}${entry.peerAvatar}`
        : entry.peerAvatar;
    // `line` is the one Report hands over (null: none left), `canReport` that this phone can tell.
    const [preview, setPreview] = useState<{ text?: string; photo?: boolean; loading: boolean; line?: any; canReport?: boolean }>({ loading: true });
    const [busy, setBusy] = useState(false);
    const [reporting, setReporting] = useState(false);

    useEffect(() => {
        let alive = true;
        // Cancel request then a new line keeps the chat and moves `at`: the line read before is the withdrawn one, so Report
        // goes dim until this read is back, on a slow node too (the deciding review of #2705; the web keys its previews the same).
        setPreview({ loading: true });
        const loadPreview = async () => {
            try {
                // The node's word first, then the copy here: a line its opener withdrew (Cancel request) never shows from
                // this phone's copy, and their new one does (PR #2540 review 4393642158). With no answer, the copy here.
                const answered = await syncSingleConversation(entry.id, ...there).catch(() => false);
                const msgs = await getMessages(entry.id, community ? { limit: 20, community } : { limit: 20 });
                if (!alive) return;
                const last = msgs[msgs.length - 1];
                // The newest row may be no line of theirs (a tombstone, a failed line of mine). With none here, only the
                // node's word says none is left: this phone may just not have it yet, and Report would say it was deleted.
                const line = requestLineIn(msgs, myPubkey, entry.request?.at);
                const canReport = !!line || answered !== false;
                if (last) {
                    const hasPhoto = last.type === 'image' || !!last.metadata?.attachment;
                    setPreview({ text: last.text, photo: hasPhoto, loading: false, line, canReport });
                } else {
                    setPreview({ loading: false, canReport });
                }
            } catch {
                if (alive) setPreview({ loading: false });
            }
        };
        loadPreview();
        return () => { alive = false; };
    }, [entry.id, entry.request?.at, myPubkey, community]);

    const handleDecide = async (decision: 'accept' | 'ignore') => {
        if (busy) return;
        setBusy(true);
        try {
            await decideMessageRequest(entry.id, decision, ...there);
            if (decision === 'accept') {
                onAccepted(entry);
            } else {
                onChanged();
            }
        } catch (e: any) {
            // Gone from the node (its opener cancelled it): the list the card came from is old, so the next one drops it.
            if (requestIsGone(e)) { onChanged(); return; }
            Alert.alert(t('Message requests'), requestDecisionFailureWords(e));
        } finally {
            setBusy(false);
        }
    };

    // Report: the line's report and a block of its sender (utils/request-report.ts). The sheet stays under the dialog until OK.
    const submitReport = async (reason: string) => {
        try {
            const outcome = await reportRequestAndBlock(entry.id, preview.line ?? null, peer, reason, myPubkey, ...there);
            const notSent = outcome === 'reported' ? null : requestReportNotSentWords(outcome);
            // A report that did not go whole still blocked them (each such sentence ends "They are blocked."): that is the title,
            // and the sentence is the message, since Android cuts a title at two lines.
            Alert.alert(
                notSent ? t('User Blocked') : t('Reported'),
                notSent ?? reportedAlertBody(undefined, reason),
                [{ text: t('OK'), onPress: () => { setReporting(false); onChanged(); } }],
            );
        } catch (e: any) {
            const halfDone = e instanceof ReportedNotBlockedError;
            Alert.alert(
                halfDone ? t('Reported') : t('Not sent'),
                halfDone ? t('Reported, but not blocked. Please try again.') : chatActionErrorMessage({ status: e?.status ?? null, message: e?.message, nodeAnswered: !!e?.nodeAnswered }),
            );
            throw e; // the box keeps the choice and the words
        }
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
        },
        // Applied at render, not read from `preview` here: useStyles builds the sheet once per theme, while the preview
        // is still loading (PR #2540 review 4399651606).
        previewPhotoAboveText: {
            marginBottom: 4,
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
        reportBtn: {
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
        reportBtnText: {
            color: colors.feedback.danger.fg,
            fontWeight: '700',
            fontSize: 14,
        },
    }));

    return (
        <View style={styles.card} testID="request-card">
            <View style={styles.header}>
                <MemberAvatar avatarUrl={avatarUrl} pubkey={peer} callsign={name} size={44} />
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
                accessibilityLabel={preview.loading ? t('Loading…') : [
                    name,
                    preview.photo ? t('Photo: shown when you accept') : null,
                    preview.text,
                    t('Open the chat to read it.')
                ].filter(Boolean).join('. ')}
                testID="request-card-open"
                style={styles.previewBtn}
                onPress={() => onOpen(entry)}
            >
                {preview.loading ? (
                    <Text style={styles.previewPlaceholder}>{t('Loading…')}</Text>
                ) : (preview.text || preview.photo) ? (
                    <View>
                        {preview.photo && (
                            <Text style={[styles.previewPhoto, preview.text ? styles.previewPhotoAboveText : null]}>
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
                    accessibilityLabel={t('Decline', undefined, 'button: decline a message request')}
                    testID="request-decline"
                    style={[styles.ignoreBtn, busy && { opacity: 0.7 }]}
                    disabled={busy}
                    onPress={() => handleDecide('ignore')}
                >
                    <Text style={styles.ignoreBtnText}>{t('Decline', undefined, 'button: decline a message request')}</Text>
                </Pressable>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('Report', undefined, 'button: report a message request')}
                    testID="request-report"
                    style={[styles.reportBtn, (busy || !preview.canReport) && { opacity: 0.7 }]}
                    disabled={busy || !preview.canReport}
                    onPress={() => setReporting(true)}
                >
                    <Text style={styles.reportBtnText}>{t('Report', undefined, 'button: report a message request')}</Text>
                </Pressable>
            </View>
            {reporting && <ReportMessageSheet isOpen photo={false} blocks onSubmit={submitReport} onClose={() => setReporting(false)} />}
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
    /** Back to the chats: the row at the top of Chat opened this. */
    onBack: () => void;
    /**
     * The phone's other communities where requests wait, global among them (utils/requests-elsewhere.ts; Marty, 19 Nov 2026,
     * S0): a card "In {community}" each. Their requests are read there: a tap moves the phone there and opens them.
     */
    elsewhere?: readonly RequestsPlace[];
    onOpenElsewhere?: (place: RequestsPlace) => void;
    /** A move under way: the cards wait. */
    elsewhereBusy?: boolean;
    /** A tap that moved nothing says so under the cards (app/(tabs)/chats.tsx `switchNote`). */
    elsewhereNote?: string | null;
    /** Requests from people in other communities, kept on this phone (utils/outside-chat-store.ts): each opens its chat. */
    outside?: OutsideChat[];
    onOpenOutside?: (chat: OutsideChat) => void;
    /** Invitations to a group's chat in another community, kept on this phone (G2): each opens it, to accept or decline. */
    guestInvites?: GuestChat[];
    onOpenGuest?: (chat: GuestChat) => void;
    /**
     * Requests of the phone's other communities, read there in place (slice S3, utils/db.ts requestsInPlace): under "In
     * {community}", each card answered in that community by name, with no switch. A community not read in place keeps its
     * S0 card in `elsewhere`.
     */
    inPlace?: ReadonlyArray<RequestsInPlaceGroup>;
    onOpenInPlace?: (entry: any, place: RequestsPlace) => void;
    onAcceptedInPlace?: (entry: any, place: RequestsPlace) => void;
}

export function MessageRequestsPane({ entries, count, identity, qr, onOpen, onAccepted, onChanged, onBack, elsewhere = [], onOpenElsewhere, elsewhereBusy = false, elsewhereNote, outside = [], onOpenOutside, guestInvites = [], onOpenGuest, inPlace = [], onOpenInPlace, onAcceptedInPlace }: MessageRequestsPaneProps) {
    const { theme, colors } = useTheme();
    const [ignoringAll, setIgnoringAll] = useState(false);
    const shown = entries.slice(0, REQUEST_CARDS_SHOWN);
    const more = count - shown.length;

    const handleIgnoreAll = () => {
        if (ignoringAll) return;
        Alert.alert(
            t('Message requests'),
            tn(count, "Decline {n} request? They won't be told.", "Decline all {n} requests? They won't be told."),
            [
                { text: t('Cancel'), style: 'cancel' },
                {
                    text: t('Decline all'),
                    style: 'destructive',
                    onPress: async () => {
                        setIgnoringAll(true);
                        try {
                            await ignoreAllMessageRequests();
                            onChanged();
                        } catch {
                            Alert.alert(t('Message requests'), t('That did not go through. Please try again.'));
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
        backRow: {
            minHeight: 44,
            flexDirection: 'row',
            alignItems: 'center',
            marginBottom: 4,
        },
        backText: {
            fontSize: 14,
            fontWeight: '700',
            color: colors.text.body,
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
            role="region"
            accessibilityLabel={t('Message requests')}
            testID="message-requests"
        >
            <Pressable accessibilityRole="button" accessibilityLabel={t('Back to chats')} testID="message-requests-back" style={styles.backRow} onPress={onBack}>
                <Text aria-hidden={true} importantForAccessibility="no" style={styles.backText}>‹ </Text>
                <Text style={styles.backText}>{t('Back to chats')}</Text>
            </Pressable>
            {inPlace.filter((g) => g.entries.length > 0).map(({ place, entries: there, count: waiting }) => {
                const shownThere = there.slice(0, REQUEST_CARDS_SHOWN);
                // The rest waiting there, as this community's own cards say it (#3309 review F3).
                const moreThere = waiting - shownThere.length;
                return (
                    <View key={place.address} testID={`message-requests-in-place-${place.address}`}>
                        <Text style={styles.title}>{t('In {community}', { community: place.name })}</Text>
                        {shownThere.map((entry: any) => (
                            <RequestCard
                                key={`${place.address}\n${entry.id}`}
                                entry={entry}
                                myPubkey={identity?.publicKey || ''}
                                community={place.url}
                                onOpen={(e) => onOpenInPlace?.(e, place)}
                                onAccepted={(e) => onAcceptedInPlace?.(e, place)}
                                onChanged={onChanged}
                            />
                        ))}
                        {moreThere > 0 && (
                            <Text style={styles.moreText}>{tn(moreThere, 'and {n} more', 'and {n} more')}</Text>
                        )}
                    </View>
                );
            })}
            <RequestsElsewhereCards places={elsewhere} busy={elsewhereBusy} note={elsewhereNote} onOpen={(place) => onOpenElsewhere?.(place)} />
            {outside.map((c) => (
                <Pressable key={c.id} accessibilityRole="button" testID="outside-request-card" style={styles.emptyCard} onPress={() => onOpenOutside?.(c)}>
                    <Text style={styles.title}>{t('{name} · {community}', { name: c.peerName ?? t('Someone in another community'), community: c.peerHome })}</Text>
                    <Text style={styles.emptyText}>{t('{name} wants to message you', { name: c.peerName ?? c.peerHome })}</Text>
                    {!!c.lastText && <Text style={styles.emptyText} numberOfLines={4}>{c.lastText}</Text>}
                    <Text style={styles.backText}>{t('Open to accept or decline')}</Text>
                </Pressable>
            ))}
            {guestInvites.map((c) => (
                <Pressable key={c.id} accessibilityRole="button" testID="guest-invitation-card" style={styles.emptyCard} onPress={() => onOpenGuest?.(c)}>
                    <Text style={styles.title}>{t(GUEST_CHAT_WORDS.invitedCard, { group: c.name, community: c.host })}</Text>
                    <Text style={styles.emptyText}>{t(GUEST_CHAT_WORDS.invitedYou, { name: c.invitedBy?.name || t('Someone'), group: c.name, community: c.host })}</Text>
                    <Text style={styles.backText}>{t('Open to accept or decline')}</Text>
                </Pressable>
            ))}
            {count === 0 && (elsewhere.length > 0 || outside.length > 0 || guestInvites.length > 0 || inPlace.some((g) => g.entries.length > 0)) ? null : count === 0 ? (
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
                            accessibilityLabel={t('Decline all')}
                            style={[styles.ignoreAllBtn, ignoringAll && { opacity: 0.7 }]}
                            disabled={ignoringAll}
                            onPress={handleIgnoreAll}
                        >
                            <Text style={styles.ignoreAllBtnText}>{t('Decline all')}</Text>
                        </Pressable>
                    )}
                </>
            )}
        </Animated.ScrollView>
    );
}
