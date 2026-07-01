import * as Haptics from 'expo-haptics';

/** Deal done, escrow released, transfer sent — the "payday" pulse */
export const hapticSuccess = () =>
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

/** Gate rejection, error, cancelled escrow — the "stop" buzz */
export const hapticWarning = () =>
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);

/** Clipboard copy, avatar pick, vote stepper tap — the "tick" */
export const hapticTick = () =>
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
