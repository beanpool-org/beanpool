/**
 * EventDetail — `/post/:id` for an event (docs/events-on-the-map.md §3 "Event detail", slice 3).
 *
 * The page is drawn from the Market card's style box (DESIGN-detail-pages-fable.md §2, slice DP1; components/market-card-shell.ts),
 * in one order: the card's chips, the loud lines (the when in the event's ink, the title, the place with "Show on map"),
 * Going / Interested, the photo at 4:3 (the event's tile without one), the quiet row (the chat, Share, Add to calendar), the
 * reminder and the note for people who are going as boxes, the description, the host's box, the host's guest list, Report.
 * The answer comes right after the loud lines, before the picture and the reading (DESIGN-detail-pages-frame-fable.md §1.4);
 * a repeating event's rule is the door to its next dates, one 48 dp line under the when ("↻ Monthly, third Saturday · Next
 * dates", DESIGN-web-dates-stop-fable.md §4, as the web's page has it). That the answer is on the first screen is measured
 * (event-page-shell-render.test.ts: at 320 × 569 and 1.3×, its top ≤ 500 dp and its bottom ≤ 569, with a photo, without,
 * and with the dates opened). The counts show only once someone has answered.
 *
 * What the viewer may see is the node's decision, not this screen's: the local row gives a first paint, then
 * a signed by-id fetch returns my RSVP, the note (host and Going only) and the RSVP list (hosts only). The note
 * lives in component state and is never written to the phone's cache.
 *
 * The event chat (slice 4) is one tap from here, for the host and anyone Going. A host can also edit the event
 * (round 2: NewEventModal in edit mode, every field filled), cancel it, or copy it to a new date (slice 5) —
 * that opens NewEventModal filled from this event with the dates blank. A host has no Going / Interested:
 * they are running it. After cancelling, the host stays here and sees it CANCELLED. "Show on map" opens the
 * phone's maps app, because the in-app map layer for events is the protected-files slice 7.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator, Linking, Platform, DeviceEventEmitter } from 'react-native';
import { Alert } from '../utils/keyboard-alert';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useTheme, useStyles, type ThemeContextType } from '../app/ThemeContext';
import { useIdentity } from '../app/IdentityContext';
import { copyFromLine, eventCopyOf, t, tn, placeShownRoughly, PLACE_WORDS, seriesMovedFromLine, upperCase, MARKET_CARD_SHELL as SHELL } from '@beanpool/core';
import { fetchEventDetail, rsvpEvent, deletePost, reportAbuse, letInToEvent, unpinPostOnNode } from '../utils/db';
import { isPostPinned, pinnedDetailLine, showPinMenu, pinFailureText } from '../utils/pins';
import { usePinRole } from '../utils/use-pin-role';
import { PinSheet } from './PinSheet';
import { hapticTick } from '../utils/haptics';
import { PhotoCarousel } from './PhotoCarousel';
import { PostTagChips } from './PostTagChips';
import { CategoryTile } from './CategoryTile';
import { CardChip, useCardShell } from './market-card-shell';
import { NewEventModal } from './NewEventModal';
import { EventReminder, EventShareAndCalendar } from './EventExtras';
import { EventNextDates } from './EventNextDates';
import { EventCopyDoor } from './EventCopyDoor';
import { AuthorCard, useMemberRating } from './AuthorCard';
import { ShowOnGlobalHostRow } from './ShowOnGlobalRow';
import { ReportReasonBox } from './ReportReasonBox';
import { eventLineWords } from './event-lines';
import { reportedAlertBody } from '../utils/reportReasons';
import { isHiddenAuthor } from '../utils/posts-view';
import {
    formatEventWhenFor, eventWhen, eventRepeatCaption, withMovedFromLine, eventHostLine, eventPlaceLine, eventLinkWaitWords, isOnlineEvent, eventBadge, eventStateOf, isEventEnded, nextRsvp, applyRsvp, formatRsvpCounts,
    canOpenEventChat, eventChatEntryLabel, buildEventCopy, isEventHostView, isOwnEvent, eventEditBlockedReason, eventEditValues,
    eventLetInState, eventLetInLine, eventWaitingCount, eventWaitingLine, letEveryoneInQuestion, eventChatWaitingText, letInButtonLabel,
    type EventRsvpStatus, type RsvpCounts, type EventCopy, type EventEditValues,
} from '../utils/events';


interface EventDetailProps {
    post: any;
    /** The node says `openMembership` (anyone can join in a minute): the spot is the host's to give (ROUGH_PLACE_LINE). */
    openMembership?: boolean;
    /** A local community, whose host may show the event on the global community (components/ShowOnGlobalRow.tsx). */
    onLocalCommunity?: boolean;
    /** The node's profile says pins are on (`features.pins`): the screen that opens this has it, so this asks nothing of the profile. */
    pinsOn?: boolean;
}

function countsOf(p: any): RsvpCounts {
    return {
        going: Number(p.goingCount ?? p.event_going_count ?? 0) || 0,
        interested: Number(p.interestedCount ?? p.event_interested_count ?? 0) || 0,
        mine: (p.myRsvp ?? null) as EventRsvpStatus | null,
    };
}

export function EventDetail({ post, openMembership = false, onLocalCommunity = false, pinsOn = false }: EventDetailProps) {
    const insets = useSafeAreaInsets();
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    // The style box (components/market-card-shell.ts): the card's chips, the page's boxes and buttons.
    const shell = useCardShell();
    const { identity } = useIdentity();
    // The photo frame's height, once laid out: 4:3 of the column's width (the carousel needs a number).
    const [photoHeight, setPhotoHeight] = useState(0);

    // The node's reader view for this member; null until it arrives (or when offline).
    const [view, setView] = useState<any | null>(null);
    const [counts, setCounts] = useState<RsvpCounts>(() => countsOf(post));
    const [pending, setPending] = useState<EventRsvpStatus | null>(null);
    const [showRsvps, setShowRsvps] = useState(false);
    // The member (or 'everyone') a let-in is being saved for.
    const [letting, setLetting] = useState<string | null>(null);
    const [cancelling, setCancelling] = useState(false);
    // Non-null while the copy form is open; holding the draft rather than a boolean means NewEventModal
    // applies it once, on the opening it was built for.
    const [copyDraft, setCopyDraft] = useState<EventCopy | null>(null);
    // Non-null while the edit form is open; one object per opening, which NewEventModal applies once.
    const [editOf, setEditOf] = useState<{ id: string; values: EventEditValues; audienceLabel: string } | null>(null);
    const [showPinSheet, setShowPinSheet] = useState(false);
    const [unpinning, setUnpinning] = useState(false);
    // The "···" is for an owner or admin (Pin, Take the pin off) and for a pinned event's host (Take the pin off).
    const pinRole = usePinRole(pinsOn, identity?.publicKey);

    const handleEventOptions = () => {
        const pinned = isPostPinned(p);
        if (pinned) {
            Alert.alert(t('Event options'), undefined, [
                {
                    text: t('Take the pin off'),
                    style: 'destructive',
                    onPress: async () => {
                        if (unpinning) return;
                        setUnpinning(true);
                        try {
                            await unpinPostOnNode(p.id);
                            await load();
                        } catch (e: any) {
                            Alert.alert(t('Error'), pinFailureText(e, t('Failed to unpin post')));
                        } finally {
                            setUnpinning(false);
                        }
                    },
                },
                { text: t('Cancel'), style: 'cancel' },
            ]);
        } else {
            Alert.alert(t('Event options'), undefined, [
                {
                    text: t('Pin to the top…'),
                    onPress: () => setShowPinSheet(true),
                },
                { text: t('Cancel'), style: 'cancel' },
            ]);
        }
    };

    const load = useCallback(async () => {
        try {
            const v = await fetchEventDetail(post.id);
            if (v) {
                setView(v);
                setCounts(countsOf(v));
            }
            return v;
        } catch {
            // Offline: the cached row still shows the event; RSVP will say it cannot reach the node.
            return null;
        }
    }, [post.id]);

    useEffect(() => { load(); }, [load]);

    const p = view ? { ...post, ...view } : post;
    // The place's clock, then the reader's own when it differs; online, the reader's, and the host's clock once (§4).
    const when = formatEventWhenFor(p);
    const whenParts = eventWhen(p);
    // Not for a zone that names no place: an online event saved without one is kept as UTC (#1946 review, finding 4).
    const hostLine = eventHostLine(p);
    const online = isOnlineEvent(p);
    // Served like the private note: to the host and to Going only (DESIGN-event-times §9).
    const joinLink: string | undefined = view?.eventLink;
    const badge = eventBadge(p);
    const cancelled = eventStateOf(p) === 'cancelled';
    const ended = isEventEnded(p);
    const closed = cancelled || ended;
    const placeName = p.eventPlaceName ?? p.event_place_name ?? '';
    const note: string | undefined = view?.eventPrivateNote;
    const rsvps: any[] | undefined = view?.eventRsvps; // present only when the node says this viewer is a host
    // The node's word first: it sends the RSVP list to hosts only. With no node view (offline, or a node that
    // does not serve a cancelled event by id yet), the author is still the host — never offer them Report.
    const hostView = isEventHostView(view);
    const isHost = hostView || (!view && isOwnEvent(p, identity?.publicKey));
    const editBlocked = eventEditBlockedReason(p);
    // A member's copy, on the global community (@beanpool/core eventCopyOf): no author, no Going, no chat. The door instead.
    const copy = eventCopyOf(p);
    // Where the host lets people in (DESIGN-global-member-privacy-fable.md §2.3): before Going, waiting, or let in.
    const letInState = eventLetInState({ ...p, myRsvp: counts.mine }, isHost);
    const letInLine = eventLetInLine(letInState);
    const hostLetsIn = !!p.eventHostLetsIn;
    const waiting = hostLetsIn ? eventWaitingCount(rsvps) : 0;

    const saveLetIn = async (key: string, who: { memberPublicKey: string } | { everyone: true }, on: boolean) => {
        if (letting) return;
        setLetting(key);
        try {
            const res = await letInToEvent(post.id, who, on);
            if (res?.post) setView(res.post);
        } catch (err: any) {
            Alert.alert(t('Not saved'), err?.message ? eventLineWords(err.message) : t('Could not reach the node. Try again when you have signal.'));
        } finally {
            setLetting(null);
        }
    };
    const letEveryoneIn = () => Alert.alert(t('Let everyone in'), letEveryoneInQuestion(waiting), [
        { text: t('Not now'), style: 'cancel' },
        { text: t('Let them in'), onPress: () => { saveLetIn('everyone', { everyone: true }, true); } },
    ]);
    const hostName = p.authorCallsign || p.author_callsign || (p.author_pubkey || p.authorPublicKey || '').slice(0, 6) || t('Unknown', undefined, 'a host with no name');
    // The host's box (components/AuthorCard.tsx, the box a listing's "POSTED BY" is): their key, face and ratings. A member's copy of an event has no
    // host to show, and a visitors' view that hides who posted gives a box that opens nothing.
    const hostKey: string | undefined = p.authorPublicKey ?? p.author_pubkey;
    const hostRating = useMemberRating(copy || !hostKey ? null : hostKey);
    const canOpenHost = !!hostKey && !isHiddenAuthor(hostKey);
    const groupName = p.targetGroupName || p.target_group_name;
    const isGroupOnly = (p.audienceScope || p.audience_scope) === 'group';
    // Photos from the cached row, whose paths getPost has already resolved against the node.
    let photos: string[] = [];
    if (Array.isArray(post.photos)) photos = post.photos;
    else if (typeof post.photos === 'string') { try { photos = JSON.parse(post.photos); } catch { photos = []; } }
    // What the carousel would draw (it skips an empty or a "null" path): with none, the frame is the event's tile instead.
    const shownPhotos = photos.filter((u) => typeof u === 'string' && u.trim() !== '' && u !== 'null' && u !== 'undefined');

    const handleRsvp = async (tapped: EventRsvpStatus) => {
        const next = nextRsvp(counts.mine, tapped);
        if (pending || (closed && next !== null)) return;
        if (!identity?.publicKey) {
            Alert.alert(t('Sign in to RSVP'), t('Set up your member identity to tell the host you are coming.'));
            return;
        }
        const before = counts;
        hapticTick();
        setCounts(applyRsvp(counts, next));
        setPending(tapped);
        try {
            const res = await rsvpEvent(post.id, next);
            if (res?.post) {
                setView(res.post);
                setCounts(countsOf(res.post));
            } else if (res?.success) {
                setView((v: any) => {
                    const base = v ?? post;
                    const curMine = counts.mine ?? base.myRsvp;
                    let goingCount = Number(base.goingCount ?? base.event_going_count ?? 0) || 0;
                    let interestedCount = Number(base.interestedCount ?? base.event_interested_count ?? 0) || 0;
                    if (curMine === 'going') goingCount = Math.max(0, goingCount - 1);
                    if (curMine === 'interested') interestedCount = Math.max(0, interestedCount - 1);
                    return {
                        ...base,
                        myRsvp: null,
                        // Going-only content goes with the member's place: the note for people who are going, and the link.
                        eventPrivateNote: undefined,
                        eventLink: undefined,
                        goingCount,
                        event_going_count: goingCount,
                        interestedCount,
                        event_interested_count: interestedCount,
                    };
                });
                setCounts(c => applyRsvp(c, null));
            }
        } catch (err: any) {
            setCounts(before);
            // The phone's own refusals (utils/db.ts throws them as written) in the member's language; the node's words as it sent them (slice S4).
            Alert.alert(t('RSVP not saved'), err?.message ? eventLineWords(err.message) : t('Could not reach the node. Try again when you have signal.'));
        } finally {
            setPending(null);
        }
    };

    const showOnMap = () => {
        if (p.lat == null || p.lng == null) return;
        const label = encodeURIComponent(placeName || p.title || t('Event'));
        const url = Platform.OS === 'ios'
            ? `maps:0,0?q=${label}&ll=${p.lat},${p.lng}`
            : `geo:${p.lat},${p.lng}?q=${p.lat},${p.lng}(${label})`;
        Linking.openURL(url).catch(() => Alert.alert(t('No maps app'), t('The event is at {lat}, {lng}.', { lat: p.lat.toFixed(5), lng: p.lng.toFixed(5) })));
    };

    const cancelEvent = () => {
        Alert.alert(t('Cancel this event?'), t('It leaves the feed and shows CANCELLED to anyone who opens it. This cannot be undone.'), [
            { text: t('Keep event'), style: 'cancel' },
            {
                text: t('Cancel event'), style: 'destructive', onPress: async () => {
                    setCancelling(true);
                    try {
                        await deletePost(post.id);
                        // Stay on the page: the node still serves a cancelled event to its host by id, so the
                        // host sees it marked CANCELLED instead of losing it (events round 2, A4).
                        const after = await load();
                        if (!after) setView((v: any) => ({ ...(v ?? {}), status: 'cancelled', eventState: 'cancelled' }));
                        Alert.alert(t('Event cancelled'), t('It now shows CANCELLED, and everyone going has been told.'));
                    } catch (e: any) {
                        Alert.alert(t('Not cancelled'), e?.message ? eventLineWords(e.message) : t('Could not reach the node.'));
                    } finally {
                        setCancelling(false);
                    }
                },
            },
        ]);
    };

    // The same short reason list as a post (ReportReasonBox): "Child safety" is told to the owners at once.
    const [reporting, setReporting] = useState(false);
    const report = async (reason: string) => {
        if (!identity?.publicKey) return;
        try {
            const sent = await reportAbuse(identity.publicKey, p.author_pubkey || p.authorPublicKey, reason, post.id);
            setReporting(false);
            // The thanks, and why the member's words were left out when they were (case 14).
            Alert.alert(t('Reported'), reportedAlertBody(sent?.wordsLeftOut, reason));
        } catch (e: any) {
            Alert.alert(t('Not sent'), e?.message ? eventLineWords(e.message) : t('Could not reach the node.'));
            throw e; // the box keeps the choice and the words
        }
    };

    const goBack = () => { if (router.canGoBack()) router.back(); else router.replace('/(tabs)'); };

    // The quiet row's first button, the event chat: for the host and anyone Going, or its waiting form while the host has not
    // let the member in. Its words are a sentence, so it takes the row's first line whole; Share and Add to calendar share the next.
    const chatItem = letInState === 'waiting' ? (
        <View style={[shell.pageButton, styles.chatBtn, styles.chatBtnDisabled]} accessibilityRole="button" accessibilityState={{ disabled: true }}
            accessibilityLabel={eventChatWaitingText()} testID="event-chat-waiting">
            <Text style={styles.chatBtnWaitingText} numberOfLines={2}>💬 {eventChatWaitingText()}</Text>
        </View>
    ) : !copy && canOpenEventChat({ ...p, type: 'event', myRsvp: counts.mine, eventRsvps: rsvps }) ? (
        <Pressable
            onPress={() => router.push({ pathname: `/chat/${post.id}`, params: { event: '1' } })}
            style={[shell.pageButton, styles.chatBtn]}
            accessibilityRole="button"
            accessibilityLabel={eventChatEntryLabel({ ...p, goingCount: counts.going })}
            testID="event-chat-open"
        >
            <Text style={[shell.pageButtonText, styles.chatBtnText]} numberOfLines={1}>
                💬 {eventChatEntryLabel({ ...p, goingCount: counts.going })}
            </Text>
        </Pressable>
    ) : null;

    const rsvpButton = (status: EventRsvpStatus, label: string) => {
        const selected = counts.mine === status;
        const disabled = (closed && !selected) || !!pending;
        return (
            <Pressable
                onPress={() => handleRsvp(status)}
                disabled={disabled}
                style={[shell.pageButton, styles.rsvpBtn, selected && styles.rsvpBtnSelected, disabled && styles.rsvpBtnDisabled]}
                accessibilityRole="button"
                accessibilityLabel={selected ? t('{label}, selected. Tap to clear', { label }) : label}
                accessibilityState={{ selected, disabled, busy: pending === status }}
            >
                {/*
                  * The label holds the button's width while the RSVP is in flight (the card does the same): the
                  * buttons size to their own labels, so swapping the label out for the spinner would shrink the
                  * button under the finger and re-flow a stacked row mid-tap.
                  */}
                <Text style={[shell.pageButtonText, styles.rsvpText, selected && styles.rsvpTextSelected, pending === status && styles.rsvpTextBusy]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{selected ? t('{label} ✓', { label }) : label}</Text>
                {pending === status && (
                    <View style={styles.rsvpSpinner} pointerEvents="none">
                        <ActivityIndicator size="small" color={selected ? colors.event.on : colors.event.ink} />
                    </View>
                )}
            </Pressable>
        );
    };

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            <View style={styles.header}>
                <Pressable accessibilityRole="button" accessibilityLabel={t('Back')} onPress={goBack} style={styles.backButton}>
                    <Text style={styles.backText}>←</Text>
                    <Text style={[styles.backLabel, { flexShrink: 1 }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('Back')}</Text>
                </Pressable>
                {/* In capitals in the words, never a textTransform: that follows the phone's rules, not the language's. */}
                <Text style={styles.headerTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('EVENT', undefined, 'screen title')}</Text>
                <View style={{ width: 72, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' }}>
                    {showPinMenu({ pinsOn, role: pinRole, pinned: isPostPinned(p), isAuthor: isOwnEvent(p, identity?.publicKey) }) && (
                        <Pressable
                            testID="event-menu-btn"
                            accessibilityRole="button"
                            accessibilityLabel={t('Event options')}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            style={{ width: 44, height: 44, justifyContent: 'center', alignItems: 'center' }}
                            onPress={handleEventOptions}
                        >
                            <Text style={{ fontSize: 22, color: colors.text.body, fontWeight: '900' }}>···</Text>
                        </Pressable>
                    )}
                </View>
            </View>

            {/*
              * The report box's words and Submit are the last things here: under edge-to-edge the window does not resize
              * for the keyboard, so the scroll view scrolls the words above it (review of #1912, finding 2). It replaced a
              * KeyboardAvoidingView around a plain ScrollView, which shrank the page but never scrolled to the field.
              */}
            <KeyboardAwareScrollView contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 40 }]} keyboardShouldPersistTaps="handled" bottomOffset={24}>
                {/*
                  * One column, the parts in DESIGN-detail-pages-fable.md §2.1's order, drawn from the style box
                  * (components/market-card-shell.ts): the card's chips, the loud lines, the answer, the photo, the quiet row,
                  * the boxes, the description, the host, the rest, Report. The answer comes right under the loud lines; the picture and reading come after.
                  */}
                {/*
                  * 1. The chip row: the list card's own chips, in its order. Not the card's 🔒 group chip: the page says who can see
                  * it once, under the host's box (11), as the hosted-by box has it.
                  */}
                <View style={[shell.chipRow, styles.chipRow]} testID="event-chip-row">
                    <CardChip shell={shell} role="event" label={upperCase(t('EVENT', undefined, 'event category tile label'))} testID="event-type-chip" />
                    {isPostPinned(p) && <CardChip shell={shell} role="pinned" label={t('📌 PINNED')} testID="pinned-chip" />}
                    {badge === 'CANCELLED' && <CardChip shell={shell} role="danger" label={t('CANCELLED', undefined, 'event')} testID="event-state-chip" />}
                    {badge === 'UPDATED' && <CardChip shell={shell} role="event" label={t('UPDATED', undefined, 'event')} testID="event-state-chip" />}
                </View>

                {/* 2. The pin line. */}
                {isPostPinned(p) && (
                    <View style={styles.pinLine} testID="pinned-detail-line">
                        <Text style={styles.pinLineText} numberOfLines={2}>
                            {pinnedDetailLine(p)}
                        </Text>
                        {isOwnEvent(p, identity?.publicKey) && (
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={t('Take the pin off')}
                                testID="event-author-unpin-btn"
                                onPress={async () => {
                                    if (unpinning) return;
                                    setUnpinning(true);
                                    try {
                                        await unpinPostOnNode(p.id);
                                        await load();
                                    } catch (e: any) {
                                        Alert.alert(t('Error'), pinFailureText(e, t('Failed to unpin post')));
                                    } finally {
                                        setUnpinning(false);
                                    }
                                }}
                                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                style={{ paddingHorizontal: 8, paddingVertical: 4 }}
                            >
                                <Text style={styles.unpinText}>{t('Take the pin off')}</Text>
                            </Pressable>
                        )}
                    </View>
                )}

                {/*
                  * 4. The loud lines, the card's three in the card's order: the when, the title, the place. A repeating event's rule
                  * sits under the when and is the door to its next dates (six on a by-id read; DESIGN-web-dates-stop-fable.md §4):
                  * "↻ Monthly, third Saturday · Next dates", one button that opens the list and the host's controls, the rule then
                  * the list's heading. Before the node answers (the cached row has no dates) the rule alone, in the same place.
                  */}
                <Text testID="event-when" style={[styles.when, cancelled && styles.whenCancelled]}>{when}</Text>
                {!!whenParts?.note && <Text style={styles.timeNote}>{whenParts.note}</Text>}
                {!!hostLine && <Text style={styles.timeNote}>{hostLine}</Text>}
                <EventNextDates
                    post={view ?? p}
                    compact
                    repeatCaption={eventRepeatCaption(p)}
                    isHost={isHost && !closed}
                    onChanged={(next) => setView(next)}
                    onChangeThisDateOnly={(next) => {
                        const copy = buildEventCopy(next, identity?.publicKey);
                        setCopyDraft({ ...copy, description: withMovedFromLine(seriesMovedFromLine(next.eventRepeat), copy.description) });
                    }}
                />
                <Text style={styles.title} testID="event-title">{p.title}</Text>
                {ended && !cancelled && <Text style={styles.endedNote}>{t('This event has ended.')}</Text>}

                {online && (
                    <View style={styles.placeRow}>
                        <Text style={styles.place} numberOfLines={2}>💻 {eventPlaceLine(p, null)}</Text>
                        {!!joinLink && !closed && (
                            <Pressable
                                onPress={() => Linking.openURL(joinLink).catch(() => Alert.alert(t('Could not open the link'), joinLink))}
                                style={styles.linkBtn}
                                accessibilityRole="link"
                                accessibilityLabel={p.title ? t('Join {title} online', { title: p.title }) : t('Join the event online')}
                            >
                                <Text style={styles.link} numberOfLines={1}>{t('Join')}</Text>
                            </Pressable>
                        )}
                    </View>
                )}
                {online && !!joinLink && !closed && <Text style={styles.joinLink} selectable numberOfLines={2}>{joinLink}</Text>}
                {online && !joinLink && !isHost && !closed && (() => {
                    const words = eventLinkWaitWords(counts.mine, !!view, letInState);
                    return words ? <Text style={styles.timeNote}>{words}</Text> : null;
                })()}

                {!online && !!placeName && (
                    <View style={styles.placeRow}>
                        <Text style={styles.place} numberOfLines={2}>📍 {placeName}</Text>
                        {p.lat != null && p.lng != null && (
                            <Pressable onPress={showOnMap} style={styles.linkBtn} accessibilityRole="link" accessibilityLabel={t('Show {place} on a map', { place: placeName })}>
                                <Text style={styles.link} numberOfLines={2}>{t('Show on map')}</Text>
                            </Pressable>
                        )}
                    </View>
                )}
                {!copy && placeShownRoughly({ authorPublicKey: p.authorPublicKey ?? p.author_pubkey, type: 'event', lat: p.lat, lng: p.lng,
                    eventRsvps: p.eventRsvps, myRsvp: p.myRsvp, myLetIn: p.myLetIn }, identity?.publicKey, openMembership) && (
                    <Text style={styles.roughPlace} testID="rough-place-line">{t(PLACE_WORDS.roughPlace, { name: hostName })}</Text>
                )}

                {/* 7. The answer: Going / Interested for a member, the host's line, a copy's door; the counts once someone has answered. */}
                <View style={styles.action} testID="event-action">
                    {isHost ? (
                        <Text style={styles.hostingLine} accessibilityRole="text">{t("You're hosting this event")}</Text>
                    ) : copy ? (
                        !closed && <EventCopyDoor copy={copy} />
                    ) : (
                        <View style={styles.rsvpRow}>
                            {rsvpButton('going', t('Going'))}
                            {rsvpButton('interested', t('Interested'))}
                        </View>
                    )}
                    {/* Nothing while nobody has answered (the card's rule): "0 going · 0 interested" reads as a dead community. */}
                    {!copy && counts.going + counts.interested > 0 && (
                        <Text style={styles.counts} numberOfLines={2} testID="event-counts">👥 {formatRsvpCounts(counts.going, counts.interested)}</Text>
                    )}
                    {letInLine && !closed && (
                        <Text style={styles.letInLine} accessibilityLiveRegion="polite" testID="event-let-in-line">{letInLine}</Text>
                    )}
                </View>

                {/*
                  * 7a. The photo, under the answer (DESIGN-detail-pages-frame-fable.md §1.4): 4:3, the column's width, under the
                  * column's corners (the grid tile's frame, so the page shows the picture the member tapped). No photo: the event's
                  * tile, 3:1, inside the column. 16 under the answer (the action's margin), 16 over the quiet row.
                  */}
                {shownPhotos.length > 0 ? (
                    <View style={styles.photoFrame} testID="event-photo-frame" onLayout={(e) => setPhotoHeight(Math.round(e.nativeEvent.layout.height))}>
                        {photoHeight > 0 && <PhotoCarousel photos={shownPhotos} height={photoHeight} borderRadius={SHELL.radius} />}
                    </View>
                ) : (
                    <View style={styles.tileBanner} testID="event-tile-banner">
                        <CategoryTile kind="event" size="banner" />
                    </View>
                )}

                {/*
                  * 8. The quiet row: the chat, Share, Add to calendar, in the neutral outline. Share and the calendar need no node,
                  * so they are there whatever its age; the chat is the page's, for the host and anyone Going.
                  */}
                <View style={styles.quietRow} testID="event-quiet-row">
                    {chatItem}
                    <EventShareAndCalendar post={p} />
                </View>

                {/* 9. Remind me and the note for people who are going: boxes. The host is running it and has no RSVP, so no reminder (decision 2). */}
                {!isHost && !copy && (
                    <EventReminder post={p} myRsvp={counts.mine} viewerPublicKey={identity?.publicKey} />
                )}
                {note ? (
                    <View style={[shell.pageBox, styles.box]} testID="event-note-box">
                        <Text style={[shell.boxLabel, styles.noteLabel]}>{t('NOTE FOR PEOPLE WHO ARE GOING')}</Text>
                        <Text style={styles.noteText} selectable>{note}</Text>
                    </View>
                ) : null}

                {/* 10. The description and the tags. */}
                {!!p.description && <Text style={styles.description}>{p.description}</Text>}
                <PostTagChips tags={p.tags} freeTags={p.freeTags ?? p.free_tags} />

                {/* 11. A copy has no host: the line names where it comes from. Otherwise the host is the same box as a listing's "POSTED BY". */}
                {copy?.from && (
                    <Text style={styles.hostLine} numberOfLines={2}>{copyFromLine(copy.from)}</Text>
                )}
                {!copy && (
                    <AuthorCard
                        label={t('HOSTED BY')}
                        pubkey={hostKey ?? ''}
                        callsign={hostName}
                        avatarUrl={p.author_avatar ?? p.authorAvatarUrl ?? p.author_avatar_url ?? null}
                        rating={hostRating}
                        disabled={!canOpenHost}
                        testID={canOpenHost ? 'event-host-open' : 'event-host-card'}
                        style={styles.hostCard}
                        onPress={() => router.push({ pathname: '/public-profile', params: { publicKey: hostKey, callsign: hostName } })}
                    />
                )}
                {!copy && isGroupOnly && !!groupName && (
                    <Text style={styles.hostAudience} testID="event-host-audience">{t('🔒 Only {group} can see this.', { group: groupName })}</Text>
                )}

                {/* 12. The host's: show it on the global community, and the guest list box. */}
                {isHost && !!view && (
                    <ShowOnGlobalHostRow event={view} enabled={onLocalCommunity && !copy && !closed && !online && !isGroupOnly && view.authorPublicKey === identity?.publicKey} />
                )}

                {isHost && (
                    <View style={[shell.pageBox, styles.hostBox]} testID="event-host-box">
                        {hostView && (<Pressable
                            onPress={() => setShowRsvps(s => !s)}
                            style={styles.hostRowBtn}
                            accessibilityRole="button"
                            accessibilityState={{ expanded: showRsvps }}
                            accessibilityLabel={tn(rsvps!.length, "Who's going, {n} replies", "Who's going, {n} replies")}
                        >
                            <Text style={styles.hostRowText} numberOfLines={1}>{t("Who's going ({n})", { n: rsvps!.length })}</Text>
                            <Text style={styles.hostRowText}>{showRsvps ? '▲' : '▼'}</Text>
                        </Pressable>)}
                        {hostView && waiting > 0 && (
                            <Text style={styles.waitingCount} testID="event-waiting-count">{eventWaitingLine(waiting)}</Text>
                        )}
                        {hostView && showRsvps && waiting >= 2 && !closed && (
                            <Pressable onPress={letEveryoneIn} disabled={!!letting} style={styles.letAllBtn} accessibilityRole="button"
                                accessibilityLabel={t('Let everyone in')} testID="event-let-everyone-in">
                                <Text style={styles.letAllText} numberOfLines={1}>{t('Let everyone in')}</Text>
                            </Pressable>
                        )}
                        {hostView && showRsvps && (rsvps!.length === 0
                            ? <Text style={styles.rsvpEmpty}>{t('Nobody has replied yet.')}</Text>
                            : rsvps!.map((r: any) => (
                                <View key={r.memberPubkey} style={styles.rsvpListRow}>
                                    <Text style={styles.rsvpName} numberOfLines={1}>{r.memberCallsign || r.memberPubkey.slice(0, 8)}</Text>
                                    {hostLetsIn && r.status === 'going' && !closed ? (
                                        <Pressable
                                            onPress={() => saveLetIn(r.memberPubkey, { memberPublicKey: r.memberPubkey }, !r.letInAt)}
                                            disabled={!!letting}
                                            style={[styles.letInBtn, r.letInAt && styles.letInBtnOn]}
                                            accessibilityRole="button"
                                            accessibilityState={{ selected: !!r.letInAt, busy: letting === r.memberPubkey }}
                                            accessibilityLabel={letInButtonLabel(!!r.letInAt, r.memberCallsign)}
                                        >
                                            <Text style={[styles.letInText, r.letInAt && styles.letInTextOn]} numberOfLines={1}>{r.letInAt ? t('Let in ✓') : t('Let in')}</Text>
                                        </Pressable>
                                    ) : (
                                        <Text style={styles.rsvpStatus} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{r.status === 'going' ? t('Going') : t('Interested')}</Text>
                                    )}
                                </View>
                            )))}
                        {editBlocked ? (
                            <Text style={styles.editBlocked}>{editBlocked}</Text>
                        ) : (
                            <Pressable
                                onPress={() => setEditOf({
                                    id: post.id,
                                    // The cached row's photo paths are already resolved against the node.
                                    values: eventEditValues({ ...p, photos }),
                                    audienceLabel: isGroupOnly && groupName ? t('🔒 Only {group} can see this.', { group: groupName }) : t('This community.'),
                                })}
                                style={styles.editBtn}
                                accessibilityRole="button"
                                accessibilityLabel={t('Edit event')}
                            >
                                <Text style={styles.editText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('Edit event')}</Text>
                            </Pressable>
                        )}
                        <Pressable
                            onPress={() => setCopyDraft(buildEventCopy(p, identity?.publicKey))}
                            style={styles.copyBtn}
                            accessibilityRole="button"
                            accessibilityLabel={t('Copy to a new date')}
                        >
                            <Text style={styles.copyText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('Copy to a new date')}</Text>
                        </Pressable>
                        {!closed && (
                            <Pressable
                                onPress={cancelEvent}
                                disabled={cancelling}
                                style={styles.cancelBtn}
                                accessibilityRole="button"
                                accessibilityLabel={t('Cancel event')}
                                accessibilityState={{ busy: cancelling }}
                            >
                                {cancelling ? <ActivityIndicator size="small" color={colors.feedback.danger.fg} /> : <Text style={styles.cancelText}>{t('Cancel event')}</Text>}
                            </Pressable>
                        )}
                    </View>
                )}

                {/* 13. Report, last. */}
                {!isHost && identity?.publicKey && (
                    <>
                        <Pressable onPress={() => setReporting((r) => !r)} style={styles.reportBtn} accessibilityRole="button" accessibilityLabel={t('Report event')} accessibilityState={{ expanded: reporting }}>
                            <Text style={styles.reportText}>{t('🚩 Report event')}</Text>
                        </Pressable>
                        {reporting && <ReportReasonBox onSubmit={report} onCancel={() => setReporting(false)} />}
                    </>
                )}
            </KeyboardAwareScrollView>

            <NewEventModal
                visible={!!copyDraft}
                prefill={copyDraft}
                onClose={() => setCopyDraft(null)}
                onSuccess={() => { setCopyDraft(null); goBack(); }}
            />
            <NewEventModal
                visible={!!editOf}
                editOf={editOf}
                onClose={() => setEditOf(null)}
                onSaved={() => { load(); DeviceEventEmitter.emit('sync_data_updated'); }}
            />
            {/* Drawn only while open: the sheet is a Modal, and most screens never open it. */}
            {showPinSheet && (
                <PinSheet
                    visible
                    postId={p.id}
                    onClose={() => setShowPinSheet(false)}
                    onPinned={async () => {
                        await load();
                    }}
                />
            )}
        </View>
    );
}

// The page's rhythm (DESIGN-detail-pages-fable.md §2.3, as DESIGN-detail-pages-frame-fable.md §3 amends it): 8 between lines
// inside a part, 12 from the last loud line to the answer, 16 from the answer to the photo and from the photo to the quiet row,
// 16 between parts.
// Radii, chips, box shells and button heights come from the style box (components/market-card-shell.ts), colours from the tokens.
const makeStyles = ({ colors }: ThemeContextType) =>
    StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.page },
        header: {
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
            paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.surface.subtle,
        },
        backButton: { flexDirection: 'row', width: 72, minHeight: 48, alignItems: 'center' },
        backText: { color: colors.text.body, fontSize: 22 },
        backLabel: { color: colors.text.body, fontSize: 15, fontWeight: '700', marginLeft: 4 },
        headerTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '800', color: colors.text.body, letterSpacing: 1 },
        scroll: { padding: 16 },
        chipRow: { marginBottom: 8 },
        pinLine: { marginBottom: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
        pinLineText: { fontSize: 13, color: colors.text.secondary, fontWeight: '600', flex: 1 },
        unpinText: { fontSize: 12, fontWeight: '700', color: colors.feedback.danger.fg },
        // The loud line: the when, in the event's ink, louder than anything but the title.
        when: { fontSize: 18, fontWeight: '800', lineHeight: 24, color: colors.event.ink, marginBottom: 4 },
        whenCancelled: { textDecorationLine: 'line-through', color: colors.text.secondary },
        timeNote: { fontSize: 14, color: colors.text.secondary, marginBottom: 4 },
        title: { fontSize: 20, fontWeight: '800', lineHeight: 26, color: colors.text.heading, marginTop: 4, marginBottom: 4 },
        endedNote: { fontSize: 14, color: colors.text.secondary, marginBottom: 4 },
        placeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
        place: { flex: 1, fontSize: 14, fontWeight: '600', color: colors.text.body },
        joinLink: { fontSize: 13, color: colors.text.secondary, marginBottom: 4 },
        roughPlace: { fontSize: 13, lineHeight: 18, color: colors.text.secondary, marginBottom: 4 },
        linkBtn: { minHeight: 48, justifyContent: 'center', flexShrink: 0 },
        link: { fontSize: 14, fontWeight: '700', color: colors.text.link },
        // 4:3 of the column's width, under the column's corners; 3:1 for the tile when there is no photo.
        photoFrame: {
            width: '100%', aspectRatio: SHELL.photo.grid.aspectWidth / SHELL.photo.grid.aspectHeight,
            borderRadius: SHELL.radius, overflow: 'hidden', backgroundColor: colors.surface.subtle, marginTop: 0, marginBottom: 16,
        },
        tileBanner: { width: '100%', aspectRatio: 3, borderRadius: SHELL.radius, overflow: 'hidden', marginTop: 0, marginBottom: 16 },
        action: { marginTop: 12, marginBottom: 16 },
        // Sized to the label, wrapping to a second row rather than ellipsizing it — the same fix the card and the
        // web EventCard carry. This row's text is 15sp, so it runs out of width sooner than the card's 14sp.
        rsvpRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
        // Colour marks the commit (§2.7): the outline and its words in the event's ink; chosen, the event's fill with its words.
        rsvpBtn: {
            flexGrow: 1, flexBasis: 'auto', flexShrink: 0, borderWidth: 1.5, borderColor: colors.event.ink,
            paddingHorizontal: 6, backgroundColor: colors.surface.card,
        },
        rsvpBtnSelected: { backgroundColor: colors.event.fill, borderColor: colors.event.fill },
        rsvpBtnDisabled: { opacity: 0.5 },
        rsvpText: { color: colors.event.ink },
        rsvpTextSelected: { color: colors.event.on },
        rsvpTextBusy: { opacity: 0 },
        rsvpSpinner: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
        counts: { fontSize: 13, lineHeight: 18, color: colors.text.secondary, marginTop: 6 },
        letInLine: { fontSize: 14, color: colors.text.body, lineHeight: 20, marginTop: 6 },
        // The quiet row: the chat, then EventShareAndCalendar's Share and Add to calendar, wrapping by whole buttons, never cut.
        quietRow: { flexDirection: 'row', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'flex-start' },
        // Its chat: the neutral outline, its own line in the row (a sentence's words, never cut beside Share).
        chatBtn: {
            flexGrow: 1, flexBasis: '100%', paddingHorizontal: 12, alignItems: 'flex-start',
            borderWidth: 1.5, borderColor: colors.border.strong, backgroundColor: colors.surface.card,
        },
        chatBtnText: { color: colors.text.body },
        chatBtnDisabled: { borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.subtle, paddingVertical: 8 },
        chatBtnWaitingText: { fontSize: 14, fontWeight: '600', color: colors.text.secondary, lineHeight: 19 },
        // A page box's place in the column; the box itself is the style box's.
        box: { marginBottom: 16 },
        noteLabel: { color: colors.event.ink, marginBottom: 8 },
        noteText: { fontSize: 15, color: colors.text.body, lineHeight: 21 },
        description: { fontSize: 15, color: colors.text.body, lineHeight: 22, marginBottom: 16 },
        hostLine: { fontSize: 14, color: colors.text.secondary, marginBottom: 16 },
        // The host's box sits in the page's own 16 dp padding (the listing's page has none, so its box carries 20 dp of margin).
        hostCard: { marginHorizontal: 0, marginBottom: 16 },
        // A group-only event says who can see it, just under the host's box.
        hostAudience: { fontSize: 14, color: colors.text.secondary, marginTop: -8, marginBottom: 16 },
        hostBox: { paddingVertical: 4, marginBottom: 16 },
        waitingCount: { fontSize: 14, fontWeight: '700', color: colors.text.body, paddingBottom: 8 },
        letAllBtn: {
            minHeight: 44, justifyContent: 'center', alignItems: 'center', borderRadius: 12, borderWidth: 1.5,
            borderColor: colors.event.ink, marginBottom: 8, paddingHorizontal: 12,
        },
        letAllText: { fontSize: 14, fontWeight: '700', color: colors.event.ink },
        letInBtn: {
            minHeight: 44, minWidth: 88, justifyContent: 'center', alignItems: 'center', borderRadius: 10, borderWidth: 1.5,
            borderColor: colors.event.ink, paddingHorizontal: 10, flexShrink: 0,
        },
        letInBtnOn: { backgroundColor: colors.event.fill, borderColor: colors.event.fill },
        letInText: { fontSize: 14, fontWeight: '700', color: colors.event.ink },
        letInTextOn: { color: colors.event.on },
        hostRowBtn: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
        hostRowText: { fontSize: 15, fontWeight: '700', color: colors.text.body, flexShrink: 1 },
        rsvpEmpty: { fontSize: 14, color: colors.text.secondary, paddingVertical: 8 },
        rsvpListRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border.default },
        rsvpName: { flex: 1, fontSize: 14, color: colors.text.body },
        // Gives way to a longer language's word (up to half the row) rather than pushing the name off; shrinks to fit.
        rsvpStatus: { fontSize: 13, fontWeight: '700', color: colors.event.ink, flexShrink: 1, maxWidth: '45%' },
        hostingLine: { fontSize: 15, fontWeight: '700', color: colors.event.ink },
        editBtn: {
            minHeight: 48, justifyContent: 'center', alignItems: 'center', borderRadius: 12, backgroundColor: colors.event.fill,
            marginTop: 4, marginBottom: 4, paddingHorizontal: 12,
        },
        editText: { fontSize: 15, fontWeight: '800', color: colors.event.on },
        editBlocked: { fontSize: 14, color: colors.text.secondary, paddingVertical: 10 },
        copyBtn: { minHeight: 48, justifyContent: 'center', alignItems: 'center', borderTopWidth: 1, borderTopColor: colors.border.default, marginTop: 4 },
        copyText: { fontSize: 15, fontWeight: '700', color: colors.event.ink },
        cancelBtn: { minHeight: 48, justifyContent: 'center', alignItems: 'center', borderTopWidth: 1, borderTopColor: colors.border.default, marginTop: 4 },
        cancelText: { fontSize: 15, fontWeight: '700', color: colors.feedback.danger.fg },
        reportBtn: { minHeight: 48, justifyContent: 'center', alignSelf: 'flex-start' },
        reportText: { fontSize: 13, fontWeight: '700', color: colors.feedback.danger.fg },
    });
