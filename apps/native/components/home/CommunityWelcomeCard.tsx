/**
 * The community's own welcome on Home (scratch/fable-design/DESIGN-onboarding-home-landing-fable.md §4.1 item 2, §4.2,
 * §4.3, §4.5; Marty's picks of 21 Nov 2026, slice S7): under BeanPool's WELCOME TO BEANPOOL! tile, a Home card with a clay
 * band, "FROM RIVERSIDE" and its ×. Inside, the owners' words exactly as they wrote them (280 characters at most, never
 * translated, so never through t()), then whose invite brought the member with "Say hello ›" (the line BeanPool's tile
 * carried until this slice), or "You're the first one here." with "Invite someone ›", then the member count. No owners'
 * words yet: the inviter's line and the count alone; an owner is asked "Write your community's welcome ›", which opens the
 * community's Settings as Manage does.
 *
 * When it is drawn is core's one rule (`communityWelcomeCard`): a member's, from joining to day 30, until its own ×, which
 * is kept in the Home layout's `dismissed` map so every device of the account follows. It is not arrangeable: Home draws
 * it under the tile (or where the tile would be) and it leaves by its ×. In a second community on the same phone, where
 * BeanPool's part is not drawn, this card still is.
 *
 * Also here: the community card's "Riverside's welcome ›", which shows the owners' words again once this card has gone.
 */
import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
    COMMUNITY_WELCOME_CARD_WORDS, communityWelcomeCard, formatCount, t, tn, type CommunityWelcomeAnswer,
} from '@beanpool/core';
import type { AppColors } from '../../constants/colors';
import { HomeCard, HomeRow, homeStyles } from './HomeParts';
import { communityWelcomeStyles } from './community-welcome-styles';
import { useManageNode } from '../useManageNode';
import { cachedNodeRole } from '../../utils/node-admin';
import type { BeanPoolIdentity } from '../../utils/identity';
import type { HomeRole } from '../../utils/home-cards';

export interface CommunityWelcomeProps {
    answer: CommunityWelcomeAnswer;
    /** The reader's role as Home heard it; undefined where Home did not ask (only where admins invite), so the card asks. */
    role: HomeRole;
    /** When its × put it away (the layout's `dismissed`), or null. */
    dismissedAt: string | null;
    now: number;
    /** The community this Home is for, and whose account reads it: for the role, asked only for the owner's prompt. */
    nodeUrl: string | null;
    identity: BeanPoolIdentity | null;
    colors: AppColors;
    /** In Arrange: drawn as Home draws it, dimmed and untouchable (it does not move). */
    quiet?: boolean;
    onPutAway: () => void;
    onSayHello: (key: string) => void;
    /** Absent: the reader can't invite here, so "You're the first one here." stands alone. */
    onInvite?: () => void;
}

/**
 * The reader's role, for the owner's prompt only: Home's when it asked, else this card asks the node once (the same cached
 * read Home and Settings use), and only while the prompt is the one thing that would change. Anything not heard is no role:
 * the prompt is never offered on a guess.
 */
function usePromptRole({ answer, role, dismissedAt, now, nodeUrl, identity }: CommunityWelcomeProps): HomeRole {
    const [heard, setHeard] = useState<{ who: string; role: HomeRole } | null>(null);
    const who = nodeUrl && identity ? `${identity.publicKey}\n${nodeUrl}` : null;
    const wants = role === undefined && !!who && !!communityWelcomeCard(answer, { role: 'owner', dismissedAt, now })?.ownerPrompt;
    useEffect(() => {
        if (!wants || !who || !nodeUrl || !identity) return;
        let live = true;
        void cachedNodeRole(nodeUrl, identity).then(r => { if (live) setHeard({ who, role: r.role }); }).catch(() => undefined);
        return () => { live = false; };
    }, [wants, who, nodeUrl, identity]);
    return role !== undefined ? role : heard?.who === who ? heard.role : undefined;
}

export function CommunityWelcomeCard(props: CommunityWelcomeProps) {
    const { answer, dismissedAt, now, colors, quiet, onPutAway, onSayHello, onInvite } = props;
    const role = usePromptRole(props);
    const manage = useManageNode();
    const card = communityWelcomeCard(answer, { role, dismissedAt, now });
    if (!card) return null;
    const s = homeStyles(colors);
    const ink = colors.card.clay.ink;
    const name = typeof answer.cards?.community?.name === 'string' ? answer.cards.community.name.trim() : '';
    const link = (text: string, onPress: () => void, testID: string, a11y?: string) => (
        <Pressable onPress={onPress} style={({ pressed }) => [st.link, pressed && s.pressed]} accessibilityRole="button" accessibilityLabel={a11y ?? text} testID={testID}>
            <Text style={[st.linkText, { color: colors.text.link }]}>{text}</Text>
        </Pressable>
    );
    const away = (
        <Pressable
            onPress={onPutAway}
            style={({ pressed }) => [st.x, pressed && s.pressed]}
            accessibilityRole="button"
            accessibilityLabel={t(COMMUNITY_WELCOME_CARD_WORDS.away)}
            testID="home-welcome-community-x"
        >
            <Text style={[st.xText, { color: ink }]} importantForAccessibility="no">×</Text>
        </Pressable>
    );
    return (
        <>
            <HomeCard id="community-welcome" caption={card.caption} colors={colors} hue="clay" right={away} quiet={quiet} testID="home-welcome-community">
                {/* The owners' own words, as written: no t(), no line limit (280 characters, 4 lines at most), any script's direction. */}
                {card.words !== null && (
                    <Text style={[st.words, { color: colors.text.heading }]} testID="home-welcome-community-words">{card.words}</Text>
                )}
                {card.inviter ? (
                    <View style={st.row}>
                        <Text style={[st.small, { color: colors.text.body }]} testID="home-welcome-community-inviter">{t('{name} invited you.', { name: card.inviter.name })}</Text>
                        {link(t('Say hello ›'), () => onSayHello(card.inviter!.key), 'home-welcome-community-hello', t('Say hello to {name}', { name: card.inviter.name }))}
                    </View>
                ) : card.firstHere ? (
                    <View style={st.row}>
                        <Text style={[st.small, { color: colors.text.body }]} testID="home-welcome-community-first">{t("You're the first one here.")}</Text>
                        {onInvite && link(t('Invite someone ›'), onInvite, 'home-welcome-community-invite')}
                    </View>
                ) : null}
                {card.ownerPrompt && (
                    <HomeRow
                        colors={colors}
                        text={t(COMMUNITY_WELCOME_CARD_WORDS.write)}
                        a11y={t(COMMUNITY_WELCOME_CARD_WORDS.write)}
                        lines={3}
                        strong
                        onPress={() => { void manage.start(name || t('this community')); }}
                        testID="home-welcome-community-write"
                    />
                )}
                {card.members !== null && (
                    <Text style={[st.count, { color: colors.text.secondary }]} testID="home-welcome-community-members">
                        {tn(card.members, '{n} member', '{n} members', { n: formatCount(card.members) })}
                    </Text>
                )}
            </HomeCard>
            {manage.dialog}
        </>
    );
}

/**
 * The community card's line (§4.2 "Day 30"): "Riverside's welcome ›" opens the owners' words in place, under it; again
 * folds them. For whenever the welcome card is not drawn (put away, or past the newcomer's days). Nothing is written.
 */
export function CommunityWelcomeAgain({ line, words, colors }: { line: string; words: string; colors: AppColors }) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <HomeRow
                colors={colors}
                text={line}
                a11y={line}
                lines={3}
                onPress={() => setOpen(o => !o)}
                testID="home-community-welcome-again"
            />
            {open && <Text style={[st.words, { color: colors.text.heading }]} testID="home-community-welcome-words">{words}</Text>}
        </>
    );
}

const st = communityWelcomeStyles;
