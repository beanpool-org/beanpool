/**
 * How far below the window's top a screen starts: the `keyboardVerticalOffset` every composer screen's KeyboardAvoidingView
 * takes (components/useScreenKeyboardOffset.ts).
 *
 * react-native-keyboard-controller's KeyboardAvoidingView (1.20.7) pads by
 *   frame.y + frame.height − (windowHeight − keyboardHeight − keyboardVerticalOffset)
 * with `frame` read from onLayout, in its PARENT's frame. That is right only when the screen starts at the window's top.
 * On an iPhone a screen can be presented as a page sheet: post/[id] and public-profile are sheets, native-stack
 * presents any route without a presentation of its own that is pushed after a sheet as a sheet too
 * (@react-navigation/native-stack getModalRouteKeys), and an RN Modal with presentationStyle="pageSheet" (New Event,
 * New Poll) is one as well. So a DM opened from a listing starts some 50 pt down the window,
 * and the padding came up short by exactly that: the keyboard covered the message box with the About bar sitting on the
 * keyboard (Rob, iPhone, 17 Nov).
 *
 * An iPhone sheet's bottom is the window's bottom (the app is iPhone only: app.json supportsTablet false, so no iPad form
 * sheet floats mid-window), so the screen's top in the window is the window's height less the screen's. Fabric's
 * measureInWindow can't say it: it reads the shadow tree, which has no idea where UIKit put the sheet.
 *
 * Android has no sheets (native-stack's modal there is a full-screen push), so the offset there stays 0: exactly what
 * every chat has always had on Android.
 */
export function screenKeyboardOffset(p: { os: string; windowHeight: number; screenHeight: number }): number {
    if (p.os !== 'ios') return 0;
    // Not measured yet: no offset, as before (the first layout comes long before anyone can type).
    if (!(p.screenHeight > 0) || !(p.windowHeight > 0)) return 0;
    return Math.max(0, Math.round(p.windowHeight - p.screenHeight));
}

/**
 * The library's own padding (react-native-keyboard-controller KeyboardAvoidingView, behavior "padding", 1.20.7), for the
 * table test that models where the composer lands (utils/__tests__/composer-above-keyboard.test.ts).
 */
export function keyboardViewPadding(p: { frameY: number; frameHeight: number; windowHeight: number; keyboardHeight: number; keyboardVerticalOffset: number }): number {
    const keyboardY = p.windowHeight - p.keyboardHeight - p.keyboardVerticalOffset;
    return Math.max(p.frameY + p.frameHeight - keyboardY, 0);
}
