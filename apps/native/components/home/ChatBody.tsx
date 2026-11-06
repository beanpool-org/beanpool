import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { t, type HomeChatCard } from '@beanpool/core';
import type { AppColors } from '../../constants/colors';
import { SEARCH_OFFLINE_LINE, sentence, timeAgoInWords, type HomeCardInstance } from '../../utils/home-cards';
import { CHAT_CARD_WORDS, chatCardTarget, chatCardView, chatPickOf, type ChatCardLine, type OpenedChat } from '../../utils/home-chat';
import { homeChatOpenKey, openHomeChat, type HomeChatOpenDeps } from '../../utils/home-chat-open';
import { needsTargetHref } from '../../utils/needs-you';
import { HOME_TARGET_DP, HomeButton, homeStyles } from './HomeParts';

/** One line as the card writes it: "Ana, 2h ago: Who has a ladder…", "You, 1h ago: …", or a line that is nobody's alone. */
export function chatLineText(l: ChatCardLine, now: number = Date.now()): string {
    if (!l.who) return l.text;
    const when = timeAgoInWords(l.at, now);
    return when ? t('{who}, {when}: {text}', { who: l.who, when, text: l.text }) : t('{who}: {text}', { who: l.who, text: l.text });
}

/**
 * "A chat" (DESIGN-home-chosen-chat-fable.md §2): the chat the member picked, its name, 🔕 when muted, the new count, and its
 * last lines, opened on this phone. The lines are opened here (utils/home-chat-open.ts) and kept in this component's
 * state only: never written anywhere. They are opened again whenever the node's lines change and when Home comes back to
 * the front (a key opened in Talk meanwhile then reads the group's lines). Opening never fetches.
 */
export function ChatBody({ inst, card, me, colors, deps, onPick, onRemove, now }: {
    inst: HomeCardInstance;
    card: HomeChatCard | null;
    me: string | null | undefined;
    colors: AppColors;
    /** db.ts's doors (judgeHomeChatDmLines, groupKeyringFor). */
    deps: HomeChatOpenDeps;
    /** Pick a chat: the card's settings list. */
    onPick: () => void;
    /** Remove, when the chat is gone. */
    onRemove: () => void;
    now?: number;
}) {
    const s = homeStyles(colors);
    const c = chatCardStyles(colors);
    const pick = chatPickOf(inst);
    const [opened, setOpened] = useState<{ key: string; chat: OpenedChat } | null>(null);
    const key = pick ? homeChatOpenKey(pick, card) : null;
    const turn = useRef(0);
    const open = useCallback(() => {
        if (!pick || !key) return;
        const mine = ++turn.current;
        void openHomeChat(pick, card, deps).then(chat => { if (turn.current === mine) setOpened({ key, chat }); });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, card, deps]);
    useEffect(() => { open(); }, [open]);
    useFocusEffect(open);
    // Nothing drawn from another chat's opening: a stale result for other lines is no result.
    const chat = opened && opened.key === key ? opened.chat : undefined;
    const view = chatCardView(inst, card, me, chat);

    if (view.state === 'pick') {
        return (
            <View style={s.buttonRow}>
                <HomeButton primary colors={colors} text={t(CHAT_CARD_WORDS.pick)} onPress={onPick} testID={`home-chat-pick-${inst.id}`} />
            </View>
        );
    }
    if (view.state === 'gone') {
        return (
            <View testID={`home-chat-gone-${inst.id}`}>
                <Text style={[c.line, { color: colors.text.body }]}>{t(CHAT_CARD_WORDS.gone)}</Text>
                <View style={s.buttonRow}>
                    <HomeButton colors={colors} text={t('Remove')} a11y={t('Remove {card} from Home', { card: pick?.name ? t('"{words}"', { words: pick.name }) : t('A chat') })}
                        onPress={onRemove} testID={`home-chat-remove-${inst.id}`} />
                </View>
            </View>
        );
    }
    const lines = view.state === 'chat' ? view.lines.map(l => chatLineText(l, now)) : [];
    const empty = view.state === 'chat' && lines.length === 0;
    const sub = view.state === 'waiting' ? t(SEARCH_OFFLINE_LINE) : empty ? t(CHAT_CARD_WORDS.empty) : null;
    const nameLine = view.state === 'chat' && view.muted ? `${view.name} 🔕` : view.name;
    const pill = view.state === 'chat' ? view.pill : null;
    const said = [nameLine, pill, ...lines, sub].filter((x): x is string => !!x).map(sentence).join(' ');
    return (
        <Pressable
            onPress={() => { if (pick) router.push(needsTargetHref(chatCardTarget(pick))); }}
            style={({ pressed }) => [c.body, pressed && s.pressed]}
            accessibilityRole="button"
            accessibilityLabel={t('{line} Opens the chat.', { line: said })}
            testID={`home-chat-${inst.id}`}
        >
            <View style={c.head}>
                <Text style={[c.name, { color: colors.text.heading }]} numberOfLines={2} testID={`home-chat-name-${inst.id}`}>{nameLine}</Text>
                {pill && (
                    <View style={[c.pill, { backgroundColor: colors.brand.fill }]}>
                        <Text style={[c.pillText, { color: colors.text.inverse }]} numberOfLines={1}>{pill}</Text>
                    </View>
                )}
            </View>
            {lines.map((text, i) => (
                <Text key={view.state === 'chat' ? view.lines[i].id : i} style={[c.line, { color: colors.text.body }]} numberOfLines={2} testID={`home-chat-line-${inst.id}-${i}`}>{text}</Text>
            ))}
            {sub && <Text style={[c.line, { color: colors.text.secondary }]} testID={`home-chat-note-${inst.id}`}>{sub}</Text>}
        </Pressable>
    );
}

const cache = new Map<AppColors, ReturnType<typeof make>>();
/** The card's own layout: the name wraps to two lines and the pill wraps under it at 320dp × 1.3 (design §2). */
export function chatCardStyles(colors: AppColors) {
    let s = cache.get(colors);
    if (!s) { s = make(); cache.set(colors, s); }
    return s;
}
function make() {
    return StyleSheet.create({
        body: { minHeight: HOME_TARGET_DP, paddingVertical: 6, borderRadius: 10 },
        head: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, rowGap: 4, marginBottom: 4 },
        name: { fontSize: 15, fontWeight: '700', flexShrink: 1, maxWidth: '100%' },
        pill: { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2, flexShrink: 0, maxWidth: '100%' },
        pillText: { fontSize: 12, fontWeight: '700' },
        line: { fontSize: 14, lineHeight: 20, marginTop: 2 },
    });
}
