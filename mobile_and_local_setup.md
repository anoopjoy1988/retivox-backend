# RetivoX: Local Testing and Android Build Guide

This document provides step-by-step instructions to run RetivoX in a local environment for testing, and to build and sign the native Android mobile app using Capacitor.

---

## Part 1: Local Development & Testing

To run the application locally (both the Express backend and the Vite React frontend dev server):

### 1. Prerequisites
* **Node.js**: Version 20.x or newer.
* **Firebase Project**: A Firebase project initialized with Firestore and Firebase Authentication.

### 2. Install Dependencies
In the root directory of the project, run:
```bash
npm install
```

### 3. Setup Environment Variables
Confirm your [.env](file:///c:/Users/Anoop/antigravity/RetivoX/.env) file is configured with your API credentials. The key variables are:
* `VITE_FCM_VAPID_KEY`: Web Push/FCM public key.
* `VAPID_PRIVATE_KEY`: Web Push private key.
* `GOOGLE_WALLET_ISSUER_ID`: Your Google Wallet Merchant Issuer ID.
* `GOOGLE_WALLET_SERVICE_ACCOUNT_KEY`: Your service account JSON credentials.
* `GEMINI_API_KEY`: Gemini API key for AI logic.

### 4. Run the Development Server
Launch the combined Express/Vite server:
```bash
npm run dev
```
The application will be accessible at **`http://localhost:3000`**. 
* The React client SPA will reload automatically on any changes to `src/`.
* The server-side API endpoints (like `/api/wallet/generate-pass`) will be active.

---

## Part 2: Building and Packaging the Android App

RetivoX uses **Capacitor** to build a native Android app wrapper around the compiled web assets.

### 1. Prerequisites
* **JDK 17**: Ensure Java Development Kit 17 is installed.
* **Android Studio**: Installed with SDK platforms and command-line tools matching your system.

### 2. Compile Web Assets and Sync to Android
Whenever you modify your React code in `src/`, compile and sync the changes to the Android native folder by running:
```bash
npm run cap:sync
```
*This command runs `npm run build` to generate the static files in `dist/`, then calls `npx cap sync` to copy those assets into the native Android folder structure (`android/app/src/main/assets/public`).*

### 3. Open the Project in Android Studio
Open the synchronized project folder in Android Studio:
```bash
npm run cap:open
```
*Alternatively, you can open Android Studio and choose the `c:\Users\Anoop\antigravity\RetivoX\android` folder.*

### 4. Build a Debug APK (For Testing)
To build a debug APK to test on a physical device or emulator:
1. In Android Studio, wait for Gradle to finish syncing the project.
2. Select **Build > Build Bundle(s) / APK(s) > Build APK(s)** from the top menu.
3. Once the build completes, a popup will appear at the bottom right. Click **Locate** to find the `app-debug.apk` file.

### 5. Build and Sign a Release Bundle (For Play Store / Production)
To publish the app, you must generate a signed release Android App Bundle (`.aab`):
1. In Android Studio, select **Build > Generate Signed Bundle / APK...**.
2. Select **Android App Bundle** and click **Next**.
3. **Key Store Configuration**:
   * If you don't have a Keystore, click **Create new...**, choose a path (e.g. `retivox.jks`), and set passwords, alias (e.g. `retivox-key`), and certificate details.
   * If you have an existing one, click **Choose existing...** and enter your credentials.
4. Click **Next**.
5. Select **release** as the Build Variant and click **Create**.
6. Once completed, locate the signed `.aab` file under `android/app/release/`. This is the file you upload to the Google Play Console.
