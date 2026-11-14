import React from 'react';
import { View } from 'react-native';

/**
 * The Chat tab's Forum side (slice T0; DESIGN-forums-messaging-joint-fable.md §2.1, §3.2): drawn under the Chats · Forum
 * switch (components/ChatFrameSwitch.tsx) where this community's forum is on. Empty on purpose: slice F3 fills it (its
 * sections, topics, the first-look row for moderators and the "Worldwide forum ›" row) and owns everything under
 * components/forum/ and app/forum/, without touching app/(tabs)/chats.tsx.
 */
export function ForumPane() {
    return <View testID="forum-pane" style={{ flex: 1 }} />;
}
