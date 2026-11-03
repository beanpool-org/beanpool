/**
 * A FlatList's scroll view that keeps the field being typed in above the keyboard (keyboard audit 3 Nov, groups B and E).
 *
 * The library's own recipe for a FlatList: pass its KeyboardAwareScrollView as `renderScrollComponent`. It scrolls the
 * focused field above the keyboard and pads the list by the keyboard's height itself, so a screen that uses it needs no
 * KeyboardAvoidingView and no hand-made keyboard-height padding. This is only that wiring, not a second keyboard helper:
 * the behaviour is the library's. Defined once at module level so a list keeps the same scroll view across renders.
 */
import React from 'react';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';

export const keyboardAwareList = (props: any) => <KeyboardAwareScrollView {...props} bottomOffset={24} />;
