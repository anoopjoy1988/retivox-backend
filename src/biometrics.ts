import { NativeBiometric } from '@capgo/capacitor-native-biometric';
import { Capacitor } from '@capacitor/core';

const SERVER_NAME = 'retivox.app';
const BIOMETRIC_ENABLED_KEY = 'retivox_biometric_enabled';

export type BiometricRole = 'admin' | 'partner';

export function getBiometricKey(role: BiometricRole = 'partner'): string {
  return `retivox_${role}_biometric_enabled`;
}

export function getServerName(role: BiometricRole = 'partner'): string {
  return `retivox.app.${role}`;
}

export async function isBiometricsAvailable(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) {
    return false;
  }
  try {
    const result = await NativeBiometric.isAvailable();
    return !!result.isAvailable;
  } catch (error) {
    console.warn('Biometric hardware check notice:', error);
    return false;
  }
}

export function hasStoredBiometrics(role?: BiometricRole): boolean {
  if (role) {
    return localStorage.getItem(getBiometricKey(role)) === 'true' || localStorage.getItem(BIOMETRIC_ENABLED_KEY) === 'true';
  }
  return localStorage.getItem(getBiometricKey('admin')) === 'true' || 
         localStorage.getItem(getBiometricKey('partner')) === 'true' || 
         localStorage.getItem(BIOMETRIC_ENABLED_KEY) === 'true';
}

export async function enableBiometrics(email: string, pass: string, role: BiometricRole = 'partner'): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    throw new Error('Biometric authentication is only available on mobile devices.');
  }

  const server = getServerName(role);
  try {
    await NativeBiometric.setCredentials({
      username: email,
      password: pass,
      server,
    });
    localStorage.setItem(getBiometricKey(role), 'true');
    localStorage.setItem(BIOMETRIC_ENABLED_KEY, 'true');
  } catch (error: any) {
    console.error('Failed to save credentials natively:', error);
    throw new Error(error.message || 'Failed to save biometric credentials.');
  }
}

export async function disableBiometrics(role?: BiometricRole): Promise<void> {
  if (role) {
    localStorage.removeItem(getBiometricKey(role));
  } else {
    localStorage.removeItem(getBiometricKey('admin'));
    localStorage.removeItem(getBiometricKey('partner'));
    localStorage.removeItem(BIOMETRIC_ENABLED_KEY);
  }

  if (Capacitor.isNativePlatform()) {
    try {
      if (role) {
        await NativeBiometric.deleteCredentials({ server: getServerName(role) });
      } else {
        await NativeBiometric.deleteCredentials({ server: getServerName('admin') }).catch(() => {});
        await NativeBiometric.deleteCredentials({ server: getServerName('partner') }).catch(() => {});
        await NativeBiometric.deleteCredentials({ server: SERVER_NAME }).catch(() => {});
      }
    } catch (error) {
      console.warn('Native biometric credentials deletion notice:', error);
    }
  }
}

export interface BiometricCredentials {
  email: string;
  pass: string;
}

export async function getStoredCredentials(role: BiometricRole = 'partner'): Promise<BiometricCredentials> {
  if (!Capacitor.isNativePlatform()) {
    throw new Error('Biometric authentication is only available on mobile devices.');
  }

  try {
    await NativeBiometric.verifyIdentity({
      reason: role === 'admin' ? 'Verify identity for Admin Portal' : 'Verify identity for Partner Portal',
      title: 'Biometric Sign In',
      subtitle: role === 'admin' ? 'Admin Access' : 'Partner Access',
      description: 'RetivoX secure authentication',
    });

    let creds: any = null;
    try {
      creds = await NativeBiometric.getCredentials({
        server: getServerName(role),
      });
    } catch (_) {
      // Fallback to legacy single server key if not yet migrated
      try {
        creds = await NativeBiometric.getCredentials({
          server: SERVER_NAME,
        });
      } catch (e) {
        creds = null;
      }
    }

    if (!creds || !creds.username || !creds.password) {
      throw new Error(`No saved biometric credentials found for ${role}. Please sign in with PIN once.`);
    }

    return {
      email: creds.username,
      pass: creds.password,
    };
  } catch (error: any) {
    console.error('Native biometric login failed:', error);
    throw new Error(error.message || 'Biometric authentication cancelled or failed.');
  }
}
