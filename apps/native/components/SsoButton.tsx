import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View, Platform, StyleProp, ViewStyle, TextStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';

export function GoogleLogo({ size = 20 }: { size?: number }) {
    return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
            <Path
                fill="#4285F4"
                d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17z"
            />
            <Path
                fill="#34A853"
                d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.25v3.15C3.26 21.36 7.34 24 12 24z"
            />
            <Path
                fill="#FBBC05"
                d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.25C.45 8.18 0 10.03 0 12s.45 3.82 1.25 5.42l4.03-3.15z"
            />
            <Path
                fill="#EA4335"
                d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.34 0 3.26 2.64 1.25 6.58l4.03 3.15c.95-2.83 3.6-4.98 6.72-4.98z"
            />
        </Svg>
    );
}

export function AppleLogo({ size = 18, color = '#FFFFFF' }: { size?: number; color?: string }) {
    return (
        <Svg width={size} height={size} viewBox="0 0 170 170">
            <Path
                fill={color}
                d="M150.37 130.25c-2.45 5.66-5.35 10.87-8.71 15.66-4.58 6.53-8.33 11.05-11.22 13.56-4.48 4.12-9.28 6.23-14.42 6.35-3.69 0-8.14-1.05-13.32-3.18-5.19-2.12-9.97-3.17-14.34-3.17-4.58 0-9.49 1.05-14.75 3.17-5.26 2.13-9.5 3.24-12.74 3.35-4.35.13-9.16-1.9-14.42-6.08-3.7-3.04-7.6-7.77-11.72-14.2-5.77-8.91-10.4-18.7-13.88-29.35-3.48-10.66-5.22-21.2-5.22-31.63 0-14.35 3.58-26.63 10.74-36.85 7.17-10.22 16.52-15.44 28.06-15.66 4.9.11 10.44 1.3 16.63 3.59 6.19 2.28 10.12 3.48 11.78 3.59 1.77-.22 5.99-1.52 12.65-3.91 6.66-2.39 12.28-3.42 16.85-3.1 12.82.76 22.93 5.49 30.32 14.2-11.19 6.85-16.68 16.3-16.47 28.37.22 9.57 3.86 17.55 10.92 23.97 7.07 6.41 15.49 10.05 25.27 10.92-2.17 6.52-4.67 13.04-7.5 19.57zm-31.72-108.6c0-6.74 2.45-13.15 7.34-19.24 4.9-6.09 11.08-9.95 18.53-11.58.22 1.3.33 2.5.33 3.59 0 6.63-2.61 13.15-7.83 19.57-5.22 6.41-11.52 10.27-18.91 11.58-.33-1.09-.46-2.4-.46-3.92z"
            />
        </Svg>
    );
}

export function GoogleButton({
    onPress,
    title = 'Protect with Google',
    disabled = false,
    accessibilityHint,
    style,
    textStyle,
}: {
    onPress: () => void;
    title?: string;
    disabled?: boolean;
    accessibilityHint?: string;
    style?: StyleProp<ViewStyle>;
    textStyle?: StyleProp<TextStyle>;
}) {
    return (
        <TouchableOpacity
            style={[styles.googleBtn, disabled && styles.disabled, style]}
            onPress={onPress}
            disabled={disabled}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={title}
            accessibilityHint={accessibilityHint}
            accessibilityState={{ disabled }}
        >
            <View style={styles.iconContainer}>
                <GoogleLogo size={20} />
            </View>
            <Text style={[styles.googleBtnText, textStyle]}>{title}</Text>
        </TouchableOpacity>
    );
}

export function AppleButton({
    onPress,
    title = 'Protect with Apple',
    disabled = false,
    accessibilityHint,
    style,
    textStyle,
}: {
    onPress: () => void;
    title?: string;
    disabled?: boolean;
    accessibilityHint?: string;
    style?: StyleProp<ViewStyle>;
    textStyle?: StyleProp<TextStyle>;
}) {
    return (
        <TouchableOpacity
            style={[styles.appleBtn, disabled && styles.disabled, style]}
            onPress={onPress}
            disabled={disabled}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={title}
            accessibilityHint={accessibilityHint}
            accessibilityState={{ disabled }}
        >
            <View style={styles.iconContainer}>
                <AppleLogo size={18} color="#FFFFFF" />
            </View>
            <Text style={[styles.appleBtnText, textStyle]}>{title}</Text>
        </TouchableOpacity>
    );
}

export function FacebookLogo({ size = 20 }: { size?: number }) {
    return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
            <Path
                fill="#1877F2"
                d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"
            />
        </Svg>
    );
}

export function GitHubLogo({ size = 20, color = '#24292F' }: { size?: number; color?: string }) {
    return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
            <Path
                fill={color}
                d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"
            />
        </Svg>
    );
}

export function FacebookButton({
    onPress,
    title = 'Protect with Facebook',
    disabled = false,
    accessibilityHint,
    style,
    textStyle,
}: {
    onPress: () => void;
    title?: string;
    disabled?: boolean;
    accessibilityHint?: string;
    style?: StyleProp<ViewStyle>;
    textStyle?: StyleProp<TextStyle>;
}) {
    return (
        <TouchableOpacity
            style={[styles.facebookBtn, disabled && styles.disabled, style]}
            onPress={onPress}
            disabled={disabled}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={title}
            accessibilityHint={accessibilityHint}
            accessibilityState={{ disabled }}
        >
            <View style={styles.iconContainer}>
                <FacebookLogo size={20} />
            </View>
            <Text style={[styles.facebookBtnText, textStyle]}>{title}</Text>
        </TouchableOpacity>
    );
}

export function GitHubButton({
    onPress,
    title = 'Protect with GitHub',
    disabled = false,
    accessibilityHint,
    style,
    textStyle,
}: {
    onPress: () => void;
    title?: string;
    disabled?: boolean;
    accessibilityHint?: string;
    style?: StyleProp<ViewStyle>;
    textStyle?: StyleProp<TextStyle>;
}) {
    return (
        <TouchableOpacity
            style={[styles.githubBtn, disabled && styles.disabled, style]}
            onPress={onPress}
            disabled={disabled}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={title}
            accessibilityHint={accessibilityHint}
            accessibilityState={{ disabled }}
        >
            <View style={styles.iconContainer}>
                <GitHubLogo size={20} color="#24292F" />
            </View>
            <Text style={[styles.githubBtnText, textStyle]}>{title}</Text>
        </TouchableOpacity>
    );
}

const styles = StyleSheet.create({
    googleBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#FFFFFF',
        borderWidth: 1,
        borderColor: '#DADCE0',
        borderRadius: 12,
        paddingVertical: 14,
        paddingHorizontal: 16,
        minHeight: 48,
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.08,
        shadowRadius: 2,
        elevation: 1,
    },
    googleBtnText: {
        color: '#1F1F1F',
        fontSize: 15,
        fontWeight: '600',
        textAlign: 'center',
    },
    appleBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#000000',
        borderWidth: 1,
        borderColor: '#333333',
        borderRadius: 12,
        paddingVertical: 14,
        paddingHorizontal: 16,
        minHeight: 48,
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.15,
        shadowRadius: 2,
        elevation: 1,
    },
    appleBtnText: {
        color: '#FFFFFF',
        fontSize: 15,
        fontWeight: '600',
        textAlign: 'center',
    },
    iconContainer: {
        marginRight: 10,
        alignItems: 'center',
        justifyContent: 'center',
    },
    facebookBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#FFFFFF',
        borderWidth: 1,
        borderColor: '#1877F2',
        borderRadius: 12,
        paddingVertical: 14,
        paddingHorizontal: 16,
        minHeight: 48,
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.08,
        shadowRadius: 2,
        elevation: 1,
    },
    facebookBtnText: {
        color: '#1877F2',
        fontSize: 15,
        fontWeight: '600',
        textAlign: 'center',
    },
    githubBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#F6F8FA',
        borderWidth: 1,
        borderColor: '#D0D7DE',
        borderRadius: 12,
        paddingVertical: 14,
        paddingHorizontal: 16,
        minHeight: 48,
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.08,
        shadowRadius: 2,
        elevation: 1,
    },
    githubBtnText: {
        color: '#24292F',
        fontSize: 15,
        fontWeight: '600',
        textAlign: 'center',
    },
    disabled: {
        opacity: 0.6,
    },
});
