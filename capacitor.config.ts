import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.retivox.loyalty',
  appName: 'RetivoX',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    hostname: 'localhost'
  }
};

export default config;
