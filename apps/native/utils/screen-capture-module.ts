/**
 * expo-screen-capture, loaded on first use, or null where it can't load.
 *
 * Its entry point asks for the native module as it is imported (requireNativeModule), which throws in a build made
 * before the module was added (an older development build). Imported at the top of a screen, that would stop the
 * screen, and the app, from opening. Loaded here instead, such a build opens as before and only goes without the
 * block (words-on-screen.ts). On the web the package loads and its calls reject, which words-on-screen.ts ignores.
 */
export interface ScreenCaptureApi {
    preventScreenCaptureAsync(key?: string): Promise<void>;
    allowScreenCaptureAsync(key?: string): Promise<void>;
}

let loaded: ScreenCaptureApi | null | undefined;

export function loadScreenCapture(): ScreenCaptureApi | null {
    if (loaded === undefined) {
        try {
            loaded = require('expo-screen-capture') as ScreenCaptureApi;
        } catch {
            loaded = null;
        }
    }
    return loaded;
}
