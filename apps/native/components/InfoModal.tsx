import React, { useState } from 'react';
import { Modal, View, Text, TouchableOpacity, ScrollView, StyleSheet, TouchableWithoutFeedback } from 'react-native';
import { useStyles } from '../app/ThemeContext';

export interface InfoModalTab {
    id: string;
    label: string;
    content: React.ReactNode;
}

export interface InfoModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    icon: React.ReactNode;
    tabs: InfoModalTab[];
    defaultTab?: string;
}

export function InfoModal({ isOpen, onClose, title, icon, tabs, defaultTab }: InfoModalProps) {
    const [activeTab, setActiveTab] = useState<string>(defaultTab || (tabs.length > 0 ? tabs[0].id : ''));
    const styles = useStyles(({ colors }) => StyleSheet.create({
        overlay: {
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.6)',
            justifyContent: 'flex-end',
        },
        backdrop: {
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
        },
        modalContainer: {
            backgroundColor: colors.surface.card,
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            height: '90%',
        },
        header: {
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: 24,
            paddingBottom: 16,
            borderBottomWidth: 1,
            borderBottomColor: colors.border.default,
        },
        headerTitleContainer: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
        },
        headerIconContainer: {
            justifyContent: 'center',
            alignItems: 'center',
        },
        headerTitle: {
            fontSize: 20,
            fontWeight: 'bold',
            color: colors.text.heading,
        },
        closeButton: {
            padding: 8,
        },
        closeButtonText: {
            color: colors.text.muted,
            fontSize: 20,
            fontWeight: 'bold',
        },
        tabWrapper: {
            borderBottomWidth: 1,
            borderBottomColor: colors.border.default,
        },
        tabContainer: {
            flexDirection: 'row',
            paddingHorizontal: 16,
            paddingTop: 16,
            paddingBottom: 12,
        },
        tabButton: {
            paddingVertical: 12,
            paddingHorizontal: 16,
            marginRight: 8,
            borderRadius: 8,
        },
        tabButtonActive: {
            backgroundColor: colors.brand.tint,
        },
        tabText: {
            color: colors.text.secondary,
            fontWeight: '600',
            fontSize: 14,
        },
        tabTextActive: {
            color: colors.brand.primary,
        },
        scrollView: {
            flex: 1,
        },
        contentContainerStyle: {
            padding: 24,
        },
    }));

    React.useEffect(() => {
        if (isOpen && defaultTab) {
            setActiveTab(defaultTab);
        }
    }, [isOpen, defaultTab]);

    if (!isOpen) return null;

    return (
        <Modal
            visible={isOpen}
            transparent={true}
            animationType="slide"
            onRequestClose={onClose}
        >
            <View style={styles.overlay}>
                <TouchableWithoutFeedback onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
                    <View style={styles.backdrop} />
                </TouchableWithoutFeedback>

                <View style={styles.modalContainer}>
                    {/* Header */}
                    <View style={styles.header}>
                        <View style={styles.headerTitleContainer}>
                            <View style={styles.headerIconContainer}>{icon}</View>
                            <Text style={styles.headerTitle}>{title}</Text>
                        </View>
                        <TouchableOpacity onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" style={styles.closeButton}>
                            <Text style={styles.closeButtonText}>✕</Text>
                        </TouchableOpacity>
                    </View>

                    {/* Tabs */}
                    {tabs.length > 1 && (
                        <View style={styles.tabWrapper}>
                            <ScrollView
                                horizontal
                                showsHorizontalScrollIndicator={false}
                                contentContainerStyle={styles.tabContainer}
                            >
                                {tabs.map(tab => (
                                    <TouchableOpacity
                                        key={tab.id}
                                        style={[
                                            styles.tabButton,
                                            activeTab === tab.id && styles.tabButtonActive
                                        ]}
                                        accessibilityRole="button"
                                        accessibilityState={{ selected: activeTab === tab.id }}
                                        onPress={() => setActiveTab(tab.id)}
                                    >
                                        <Text style={[
                                            styles.tabText,
                                            activeTab === tab.id && styles.tabTextActive
                                        ]}>{tab.label}</Text>
                                    </TouchableOpacity>
                                ))}
                            </ScrollView>
                        </View>
                    )}

                    {/* Content */}
                    <ScrollView 
                        style={styles.scrollView} 
                        contentContainerStyle={styles.contentContainerStyle} 
                        showsVerticalScrollIndicator={false}
                    >
                        {tabs.find(t => t.id === activeTab)?.content}
                    </ScrollView>
                </View>
            </View>
        </Modal>
    );
}

