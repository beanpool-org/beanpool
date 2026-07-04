import { Platform } from 'react-native';
import Constants from 'expo-constants';

export const HAS_MAPS_KEY = Platform.OS !== 'android' || 
    !!(Constants.expoConfig?.android?.config?.googleMaps?.apiKey || Constants.expoConfig?.extra?.googleMapsApiKey);
