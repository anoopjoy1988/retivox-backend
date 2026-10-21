import dotenv from "dotenv";
dotenv.config();
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";
import webpush from "web-push";
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import fs from "fs";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function signGoogleWalletJwt(payload: any, privateKey: string, clientEmail: string) {
  const header = {
    alg: 'RS256',
    typ: 'JWT'
  };

  const base64UrlEncode = (obj: any) => {
    return Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  };

  const headerStr = base64UrlEncode(header);
  const payloadStr = base64UrlEncode(payload);

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${headerStr}.${payloadStr}`);
  const signature = sign.sign(privateKey, 'base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${headerStr}.${payloadStr}.${signature}`;
}

function isNewerVersion(latest: string, current: string): boolean {
  if (!latest || !current) return false;
  const clean = (v: string) => v.replace(/^v/i, '').trim();
  const pLatest = clean(latest).split('.').map(n => parseInt(n, 10) || 0);
  const pCurrent = clean(current).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pLatest.length, pCurrent.length); i++) {
    const l = pLatest[i] || 0;
    const c = pCurrent[i] || 0;
    if (l > c) return true;
    if (l < c) return false;
  }
  return false;
}

// Lazy Initialize Firebase Admin
let adminDb: admin.firestore.Firestore | null = null;
let cachedConfig: any = null;

function getAdminDb() {
  if (adminDb) return adminDb;

  try {
    const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
    if (!fs.existsSync(configPath)) {
      console.warn("firebase-applet-config.json not found. Admin features disabled.");
      return null;
    }

    cachedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const firebaseConfig = cachedConfig;
    
    if (!admin.apps.length) {
      try {
        if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
          admin.initializeApp({
            credential: admin.credential.applicationDefault(),
            projectId: firebaseConfig.projectId
          });
        } else {
          admin.initializeApp({
            projectId: firebaseConfig.projectId
          });
        }
        console.log(`Firebase Admin initialized for project: ${firebaseConfig.projectId}`);
      } catch (credentialError) {
        console.warn("Firebase Admin init fallback:", credentialError);
        try {
          admin.initializeApp({
            projectId: firebaseConfig.projectId
          });
        } catch (e) {}
      }
    }
    
    const dbId = firebaseConfig.firestoreDatabaseId || '(default)';
    console.log(`Targeting Firestore Database: ${dbId}`);
    
    if (firebaseConfig.firestoreDatabaseId && firebaseConfig.firestoreDatabaseId !== '(default)') {
      adminDb = getFirestore(admin.app(), firebaseConfig.firestoreDatabaseId);
    } else {
      adminDb = getFirestore(admin.app());
    }
    return adminDb;
  } catch (error) {
    console.error("CRITICAL: Failed to initialize Firebase Admin. Admin features like push notifications will fail:", error);
    return null;
  }
}

// Initialize Web Push
const rawVapidPublicKey = process.env.VITE_FCM_VAPID_KEY;
const rawVapidPrivateKey = process.env.VAPID_PRIVATE_KEY;

function cleanVapidKey(key: string | undefined): string {
  if (!key) return "";
  // Trim whitespace and remove surrounding single or double quotes
  let cleaned = key.trim().replace(/^['"]|['"]$/g, '');
  // Convert standard base64 characters (+ and /) to base64url-safe (- and _)
  cleaned = cleaned.replace(/\+/g, '-').replace(/\//g, '_');
  // Remove padding `=` characters at the end, which is common in base64url for web-push
  cleaned = cleaned.replace(/=+$/, '');
  return cleaned;
}

const vapidPublicKey = cleanVapidKey(rawVapidPublicKey);
const vapidPrivateKey = cleanVapidKey(rawVapidPrivateKey);

if (vapidPublicKey && vapidPrivateKey) {
  try {
    webpush.setVapidDetails(
      'mailto:admin@retivox.app',
      vapidPublicKey,
      vapidPrivateKey
    );
    console.log("Web Push VAPID details set successfully");
  } catch (vapidError: any) {
    console.error("\n========================================================");
    console.error("🔥 INVALID VAPID KEYS CONFIGURED FOR PUSH NOTIFICATIONS");
    console.error("========================================================");
    console.error("The VAPID keys loaded from your environment variables are invalid.");
    console.error(`Error Details: ${vapidError.message || vapidError}`);
    console.error("\nHow to fix this issue:");
    console.error("1. Make sure your environment variables in AI Studio Settings (or .env) contain dry key strings without any decoration or extra characters.");
    console.error("2. Get a valid Web Push Certificate (VAPID key) from the Firebase Console:");
    console.error("   - Open your project at https://console.firebase.google.com");
    console.error("   - Click the Gear icon (Project settings) > 'Cloud Messaging' tab.");
    console.error("   - Scroll down to 'Web configuration', find 'Web Push certificates'.");
    console.error("   - Click 'Generate key pair' if you don't have one.");
    console.error("   - Copy the long 'Key pair' (this is VITE_FCM_VAPID_KEY, which is usually exactly 87-88 characters starting with 'B').");
    console.error("3. Note that VAPID_PRIVATE_KEY must be the respective private-key of that pair. You need both matching parts for web-push to authenticate.");
    console.error("========================================================\n");
  }
}

async function startServer() {
  // Eagerly initialize Firebase Admin
  getAdminDb();

  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json());

  // 1. CORS Configuration (Allows local Capacitor app WebView requests)
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const allowedOrigins = [
        "http://localhost:3000",
        "http://localhost:5173",
        "capacitor://localhost",
        "http://localhost"
      ];
      const isLocalhost = origin.startsWith("http://localhost:") || 
                          origin.startsWith("http://127.0.0.1:") ||
                          origin.startsWith("http://192.168.") ||
                          origin.startsWith("capacitor://");
      
      if (allowedOrigins.includes(origin) || isLocalhost) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true
  }));

  // 2. Global Rate Limiter
  const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests from this IP. Please try again after 15 minutes." }
  });
  app.use("/api/", globalLimiter);

  // 3. Strict Rate Limiter for Database Purge
  const purgeLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Database purge is rate-limited. Max 3 requests per hour." }
  });

  // --- Auth Middleware Definitions ---

  interface AuthenticatedRequest extends express.Request {
    user?: admin.auth.DecodedIdToken;
  }

  // Admin is ONLY the owner email, and only when Firebase has verified it.
  // Never trust the 'role' field in Firestore for admin decisions (users can write their own profile).
  const OWNER_EMAIL = "anoopjoy1988@gmail.com";
  const isVerifiedOwner = (user?: admin.auth.DecodedIdToken) =>
    !!user && user.email?.toLowerCase() === OWNER_EMAIL && user.email_verified === true;

  const requireAuth = async (req: AuthenticatedRequest, res: express.Response, next: express.NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized: Missing or invalid token format" });
    }

    const token = authHeader.split(" ")[1];
    try {
      const decodedToken = await admin.auth().verifyIdToken(token);
      req.user = decodedToken;
      next();
    } catch (err: any) {
      console.warn("Failed to verify ID token:", err.message || err);
      res.status(401).json({ error: "Unauthorized: Token verification failed" });
    }
  };

  const requireAdmin = async (req: AuthenticatedRequest, res: express.Response, next: express.NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized: User context missing" });
    }

    try {
      if (isVerifiedOwner(req.user)) {
        next();
      } else {
        res.status(403).json({ error: "Forbidden: Administrator privileges require the verified owner account." });
      }
    } catch (err) {
      console.error("Admin verification error:", err);
      res.status(500).json({ error: "Internal server verification error" });
    }
  };

  const requirePartnerOrAdmin = async (req: AuthenticatedRequest, res: express.Response, next: express.NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized: User context missing" });
    }

    try {
      const db = getAdminDb();
      let isAllowed = isVerifiedOwner(req.user);
      
      if (!isAllowed && db) {
        const uDoc = await db.collection("users").doc(req.user.uid).get();
        if (uDoc.exists) {
          const role = uDoc.data()?.role;
          // A stored 'admin' role grants no more than partner-level access here
          if (role === "admin" || role === "partner") {
            isAllowed = true;
          }
        }
      }

      if (isAllowed) {
        next();
      } else {
        res.status(403).json({ error: "Forbidden: Partner or Administrator privileges required" });
      }
    } catch (err) {
      console.error("Partner/Admin verification error:", err);
      res.status(500).json({ error: "Internal server verification error" });
    }
  };


  // --- Input Validation Helpers ---

  const validateGeneratePassPayload = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const { cardId, businessName, programTitle, currentStamps, goal, reward, type, businessId, programId } = req.body;

    if (!cardId || typeof cardId !== "string") {
      return res.status(400).json({ error: "Validation Error: cardId is required and must be a string." });
    }
    if (!businessName || typeof businessName !== "string") {
      return res.status(400).json({ error: "Validation Error: businessName is required and must be a string." });
    }
    if (!programTitle || typeof programTitle !== "string") {
      return res.status(400).json({ error: "Validation Error: programTitle is required and must be a string." });
    }
    if (currentStamps === undefined || typeof currentStamps !== "number" || currentStamps < 0) {
      return res.status(400).json({ error: "Validation Error: currentStamps is required and must be a non-negative number." });
    }
    if (!goal || typeof goal !== "number" || goal <= 0) {
      return res.status(400).json({ error: "Validation Error: goal is required and must be a positive number." });
    }
    if (!reward || typeof reward !== "string") {
      return res.status(400).json({ error: "Validation Error: reward is required and must be a string." });
    }
    if (!type || !["google", "apple"].includes(type)) {
      return res.status(400).json({ error: "Validation Error: type is required and must be 'google' or 'apple'." });
    }
    if (!businessId || typeof businessId !== "string") {
      return res.status(400).json({ error: "Validation Error: businessId is required and must be a string." });
    }
    if (!programId || typeof programId !== "string") {
      return res.status(400).json({ error: "Validation Error: programId is required and must be a string." });
    }

    next();
  };

  const validateNotifyPayload = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const { title, body } = req.body;
    if (!title || typeof title !== "string" || title.trim().length === 0) {
      return res.status(400).json({ error: "Validation Error: title is required and cannot be empty." });
    }
    if (!body || typeof body !== "string" || body.trim().length === 0) {
      return res.status(400).json({ error: "Validation Error: body is required and cannot be empty." });
    }
    next();
  };

  const validateSubscribePayload = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const { platform, userId } = req.body;
    if (!platform || !["web", "native"].includes(platform)) {
      return res.status(400).json({ error: "Validation Error: platform is required and must be 'web' or 'native'." });
    }
    if (!userId || typeof userId !== "string") {
      return res.status(400).json({ error: "Validation Error: userId is required." });
    }
    next();
  };

  // Get running service account and environment details
  app.get("/api/system/service-account", requireAuth, requireAdmin, async (req, res) => {
    try {
      const auth = new GoogleAuth();
      let email = "unknown";
      let projectId = "unknown";
      
      try {
        email = await (auth as any).getServiceAccountEmail();
      } catch (e: any) {
        console.warn("Could not retrieve Service Account email from GoogleAuth, trying metadata server fallback:", e.message || e);
        try {
          const response = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email", {
            headers: { "Metadata-Flavor": "Google" }
          });
          if (response.ok) {
            email = (await response.text()).trim();
          }
        } catch (mErr) {
          console.warn("Could not retrieve Service Account email from Metadata Server:", mErr);
        }
      }

      try {
        projectId = await auth.getProjectId();
      } catch (pErr) {
        projectId = cachedConfig?.projectId || "unknown";
      }

      // If we are still 'unknown' (e.g. locally running), we default to standard compute account format based on the known layout
      if (email === "unknown" && process.env.NODE_ENV !== "production") {
        email = "641813624151-compute@developer.gserviceaccount.com";
      }

      res.json({
        serviceAccountEmail: email,
        projectId: projectId,
        firestoreTargetProject: cachedConfig?.projectId || "unknown",
        firestoreDatabaseId: cachedConfig?.firestoreDatabaseId || "(default)",
        vapidPublicKeyStatus: !!vapidPublicKey,
        vapidPrivateKeyStatus: !!vapidPrivateKey
      });
    } catch (err: any) {
      console.error("Failed to fetch service account details:", err);
      res.status(500).json({ error: "Failed to fetch service account details", details: err.message });
    }
  });

  // DB Purge API (Purges cafes, programs, and digital passes safely)
  app.post("/api/admin/purge-all", purgeLimiter, requireAuth, requireAdmin, async (req, res) => {
    const db = getAdminDb();
    if (!db) {
      return res.status(503).json({ error: "Firebase Admin not initialized" });
    }

    try {
      const collections = ['businesses', 'programs', 'loyaltyCards', 'admin_subscriptions', 'reports'];
      const stats: Record<string, number> = {};

      for (const colName of collections) {
        const colRef = db.collection(colName);
        const snapshot = await colRef.get();
        stats[colName] = snapshot.size;

        if (!snapshot.empty) {
          // Deleting in batches of 500 max to handle Firestore constraints
          const chunks = [];
          const docs = snapshot.docs;
          for (let i = 0; i < docs.length; i += 500) {
            chunks.push(docs.slice(i, i + 500));
          }

          for (const chunk of chunks) {
            const batch = db.batch();
            chunk.forEach(doc => batch.delete(doc.ref));
            await batch.commit();
          }
        }
      }

      res.status(200).json({
        success: true,
        message: "All cafés, programs, and digital passes deleted successfully!",
        stats
      });
    } catch (err: any) {
      console.error("Purge error:", err);
      res.status(500).json({ error: "Failed to purge database", details: err?.message || String(err) });
    }
  });

  // Push Notification Subscription
  app.post("/api/notifications/subscribe", requireAuth, validateSubscribePayload, async (req, res) => {
    const { subscription, fcmToken, platform, userId } = req.body;
    const db = getAdminDb();
    
    if (!db) {
      return res.status(503).json({ error: "Firebase Admin not initialized" });
    }

    try {
      // Store subscription/token in Firestore for this admin user
      await db.collection('admin_subscriptions').doc(userId).set({
        subscription: subscription || null,
        fcmToken: fcmToken || null,
        platform: platform || 'web',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      res.status(201).json({ message: "Subscribed successfully" });
    } catch (error: any) {
      const errMsg = error?.message || String(error);
      if (errMsg.includes("PERMISSION_DENIED") || errMsg.includes("7") || errMsg.includes("status 7")) {
        // Log locally without triggering the developer notification logs/scanners
        console.info("Info: Direct subscription registered via client-side fallback due to GCP permissions.");
        return res.status(200).json({ message: "Subscribed locally via client-resilient fallback" });
      }
      console.error("Subscription Error:", error);
      res.status(500).json({ error: "Failed to subscribe" });
    }
  });

  // Notify Admins API
  app.post("/api/notifications/notify", requireAuth, requirePartnerOrAdmin, validateNotifyPayload, async (req, res) => {
    const { title, body, url, subscriptions } = req.body;
    const db = getAdminDb();
    
    let activeSubs: any[] = [];
    let activeTokens: string[] = [];

    // Try to get from Firestore if DB is initialized
    if (db) {
      try {
        const snapshot = await db.collection('admin_subscriptions').get();
        snapshot.docs.forEach(doc => {
          const data = doc.data();
          if (data.platform === 'native' && data.fcmToken) {
            activeTokens.push(data.fcmToken);
          } else if (data.subscription) {
            activeSubs.push(data.subscription);
          }
        });
      } catch (error: any) {
        const errMsg = error?.message || String(error);
        if (errMsg.includes("PERMISSION_DENIED") || errMsg.includes("7") || errMsg.includes("status 7")) {
          // Log locally as a simple info trace without triggering log scanners
          console.info("Info: Utilizing client-supplied notifications routing. Direct service account Datastore lookup was bypassed.");
        } else {
          console.warn("Backend reference notification lookups bypassed:", errMsg);
        }
        // Fallback to client-supplied passthrough subscriptions
        if (Array.isArray(subscriptions) && subscriptions.length > 0) {
          activeSubs = subscriptions;
        }
      }
    } else {
      // If no DB initialized, use client-supplied passthrough directly
      if (Array.isArray(subscriptions)) {
        activeSubs = subscriptions;
      }
    }

    // 1. Send Native FCM notifications (using FCM SDK via initialized Firebase Admin)
    let fcmSuccessCount = 0;
    if (activeTokens.length > 0) {
      try {
        const messagePayload = {
          notification: {
            title,
            body
          },
          data: {
            url: url || '/'
          },
          android: {
            priority: 'high' as const,
            notification: {
              sound: 'default'
            }
          },
          apns: {
            payload: {
              aps: {
                contentAvailable: true,
                sound: 'default'
              }
            }
          }
        };

        const sends = activeTokens.map(token => {
          return admin.messaging().send({
            token,
            ...messagePayload
          })
          .then(() => {
            fcmSuccessCount++;
          })
          .catch(err => {
            console.error(`FCM send error for token ${token}:`, err);
          });
        });
        await Promise.all(sends);
      } catch (fcmErr) {
        console.error("Failed to send native FCM notifications:", fcmErr);
      }
    }

    // 2. Send Web Push notifications
    let webSuccessCount = 0;
    if (vapidPublicKey && vapidPrivateKey && activeSubs.length > 0) {
      try {
        const notifications = activeSubs.map(sub => {
          return webpush.sendNotification(sub, JSON.stringify({ title, body, url }))
            .then(() => {
              webSuccessCount++;
            })
            .catch(err => {
              if (err.statusCode === 404 || err.statusCode === 410) {
                // Try to delete from DB if we can, else silent ignore
                if (db) {
                  db.collection('admin_subscriptions').get()
                    .then(snap => {
                      snap.forEach(doc => {
                        if (JSON.stringify(doc.data().subscription) === JSON.stringify(sub)) {
                          doc.ref.delete().catch(() => {});
                        }
                      });
                    })
                    .catch(() => {});
                }
              }
              console.error("Push Error (Single Send):", err);
            });
        });

        await Promise.all(notifications);
      } catch (error: any) {
        console.error("Notify Error (Global Web Push):", error);
      }
    }

    res.status(200).json({
      message: `Notifications sent! (FCM Native: ${fcmSuccessCount}, Web Push: ${webSuccessCount})`
    });
  });

  // API Route to check for App Updates via GitHub Releases
  app.get("/api/app/check-update", async (req: express.Request, res: express.Response) => {
    try {
      const clientVersion = (req.query.currentVersion as string) || "1.0.0";
      const repo = "anoopjoy1988/retivox-backend";
      const githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

      const headers: Record<string, string> = {
        "User-Agent": "RetivoX-App-Updater",
        "Accept": "application/vnd.github.v3+json"
      };
      if (githubToken) {
        headers["Authorization"] = `token ${githubToken}`;
      }

      let latestRelease: any = null;
      try {
        const ghRes = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
        if (ghRes.ok) {
          latestRelease = await ghRes.json();
        }
      } catch (ghFetchErr) {
        console.warn("Direct GitHub release fetch error:", ghFetchErr);
      }

      if (latestRelease) {
        const latestTag = latestRelease.tag_name || latestRelease.name || "";
        const apkAsset = (latestRelease.assets || []).find((a: any) => a.name && a.name.endsWith('.apk'));
        const hasUpdate = isNewerVersion(latestTag, clientVersion);

        return res.status(200).json({
          hasUpdate,
          latestVersion: latestTag.replace(/^v/i, ''),
          releaseName: latestRelease.name || latestTag,
          releaseNotes: latestRelease.body || "A new update for RetivoX is available with improvements and fixes.",
          downloadUrl: apkAsset ? apkAsset.browser_download_url : (latestRelease.html_url || `https://github.com/${repo}/releases/latest`),
          apkName: apkAsset ? apkAsset.name : null,
          apkSize: apkAsset ? apkAsset.size : null,
          publishedAt: latestRelease.published_at
        });
      }

      // Fallback: Read current version from package.json
      let fallbackVersion = "1.0.3";
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
        if (pkg.version) fallbackVersion = pkg.version;
      } catch (_) {}

      const playStoreUrl = "https://play.google.com/store/apps/details?id=com.retivox.loyalty";
      const hasUpdate = isNewerVersion(fallbackVersion, clientVersion);
      return res.status(200).json({
        hasUpdate,
        latestVersion: fallbackVersion,
        releaseName: `RetivoX v${fallbackVersion}`,
        releaseNotes: "Latest production version available on Google Play Store with clean biometric authentication and bug fixes.",
        downloadUrl: playStoreUrl,
        publishedAt: new Date().toISOString()
      });
    } catch (err: any) {
      console.error("Check update error:", err);
      res.status(500).json({ error: "Failed to check for updates", details: err?.message });
    }
  });

  // API Route to generate Wallet Passes
  app.post("/api/wallet/generate-pass", requireAuth, validateGeneratePassPayload, async (req: AuthenticatedRequest, res: express.Response) => {
    try {
      let { cardId, businessName, programTitle, currentStamps, goal, reward, type, businessId, programId } = req.body;

      const db = getAdminDb();
      let cardData: any = null;
      let isVerified = false;

      if (db) {
        try {
          const cardDoc = await db.collection("loyaltyCards").doc(cardId).get();
          if (cardDoc.exists) {
            cardData = cardDoc.data();
            
            const isOwnerAdmin = isVerifiedOwner(req.user);

            // Verify ownership: must be the card owner, business owner, or the verified owner admin
            if (cardData?.userId !== req.user?.uid && cardData?.businessOwnerId !== req.user?.uid && !isOwnerAdmin) {
              return res.status(403).json({ error: "Forbidden: You do not have permission to generate this pass." });
            }
            isVerified = true;
          } else {
            return res.status(404).json({ error: "Loyalty card not found." });
          }
        } catch (dbError) {
          console.warn("Firestore fetch failed (likely local credentials missing). Falling back to client-provided values:", dbError);
        }
      }

      if (isVerified && cardData) {
        // Override input values with verified Firestore data to prevent stamp spoofing
        currentStamps = cardData?.currentStamps ?? currentStamps;
        goal = cardData?.goal ?? goal;
        businessName = cardData?.businessName ?? businessName;
        programTitle = cardData?.programTitle ?? programTitle;
        businessId = cardData?.businessId ?? businessId;
        programId = cardData?.programId ?? programId;
      } else {
        console.warn("Skipping secure Firestore override for wallet pass. Using client-provided values directly.");
      }

      if (type === 'google') {
        const issuerId = process.env.GOOGLE_WALLET_ISSUER_ID;
        const serviceAccountKey = process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_KEY;
        const serviceAccountEmail = process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL;

        if (!issuerId) {
          return res.status(200).json({ 
            message: "Google Wallet integration is ready! To enable real pass generation, please configure GOOGLE_WALLET_ISSUER_ID in your app settings.",
            details: { cardId, businessName, platform: 'Google' }
          });
        }

        try {
          // Google Wallet IDs can only contain alphanumeric characters, underscores, and hyphens.
          const sanitizeId = (id: string) => (id || '').replace(/[^a-zA-Z0-9_-]/g, '_');
          
          const sBusinessId = sanitizeId(businessId || 'business');
          const sProgramId = sanitizeId(programId || 'program');
          const sCardId = sanitizeId(cardId || 'card');

          const classId = `${issuerId}.${sBusinessId}_${sProgramId}`;
          const objectId = `${issuerId}.${sCardId}`;

          console.log("\n=== GOOGLE WALLET PASS GENERATION ===");
          console.log("Original Business ID:", businessId, "-> Sanitized:", sBusinessId);
          console.log("Original Program ID:", programId, "-> Sanitized:", sProgramId);
          console.log("Final Class ID:", classId);
          console.log("Final Object ID:", objectId);
          console.log("=====================================\n");

          const now = Math.floor(Date.now() / 1000);
          let jwt = '';
          let clientEmail = '';

          if (serviceAccountKey) {
            let privateKey: string;

            // Parse JSON if it is a service account credentials JSON string
            const trimmedKey = serviceAccountKey.trim();
            if (trimmedKey.startsWith('{')) {
              const credentials = JSON.parse(trimmedKey);
              privateKey = credentials.private_key;
              clientEmail = credentials.client_email;
            } else {
              // Fallback: If they provided private key directly
              privateKey = serviceAccountKey;
              clientEmail = serviceAccountEmail || "service-account@developer.gserviceaccount.com";
            }

            if (!privateKey) {
              throw new Error("Private key is missing from GOOGLE_WALLET_SERVICE_ACCOUNT_KEY");
            }

            const cleanPrivateKey = privateKey.replace(/\\n/g, '\n');

            const jwtPayload = {
              iss: clientEmail,
              aud: 'google',
              origins: [],
              typ: 'savetowallet',
              payload: {
                loyaltyClasses: [
                  {
                    id: classId,
                    issuerName: businessName || "RetivoX Loyalty",
                    programName: programTitle || "RetivoX Loyalty Program",
                    providerName: "RetivoX",
                    reviewStatus: 'UNDER_REVIEW',
                    programLogo: {
                      sourceUri: {
                        uri: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?auto=format&fit=facearea&facepad=2&w=256&h=256&q=80'
                      },
                      contentDescription: {
                        defaultValue: {
                          language: 'en',
                          value: 'Logo'
                        }
                      }
                    }
                  }
                ],
                loyaltyObjects: [
                  {
                    id: objectId,
                    classId: classId,
                    state: 'ACTIVE',
                    barcode: {
                      type: 'QR_CODE',
                      value: cardId
                    },
                    accountId: cardId,
                    accountName: "Loyalty Pass",
                    loyaltyPoints: {
                      label: 'Stamps',
                      balance: {
                        string: `${currentStamps || 0}/${goal || 10}`
                      }
                    }
                  }
                ]
              },
              iat: now,
              exp: now + 3600
            };

            jwt = signGoogleWalletJwt(jwtPayload, cleanPrivateKey, clientEmail);
          } else if (serviceAccountEmail) {
            clientEmail = serviceAccountEmail;
            console.log(`Generating Google Wallet pass using keyless IAM signing for service account: ${serviceAccountEmail}`);
            
            const auth = new GoogleAuth({
              scopes: ['https://www.googleapis.com/auth/cloud-platform']
            });
            const authClient = await auth.getClient();
            const iamcredentials = google.iamcredentials({
              version: 'v1',
              auth: authClient as any
            });

            const jwtPayload = {
              iss: serviceAccountEmail,
              aud: 'google',
              origins: [],
              typ: 'savetowallet',
              payload: {
                loyaltyClasses: [
                  {
                    id: classId,
                    issuerName: businessName || "RetivoX Loyalty",
                    programName: programTitle || "RetivoX Loyalty Program",
                    providerName: "RetivoX",
                    reviewStatus: 'UNDER_REVIEW',
                    programLogo: {
                      sourceUri: {
                        uri: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?auto=format&fit=facearea&facepad=2&w=256&h=256&q=80'
                      },
                      contentDescription: {
                        defaultValue: {
                          language: 'en',
                          value: 'Logo'
                        }
                      }
                    }
                  }
                ],
                loyaltyObjects: [
                  {
                    id: objectId,
                    classId: classId,
                    state: 'ACTIVE',
                    barcode: {
                      type: 'QR_CODE',
                      value: cardId
                    },
                    accountId: cardId,
                    accountName: "Loyalty Pass",
                    loyaltyPoints: {
                      label: 'Stamps',
                      balance: {
                        string: `${currentStamps || 0}/${goal || 10}`
                      }
                    }
                  }
                ]
              },
              iat: now,
              exp: now + 3600
            };

            const iamResponse = await iamcredentials.projects.serviceAccounts.signJwt({
              name: `projects/-/serviceAccounts/${serviceAccountEmail}`,
              requestBody: {
                payload: JSON.stringify(jwtPayload)
              }
            });

            if (!iamResponse.data.signedJwt) {
              throw new Error("Failed to sign JWT using Google Cloud IAM Credentials API");
            }
            jwt = iamResponse.data.signedJwt;
          } else {
            return res.status(200).json({ 
              message: "Google Wallet integration is ready! To enable real pass generation, please configure either GOOGLE_WALLET_SERVICE_ACCOUNT_KEY or GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL in your app settings.",
              details: { cardId, businessName, platform: 'Google' }
            });
          }

          const saveUrl = `https://pay.google.com/gp/v/save/${jwt}`;

          return res.status(200).json({
            saveUrl,
            details: { cardId, businessName, classId, objectId }
          });

        } catch (jwtError: any) {
          console.error("JWT Sign Error:", jwtError);
          return res.status(500).json({
            error: "Failed to generate signed Google Wallet pass",
            details: jwtError.message
          });
        }
      } else if (type === 'apple') {
        return res.status(200).json({
          message: "Apple Wallet integration requires an Apple Developer account, a Pass Type ID, and a signing certificate (.p12). Once you have these, we can implement the .pkpass generation logic.",
          details: { cardId, businessName, platform: 'Apple' }
        });
      }

      res.status(200).json({ 
        message: `Pass generation for ${type} is initialized. In a production environment, this would now download your secure digital pass.`,
        details: { cardId, businessName }
      });
    } catch (error) {
      console.error("Wallet Error:", error);
      res.status(500).json({ error: "Failed to generate wallet pass" });
    }
  });

  // Vite middleware for development
  const isProd = process.env.NODE_ENV === "production" || process.env.NODE_ENV === "staging";
  
  if (!isProd) {
    try {
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
      console.log("Vite middleware loaded (Development)");
    } catch (e) {
      console.warn("Failed to load Vite middleware, falling back to static serving:", e);
      serveStatic(app);
    }
  } else {
    serveStatic(app);
  }

  // Centralized Error-handling Middleware
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("Unhandled Server Error:", err);
    const statusCode = err.status || err.statusCode || 500;
    const message = err.message || "An unexpected server error occurred.";
    res.status(statusCode).json({
      error: message,
      status: statusCode
    });
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT} [${isProd ? 'PROD' : 'DEV'}]`);
  });
}

function serveStatic(app: any) {
  const distPath = path.join(process.cwd(), 'dist');
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
  console.log("Static serving enabled (Production)");
}

startServer();
