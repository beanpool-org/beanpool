/**
 * Top inset for the header of a `<Modal presentationStyle="pageSheet">`.
 *
 * Android ignores pageSheet: the Modal is a full-screen window, and since Expo 55 draws edge-to-edge it
 * starts at the very top of the display, so a header with no inset sits under the status bar (Cancel
 * behind the wifi icons, the right-hand button behind the battery). It needs the whole status-bar inset.
 *
 * iOS presents a real page sheet that already starts below the status bar. `useSafeAreaInsets()` still
 * reports the window's inset there, so applying it would push the header down a second time.
 *
 * Only for pageSheet modals. A transparent bottom sheet never reaches the status bar and takes no top inset.
 */
export function pageSheetTopInset(os: string, insetsTop: number): number {
    return os === 'android' ? insetsTop : 0;
}
