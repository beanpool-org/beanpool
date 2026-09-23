/**
 * The window's soft-input mode, for a chat screen.
 *
 * Lifted verbatim out of the DM screen so a group, enterprise or event chat gets the same keyboard
 * behaviour the DM has always had, instead of a second, subtly different one. It is called from the
 * chat SCREEN (not from ChatMessageList), because the DM's list mounts only after the first read and
 * the mode has to be set when the screen mounts — the timing main's DM has.
 */
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { KeyboardController, AndroidSoftInputModes } from 'react-native-keyboard-controller';

export function useChatSoftInputMode() {
    // On Android, tell the OS not to resize/pan the window when the keyboard
    // opens. This makes react-native-keyboard-controller's KeyboardAvoidingView
    // the sole owner of keyboard compensation — eliminating the intermittent
    // race where Android's OS-level resize and the library's padding would
    // double-compensate or mis-time, hiding the input bar.
    useEffect(() => {
        if (Platform.OS === 'android') {
            KeyboardController.setInputMode(AndroidSoftInputModes.SOFT_INPUT_ADJUST_NOTHING);
        }
        return () => {
            if (Platform.OS === 'android') {
                KeyboardController.setDefaultMode();
            }
        };
    }, []);
}
