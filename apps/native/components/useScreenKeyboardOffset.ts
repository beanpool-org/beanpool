/**
 * The `keyboardVerticalOffset` a composer screen's KeyboardAvoidingView needs, and the onLayout that measures it: put
 * `onScreenLayout` on the screen's root view (the KeyboardAvoidingView itself when it is the root) and pass
 * `keyboardVerticalOffset` to the KeyboardAvoidingView. 0 for a full-screen screen; the sheet's top on an iPhone page
 * sheet, where the keyboard otherwise covered the message box (utils/screen-keyboard-offset.ts).
 *
 * The window's height is keyboard-controller's own, the one its KeyboardAvoidingView reads, so the two always agree.
 */
import { useCallback, useState } from 'react';
import { Platform, type LayoutChangeEvent } from 'react-native';
import { useWindowDimensions } from 'react-native-keyboard-controller';
import { screenKeyboardOffset } from '../utils/screen-keyboard-offset';

export function useScreenKeyboardOffset(): { keyboardVerticalOffset: number; onScreenLayout: (e: LayoutChangeEvent) => void } {
    const { height: windowHeight } = useWindowDimensions();
    const [screenHeight, setScreenHeight] = useState(0);
    const onScreenLayout = useCallback((e: LayoutChangeEvent) => {
        const { y, height } = e.nativeEvent.layout;
        const h = Math.round(y + height);
        setScreenHeight((prev) => (prev === h ? prev : h));
    }, []);
    return { keyboardVerticalOffset: screenKeyboardOffset({ os: Platform.OS, windowHeight, screenHeight }), onScreenLayout };
}
