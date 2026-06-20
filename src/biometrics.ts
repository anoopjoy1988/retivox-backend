import { NativeBiometric } from '@capgo/capacitor-native-biometric';
import { Capacitor } from '@capacitor/core';

const SERVER_NAME = 'retivox.app';
const BIOMETRIC_ENABLED_KEY = 'retivox_biometric_enabled';
const SIMULATED_CREDS_KEY = 'retivox_simulated_biometric_creds';

export async function isBiometricsAvailable(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) {
    // Web Simulation: Biometrics are always supported for developers to preview and test.
    return true;
  }
  try {
    const result = await NativeBiometric.isAvailable();
    return !!result.isAvailable;
  } catch (error) {
    console.warn('Biometric hardware check notice:', error);
    return false;
  }
}

export function hasStoredBiometrics(): boolean {
  return localStorage.getItem(BIOMETRIC_ENABLED_KEY) === 'true';
}

export async function enableBiometrics(email: string, pass: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    // Web Simulation: Store credentials in base64 locally for demonstration/testing ease.
    localStorage.setItem(BIOMETRIC_ENABLED_KEY, 'true');
    const encrypted = btoa(JSON.stringify({ email, pass }));
    localStorage.setItem(SIMULATED_CREDS_KEY, encrypted);
    return;
  }

  // Native Platform: Store in device secure enclave (Keystore / Keychain)
  try {
    await NativeBiometric.setCredentials({
      username: email,
      password: pass,
      server: SERVER_NAME,
    });
    localStorage.setItem(BIOMETRIC_ENABLED_KEY, 'true');
  } catch (error: any) {
    console.error('Failed to save credentials natively:', error);
    throw new Error(error.message || 'Failed to save biometric credentials.');
  }
}

export async function disableBiometrics(): Promise<void> {
  localStorage.removeItem(BIOMETRIC_ENABLED_KEY);
  localStorage.removeItem(SIMULATED_CREDS_KEY);

  if (Capacitor.isNativePlatform()) {
    try {
      await NativeBiometric.deleteCredentials({
        server: SERVER_NAME,
      });
    } catch (error) {
      console.warn('Native biometric credentials deletion notice:', error);
    }
  }
}

export interface BiometricCredentials {
  email: string;
  pass: string;
}

export async function getStoredCredentials(): Promise<BiometricCredentials> {
  if (!Capacitor.isNativePlatform()) {
    // Web Simulation: Retrieve from localStorage
    const stored = localStorage.getItem(SIMULATED_CREDS_KEY);
    if (!stored) {
      throw new Error('No simulated credentials stored.');
    }
    try {
      const decrypted = JSON.parse(atob(stored));
      return {
        email: decrypted.email,
        pass: decrypted.pass,
      };
    } catch (e) {
      throw new Error('Failed to parse simulated credentials.');
    }
  }

  // Native Platform: Verify biometric credentials via secure prompt
  try {
    await NativeBiometric.verifyIdentity({
      reason: 'Access your account securely',
      title: 'Biometric Sign In',
      subtitle: 'Scan your fingerprint or face to log in',
      description: 'RetivoX secure authentication',
    });

    const creds = await NativeBiometric.getCredentials({
      server: SERVER_NAME,
    });

    if (!creds.username || !creds.password) {
      throw new Error('Credentials retrieval failed or empty.');
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
