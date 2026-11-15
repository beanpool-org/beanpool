/**
 * The visitors' Forum tab (slice F7, the apps' part; DESIGN-forums-fable.md §18 "Visitors: guest view gains a Forum tab"): in
 * the Chat tab's place for a visitor on the global community (Talk is an account's), so the bar stays at six. The forum, read
 * only, with Join to reply as its door (components/forum/ForumVisitorPane.tsx). A member, or a community whose forum is for
 * its members, never has it in the bar ((tabs)/_layout.tsx); a member who lands here anyway goes to the Chat tab's Forum.
 */
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { FORUM_HOME_WORDS, t } from '@beanpool/core';
import { PageTitle } from '../../components/PageTitle';
import { ForumVisitorPane } from '../../components/forum/ForumVisitorPane';
import { useForumStyles } from '../../components/forum/forum-style';
import { visitorForumHere } from '../../utils/forum-public';

export default function ForumTab() {
    const styles = useForumStyles();
    const [visitor, setVisitor] = useState<boolean | null>(null);
    useEffect(() => {
        let live = true;
        void visitorForumHere().then((v) => {
            if (!live) return;
            setVisitor(v);
            if (!v) router.replace({ pathname: '/(tabs)/chats', params: { view: 'forum' } });
        });
        return () => { live = false; };
    }, []);
    return (
        <View style={styles.page} testID="forum-tab">
            <PageTitle title={t(FORUM_HOME_WORDS.name)} testID="page-title-forum" />
            {visitor && <ForumVisitorPane />}
        </View>
    );
}
