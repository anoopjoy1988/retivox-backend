import { useState, useEffect, useRef, ReactNode, ChangeEvent } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { QRCodeSVG } from 'qrcode.react';
import { PublicCustomerPassView } from './components/PublicCustomerPassView';
import { Browser } from '@capacitor/browser';
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { 
  Home, Search, Bell, User, Settings, Plus, Heart, MessageCircle, 
  Share2, Coffee, Dumbbell, Award, QrCode, LogIn, LogOut, 
  ChevronRight, Star, Clock, MapPin, CheckCircle2, AlertCircle, AlertTriangle, Flag,
  LayoutDashboard, Users, Store, PlusCircle, BarChart3, ShieldCheck, ShieldAlert,
  Smartphone, Scan, X, Edit2, Trash2, Mail, Trophy, Power, ExternalLink,
  Eye, EyeOff, Download, Sparkles, RefreshCw, KeyRound, RotateCcw, Lock
} from 'lucide-react';
import { auth, db, handleFirestoreError, OperationType } from './firebase';
import { 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  sendPasswordResetEmail, 
  sendEmailVerification,
  signOut, 
  setPersistence, 
  indexedDBLocalPersistence,
  GoogleAuthProvider,
  signInWithPopup,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink
} from 'firebase/auth';
import { 
  collection, query, where, onSnapshot, doc, setDoc, updateDoc, getDoc, getDocs,
  addDoc, deleteDoc, serverTimestamp, Timestamp, runTransaction, increment 
} from 'firebase/firestore';
import { useAuthState } from 'react-firebase-hooks/auth';
import { Html5Qrcode } from 'html5-qrcode';

// --- Types ---
type Tab = 'explore' | 'wallet' | 'profile' | 'partner' | 'admin_home';
type UserRole = 'customer' | 'partner' | 'admin';

interface AppUpdateInfo {
  hasUpdate: boolean;
  latestVersion: string;
  releaseName: string;
  releaseNotes: string;
  downloadUrl: string;
  apkName?: string;
  apkSize?: number;
  publishedAt?: string;
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

interface Business {
  id: string;
  displayId: string;
  name: string;
  type: 'cafe' | 'gym';
  ownerId: string;
  createdAt: Timestamp;
  location?: string;
  contactNumber?: string;
  logoUrl?: string;
}

interface LoyaltyProgram {
  id: string;
  businessId: string;
  title: string;
  itemName: string;
  description: string;
  goal: number;
  reward: string;
  isActive: boolean;
  closedAt?: Timestamp;
}

interface LoyaltyCard {
  id: string;
  userId: string;
  programId: string;
  businessId: string;
  businessOwnerId: string; // Added for partner/admin queries
  businessName: string; // Denormalized
  businessLogo?: string; // Denormalized
  programTitle: string; // Denormalized
  itemName: string; // Denormalized
  goal: number; // Denormalized
  currentStamps: number;
  lastUpdated: Timestamp;
  isCompleted?: boolean;
}

interface UserProfile {
  uid: string;
  name: string;
  email: string;
  role: UserRole;
}

// --- Helpers ---
const getOrdinal = (n: number) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
};

const getApiUrl = (path: string) => {
  const baseUrl = (import.meta as any).env.VITE_API_URL || '';
  if (Capacitor.isNativePlatform() && !baseUrl) {
    console.warn("VITE_API_URL is not configured for Capacitor. Native network calls to relative paths will fail.");
    return `http://localhost:3000${path}`;
  }
  return `${baseUrl}${path}`;
};

// Simple security salt for QR tokens (In production, this would be a secret environment variable)
const QR_SECRET = "retivox_secure_prod_salt_8f3d1b9a2c6e4e5f";

const generateSecureToken = (cardId: string, currentStamps: number) => {
  const timestamp = Math.floor(Date.now() / 1000);
  // We include currentStamps in the hash to "lock" the QR to the current state
  const hash = btoa(`${cardId}:${timestamp}:${currentStamps}:${QR_SECRET}`).slice(0, 10);
  return `v1:${cardId}:${timestamp}:${currentStamps}:${hash}`;
};

const validateSecureToken = (token: string) => {
  try {
    const parts = token.split(':');
    if (parts[0] !== 'v1') return { valid: false, error: "Invalid token format" };
    
    const cardId = parts[1];
    const timestamp = parseInt(parts[2]);
    const tokenStampCount = parseInt(parts[3]);
    const hash = parts[4];
    
    // 1. Relaxed Validation: We no longer force an exact stamp count match.
    // This allows screenshots to work more reliably during the Beta launch.

    // 2. Security validation (Hash check)
    // We still validate the hash to ensure the cardId hasn't been tampered with.
    const expectedHash = btoa(`${cardId}:${timestamp}:${tokenStampCount}:${QR_SECRET}`).slice(0, 10);
    if (hash !== expectedHash) {
      return { valid: false, error: "Security validation failed. Possible tampering detected." };
    }
    
    // 3. Expiration Check (Relaxed to 24 hours for Beta)
    const now = Math.floor(Date.now() / 1000);
    if (now - timestamp > 86400) { 
      return { valid: false, error: "QR Code expired. Please refresh your pass." };
    }
    
    return { valid: true, cardId };
  } catch (e) {
    return { valid: false, error: "Token parsing error" };
  }
};

// --- Components ---

function ErrorBoundary({ error, reset }: { error: string, reset: () => void }) {
  let message = "An unexpected error occurred.";
  try {
    const parsed = JSON.parse(error);
    if (parsed.error) message = parsed.error;
  } catch {
    message = error;
  }

  return (
    <div className="p-6 bg-red-50 rounded-3xl border border-red-100 flex flex-col items-center text-center space-y-4 m-4">
      <AlertCircle className="text-red-500" size={48} />
      <div>
        <h3 className="font-bold text-red-900">Oops! Something went wrong</h3>
        <p className="text-sm text-red-700 mt-1">{message}</p>
      </div>
      <button onClick={reset} className="px-6 py-2 bg-red-600 text-white rounded-xl font-semibold text-sm shadow-sm active:scale-95 transition-transform">
        Try Again
      </button>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="bg-white rounded-[2.5rem] p-6 shadow-xl border border-gray-100 relative overflow-hidden animate-pulse">
      <div className="absolute top-0 left-0 right-0 h-32 bg-gray-200" />
      <div className="relative z-10">
        <div className="flex justify-between items-start mb-8">
          <div className="space-y-2">
            <div className="h-3 w-20 bg-gray-300/50 rounded" />
            <div className="h-8 w-40 bg-gray-300 rounded" />
          </div>
          <div className="w-12 h-12 bg-gray-300 rounded-2xl" />
        </div>
        <div className="bg-gray-50 rounded-3xl p-6 space-y-4">
          <div className="flex justify-between items-end">
            <div className="space-y-2">
              <div className="h-3 w-24 bg-gray-200 rounded" />
              <div className="h-8 w-16 bg-gray-200 rounded" />
            </div>
            <div className="h-10 w-10 bg-gray-200 rounded-full" />
          </div>
          <div className="h-3 w-full bg-gray-200 rounded-full" />
        </div>
      </div>
    </div>
  );
}

// =========================================================================
// EASY DEPLOYMENT CONFIGURATION
// Swap these boolean values to instantly hide and isolate portals before building!
//
// 1. FOR PUBLIC DEPLOYMENT (Partner Only):
 //   const HIDE_ADMIN_PORTAL = true;
  //  const HIDE_PARTNER_PORTAL = false;
//
// 2. FOR PRIVATE DEPLOYMENT (Admin Only):
 //   const HIDE_ADMIN_PORTAL = false;
 //   const HIDE_PARTNER_PORTAL = true;
// =========================================================================
const HIDE_ADMIN_PORTAL = false;
const HIDE_PARTNER_PORTAL = false;

export default function App() {
  const [isSplashing, setIsSplashing] = useState(true);
  const [user, loading] = useAuthState(auth);
  const [showPassword, setShowPassword] = useState(false);
  

  
  useEffect(() => {
    const timer = setTimeout(() => setIsSplashing(false), 2500);
    return () => clearTimeout(timer);
  }, []);

  // Public join program ID for zero-install customer passes
  const [publicJoinId, setPublicJoinId] = useState<string | null>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get('join');
    } catch (_) {
      return null;
    }
  });
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('partner');
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [programs, setPrograms] = useState<LoyaltyProgram[]>([]);
  const [myCards, setMyCards] = useState<LoyaltyCard[]>([]);
  const [appError, setAppError] = useState<string | null>(null);
  const isProduction = process.env.NODE_ENV === 'production';
  const [showJoinQR, setShowJoinQR] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [scanError, setScanError] = useState<ReactNode | null>(null);
  const [scanResult, setScanResult] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<UserRole>('partner');
  const [isAdminMode, setIsAdminMode] = useState(false);
  const [showAddProgram, setShowAddProgram] = useState(false);
  const [newProg, setNewProg] = useState({ title: '', itemName: '', goal: '', reward: '' });
  const [justJoined, setJustJoined] = useState<string | null>(null);
  const [stampSuccess, setStampSuccess] = useState<string | null>(null);
  const [stampError, setStampError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [selectedCard, setSelectedCard] = useState<LoyaltyCard | null>(null);
  const [editingProgram, setEditingProgram] = useState<LoyaltyProgram | null>(null);
  const [programToDelete, setProgramToDelete] = useState<string | null>(null);
  const [allCards, setAllCards] = useState<LoyaltyCard[]>([]);

  const [selectedAdminBizId, setSelectedAdminBizId] = useState<string | null>(null);
  const [cafeToDelete, setCafeToDelete] = useState<Business | null>(null);
  const [isDeletingCafe, setIsDeletingCafe] = useState(false);
  const [availableUpdate, setAvailableUpdate] = useState<AppUpdateInfo | null>(null);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [installedAppVersion, setInstalledAppVersion] = useState('1.0.6');
  const [showBusinessSettings, setShowBusinessSettings] = useState(false);
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeletingAccountFlow, setIsDeletingAccountFlow] = useState(false);
  const [showDangerZone, setShowDangerZone] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [showReportModal, setShowReportModal] = useState<{ id: string, type: 'business' | 'program', name: string } | null>(null);
  const [reportReason, setReportReason] = useState('');
  const [pushSubscription, setPushSubscription] = useState<PushSubscription | null>(() => {
    if (Capacitor.isNativePlatform()) {
      const isRegistered = localStorage.getItem('push_registered_native');
      return isRegistered === 'true' ? ({ platform: 'native', token: 'cached' } as any) : null;
    }
    return null;
  });
  const [isSubscribing, setIsSubscribing] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [isPreWiping, setIsPreWiping] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [systemStatus, setSystemStatus] = useState<{
    serviceAccountEmail: string;
    projectId: string;
    firestoreTargetProject: string;
    firestoreDatabaseId: string;
    vapidPublicKeyStatus: boolean;
    vapidPrivateKeyStatus: boolean;
  } | null>(null);

  const fetchWithAuth = async (url: string, options: RequestInit = {}) => {
    const token = await auth.currentUser?.getIdToken();
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
      ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    };
    return fetch(url, { ...options, headers });
  };

  useEffect(() => {
    if (user && isAdminMode) {
      fetchWithAuth(getApiUrl('/api/system/service-account'))
        .then(res => res.json())
        .then(data => setSystemStatus(data))
        .catch(err => console.error("Error loading system status:", err));
    }
  }, [user, isAdminMode]);

  const [isAuthChecking, setIsAuthChecking] = useState(false);
  const [authView, setAuthView] = useState<'main' | 'login' | 'signup' | 'forgot'>(
    HIDE_ADMIN_PORTAL || HIDE_PARTNER_PORTAL ? 'login' : 'main'
  );
  const [authRole, setAuthRole] = useState<'admin' | 'partner'>(
    HIDE_PARTNER_PORTAL ? 'admin' : 'partner'
  );
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [showPin, setShowPin] = useState(false);

  // 6-digit PIN used directly as secure authentication credential (matches Firebase 6-char requirement)
  const pinToSecret = (pinCode: string): string => pinCode.trim();

  // Create refs to keep track of state in Capacitor backButton listener without recreating the listener
  const userRef = useRef(user);
  const profileRef = useRef(profile);
  const authViewRef = useRef(authView);
  const activeTabRef = useRef(activeTab);
  const isScanningRef = useRef(isScanning);
  const showJoinQRRef = useRef(showJoinQR);
  const showAddProgramRef = useRef(showAddProgram);
  const editingProgramRef = useRef(editingProgram);
  const programToDeleteRef = useRef(programToDelete);
  const selectedCardRef = useRef(selectedCard);
  const selectedAdminBizIdRef = useRef(selectedAdminBizId);
  const showBusinessSettingsRef = useRef(showBusinessSettings);
  const showSignOutConfirmRef = useRef(showSignOutConfirm);
  const showTermsRef = useRef(showTerms);
  const showPrivacyRef = useRef(showPrivacy);
  const showDeleteConfirmRef = useRef(showDeleteConfirm);
  const showReportModalRef = useRef(showReportModal);
  const justJoinedRef = useRef(justJoined);
  const stampSuccessRef = useRef(stampSuccess);
  const stampErrorRef = useRef(stampError);
  const saveSuccessRef = useRef(saveSuccess);

  useEffect(() => {
    userRef.current = user;
    profileRef.current = profile;
    authViewRef.current = authView;
    activeTabRef.current = activeTab;
    isScanningRef.current = isScanning;
    showJoinQRRef.current = showJoinQR;
    showAddProgramRef.current = showAddProgram;
    editingProgramRef.current = editingProgram;
    programToDeleteRef.current = programToDelete;
    selectedCardRef.current = selectedCard;
    selectedAdminBizIdRef.current = selectedAdminBizId;
    showBusinessSettingsRef.current = showBusinessSettings;
    showSignOutConfirmRef.current = showSignOutConfirm;
    showTermsRef.current = showTerms;
    showPrivacyRef.current = showPrivacy;
    showDeleteConfirmRef.current = showDeleteConfirm;
    showReportModalRef.current = showReportModal;
    justJoinedRef.current = justJoined;
    stampSuccessRef.current = stampSuccess;
    stampErrorRef.current = stampError;
    saveSuccessRef.current = saveSuccess;
  }, [
    user, profile, authView, activeTab, isScanning, showJoinQR, showAddProgram,
    editingProgram, programToDelete, selectedCard, selectedAdminBizId,
    showBusinessSettings, showSignOutConfirm, showTerms, showPrivacy,
    showDeleteConfirm, showReportModal, justJoined, stampSuccess, stampError,
    saveSuccess
  ]);


  // --- Handle App State & Hardware Back Button (Option 1 - Clean App Exit) ---
  useEffect(() => {
    let stateListener: { remove: () => void } | null = null;
    let backListener: { remove: () => void } | null = null;

    const setupListeners = async () => {
      try {
        stateListener = await CapApp.addListener('appStateChange', ({ isActive }) => {
          console.log('App state changed. Is active?', isActive);
          if (isActive) {
            checkForAppUpdates(false);
          }
        });

        backListener = await CapApp.addListener('backButton', async () => {
          // If any modal, overlay or panel or editor is open, close/dismiss it step-by-step
          if (isScanningRef.current) {
            await stopScanner();
          } else if (showTermsRef.current) {
            setShowTerms(false);
          } else if (showPrivacyRef.current) {
            setShowPrivacy(false);
          } else if (showJoinQRRef.current) {
            setShowJoinQR(null);
          } else if (showAddProgramRef.current) {
            setShowAddProgram(false);
          } else if (editingProgramRef.current) {
            setEditingProgram(null);
          } else if (programToDeleteRef.current) {
            setProgramToDelete(null);
          } else if (selectedCardRef.current) {
            setSelectedCard(null);
          } else if (showBusinessSettingsRef.current) {
            setShowBusinessSettings(false);
          } else if (showSignOutConfirmRef.current) {
            setShowSignOutConfirm(false);
          } else if (showDeleteConfirmRef.current) {
            setShowDeleteConfirm(false);
          } else if (showReportModalRef.current) {
            setShowReportModal(null);
          } else if (selectedAdminBizIdRef.current) {
            setSelectedAdminBizId(null);
          } else if (justJoinedRef.current) {
            setJustJoined(null);
          } else if (stampSuccessRef.current) {
            setStampSuccess(null);
          } else if (stampErrorRef.current) {
            setStampError(null);
          } else if (saveSuccessRef.current) {
            setSaveSuccess(null);
          } else {
            // No modals/overlays are open, let's navigate back through screens
            if (!userRef.current) {
              // Unauthenticated flow
              if (authViewRef.current === 'login' || authViewRef.current === 'signup' || authViewRef.current === 'forgot') {
                setAuthView('main');
              } else {
                // If already at Splash View ('main'), let pressing back close the app cleanly
                CapApp.exitApp();
              }
            } else {
              // Authenticated flow
              const role = profileRef.current?.role;
              const defaultTab: Tab = role === 'admin' ? 'admin_home' : (role === 'partner' ? 'partner' : 'explore');
              
              if (activeTabRef.current !== defaultTab) {
                // Return to the home/dashboard tab of their current role
                setActiveTab(defaultTab);
              } else {
                // Already at their home screen, let pressing back close the app cleanly
                CapApp.exitApp();
              }
            }
          }
        });
      } catch (err) {
        console.error("Error configuring Capacitor native listeners:", err);
      }
    };

    setupListeners();

    return () => {
      if (stateListener) stateListener.remove();
      if (backListener) backListener.remove();
    };
  }, []);

  // --- Background In-App Update Checker ---
  const checkForAppUpdates = async (isManual = false) => {
    try {
      if (isManual) setIsCheckingUpdate(true);

      let currentVer = installedAppVersion || '1.0.4';
      if (Capacitor.isNativePlatform()) {
        try {
          const info = await CapApp.getInfo();
          if (info?.version) {
            currentVer = info.version;
            setInstalledAppVersion(info.version);
          }
        } catch (e) {
          console.warn("Could not read native app version:", e);
        }
      }

      let updateData: AppUpdateInfo | null = null;
      const releaseUrl = 'https://github.com/anoopjoy1988/retivox-backend/releases/latest';

      // 1. Direct Cloud Firestore check (Highest reliability on mobile & web)
      try {
        const updateDoc = await getDoc(doc(db, 'app_updates', 'latest'));
        if (updateDoc.exists()) {
          const data = updateDoc.data();
          const latestVer = data.latestVersion || '1.0.6';
          const hasUpdate = isNewerVersion(latestVer, currentVer);
          updateData = {
            hasUpdate,
            latestVersion: latestVer,
            releaseName: data.releaseName || `RetivoX v${latestVer}`,
            releaseNotes: data.releaseNotes || "A new update for RetivoX is available with latest improvements and fixes.",
            downloadUrl: data.downloadUrl || releaseUrl,
            publishedAt: data.updatedAt?.toDate ? data.updatedAt.toDate().toISOString() : new Date().toISOString()
          };
        }
      } catch (fsErr) {
        console.warn("Firestore update check notice:", fsErr);
      }

      // 2. Check via RetivoX backend proxy if not found in Firestore
      if (!updateData) {
        try {
          const res = await fetch(getApiUrl(`/api/app/check-update?currentVersion=${encodeURIComponent(currentVer)}`));
          if (res.ok) {
            updateData = await res.json();
          }
        } catch (backendErr) {
          // Quiet backend fallback
        }
      }

      // 3. Fallback: target production release v1.0.6 with GitHub APK link
      if (!updateData) {
        const fallbackTarget = '1.0.6';
        const hasUpdate = isNewerVersion(fallbackTarget, currentVer);
        updateData = {
          hasUpdate,
          latestVersion: fallbackTarget,
          releaseName: `RetivoX v${fallbackTarget}`,
          releaseNotes: "A new update for RetivoX is available with improvements and fixes.",
          downloadUrl: releaseUrl,
          publishedAt: new Date().toISOString()
        };
      }

      // If user is Admin, auto-sync app_updates/latest in Firestore so all devices see the latest broadcast
      if (isAdminMode && (user?.email?.toLowerCase() === 'anoopjoy1988@gmail.com')) {
        try {
          await setDoc(doc(db, 'app_updates', 'latest'), {
            latestVersion: '1.0.6',
            releaseName: 'RetivoX v1.0.6',
            releaseNotes: 'Clean PIN authentication, zero-install Google Wallet digital passes, camera fixes, and removed biometrics.',
            downloadUrl: releaseUrl,
            updatedAt: serverTimestamp()
          }, { merge: true });
        } catch (syncErr) {
          console.warn("Could not sync latest update broadcast to Firestore:", syncErr);
        }
      }

      if (updateData && updateData.hasUpdate) {
        const dismissed = sessionStorage.getItem(`dismissed_update_${updateData.latestVersion}`);
        if (isManual || !dismissed) {
          setAvailableUpdate(updateData);
        }
      } else if (isManual) {
        setSaveSuccess(`You are up to date! RetivoX v${currentVer} is the latest version.`);
        setTimeout(() => setSaveSuccess(null), 3500);
      }
    } catch (err: any) {
      console.error("Update check failed:", err);
      if (isManual) {
        setAppError("Unable to check for updates right now. Please try again later.");
        setTimeout(() => setAppError(null), 4000);
      }
    } finally {
      if (isManual) setIsCheckingUpdate(false);
    }
  };

  useEffect(() => {
    // Run quiet background update check on app launch
    const timer = setTimeout(() => {
      checkForAppUpdates(false);
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  // --- Helper: Notify Admins ---
  const notifyAdmins = async (title: string, body: string, url: string = '/') => {
    try {
      // Fetch subscriptions client-side where we have direct user Firestore permissions,
      // and provide them as a fallback/passthrough in the payload to the server.
      let subscriptions: any[] = [];
      try {
        if (profile?.role === 'admin') {
          const querySnapshot = await getDocs(collection(db, 'admin_subscriptions'));
          subscriptions = querySnapshot.docs
            .map(doc => doc.data().subscription)
            .filter(Boolean);
        }
      } catch (dbErr) {
        console.warn("Could not query subscriptions client-side:", dbErr);
      }

      await fetchWithAuth(getApiUrl('/api/notifications/notify'), {
        method: 'POST',
        body: JSON.stringify({ title, body, url, subscriptions })
      });
    } catch (err) {
      console.error("Failed to notify admins:", err);
    }
  };

  // --- Helper: Wipe All Data to start fresh ---
  const wipeAllData = async () => {
    setIsPreWiping(true);
    try {
      // 1. Call secure cloud container admin purge endpoint
      const res = await fetchWithAuth(getApiUrl('/api/admin/purge-all'), {
        method: 'POST'
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Server purge rejected");
      }
      
      setSaveSuccess("All cafes, programs, and passes deleted successfully!");
      setTimeout(() => setSaveSuccess(null), 4000);
    } catch (err: any) {
      console.warn("Server-side purge failed, attempting secure client-side direct deletes:", err.message || err);
      // 2. Client-side secure fallback
      try {
        const bSnap = await getDocs(collection(db, 'businesses'));
        for (const docItem of bSnap.docs) {
          await deleteDoc(doc(db, 'businesses', docItem.id));
        }

        const pSnap = await getDocs(collection(db, 'programs'));
        for (const docItem of pSnap.docs) {
          await deleteDoc(doc(db, 'programs', docItem.id));
        }

        const cSnap = await getDocs(collection(db, 'loyaltyCards'));
        for (const docItem of cSnap.docs) {
          await deleteDoc(doc(db, 'loyaltyCards', docItem.id));
        }

        setSaveSuccess("Database purged successfully!");
        setTimeout(() => setSaveSuccess(null), 4000);
      } catch (fallbackErr: any) {
        console.error("Purge fallback failed:", fallbackErr);
        setAppError("Could not wipe database: Permission Denied. Ensure you are signed in.");
        setTimeout(() => setAppError(null), 5000);
      }
    } finally {
      setIsPreWiping(false);
      setShowResetConfirm(false);
    }
  };

  // Helper to register push subscription/token on the server or fallback directly to Firestore
  const registerPushTokenOnServer = async (subscription: any, fcmToken: string | null, platform: 'web' | 'native') => {
    if (!user) return;
    try {
      const response = await fetchWithAuth(getApiUrl('/api/notifications/subscribe'), {
        method: 'POST',
        body: JSON.stringify({ subscription, fcmToken, platform, userId: user.uid })
      });
      if (!response.ok) {
        throw new Error("Server responded with error status: " + response.status);
      }
    } catch (fetchErr) {
      console.warn("Backend registration endpoint failed. Trying direct secure client-side Firestore register...", fetchErr);
      try {
        const subRef = doc(db, 'admin_subscriptions', user.uid);
        await setDoc(subRef, {
          subscription: subscription ? JSON.parse(JSON.stringify(subscription)) : null,
          fcmToken,
          platform,
          updatedAt: serverTimestamp()
        }, { merge: true });
        console.log("Secure direct client-side registration succeeded!");
      } catch (dbErr) {
        console.error("Secure direct client-side registration failed as well:", dbErr);
        throw dbErr;
      }
    }
  };

  // --- Push Notification Setup ---
  useEffect(() => {
    if (!user || (profile?.role !== 'admin' && user.email !== 'anoopjoy1988@gmail.com')) return;

    const setupPush = async () => {
      try {
        if (Capacitor.isNativePlatform()) {
          // Native Capacitor Push Notifications Flow
          let permStatus = await PushNotifications.checkPermissions();
          
          if (permStatus.receive === 'prompt') {
            permStatus = await PushNotifications.requestPermissions();
          }

          if (permStatus.receive !== 'granted') {
            console.warn("User denied push notification permissions on mobile.");
            localStorage.removeItem('push_registered_native');
            setPushSubscription(null);
            return;
          }

          // Register with FCM/APNs
          await PushNotifications.register();

          // Add listeners
          await PushNotifications.addListener('registration', async (token) => {
            console.log('Native push registration success, token:', token.value);
            localStorage.setItem('push_registered_native', 'true');
            setPushSubscription({ token: token.value, platform: 'native' } as any);
            try {
              await registerPushTokenOnServer(null, token.value, 'native');
            } catch (err) {
              console.error("Failed to register native token on server:", err);
            }
          });

          await PushNotifications.addListener('registrationError', (err) => {
            console.error('Native push registration error:', err.error);
            localStorage.removeItem('push_registered_native');
            setPushSubscription(null);
          });

          await PushNotifications.addListener('pushNotificationReceived', (notification) => {
            console.log('Native push notification received:', notification);
          });

          await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
            console.log('Native push action performed:', action);
            try {
              const data = action.notification.data;
              if (data && data.url) {
                const urlStr = String(data.url);
                if (urlStr.includes('admin')) {
                  setActiveTab('admin_home');
                } else if (urlStr.includes('wallet')) {
                  setActiveTab('wallet');
                } else if (urlStr.includes('profile')) {
                  setActiveTab('profile');
                } else if (urlStr.includes('partner')) {
                  setActiveTab('partner');
                } else if (urlStr.includes('explore')) {
                  setActiveTab('explore');
                }
              }
            } catch (err) {
              console.error("Failed to parse or navigate from push action:", err);
            }
          });

        } else {
          // Standard Web Push Flow
          if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            return;
          }

          const registration = await navigator.serviceWorker.register('/sw.js');
          const subscription = await registration.pushManager.getSubscription();
          setPushSubscription(subscription);

          const vapidKey = (import.meta as any).env.VITE_FCM_VAPID_KEY;
          if (!subscription && vapidKey && vapidKey.length > 30) {
            subscribeToPush(registration);
          }
        }
      } catch (err) {
        console.error("Push Notification Setup error:", err);
      }
    };

    setupPush();
  }, [user, user?.email, profile?.role]);

  const subscribeToPush = async (reg?: ServiceWorkerRegistration) => {
    if (!user) return;

    if (Capacitor.isNativePlatform()) {
      setIsSubscribing(true);
      try {
        let permStatus = await PushNotifications.checkPermissions();
        if (permStatus.receive !== 'granted') {
          permStatus = await PushNotifications.requestPermissions();
        }

        if (permStatus.receive === 'granted') {
          await PushNotifications.register();
          setSaveSuccess("Native push notification registration initialized!");
          setTimeout(() => setSaveSuccess(null), 3000);
        } else {
          setSaveSuccess("Notification permission was denied. Please enable it in your device settings.");
          setTimeout(() => setSaveSuccess(null), 5000);
        }
      } catch (err) {
        console.error("Native push request failed:", err);
        setSaveSuccess("Failed to request push permissions.");
        setTimeout(() => setSaveSuccess(null), 3000);
      } finally {
        setIsSubscribing(false);
      }
      return;
    }

    const vapidKey = (import.meta as any).env.VITE_FCM_VAPID_KEY;
    
    const urlBase64ToUint8Array = (base64String: string) => {
      const padding = '='.repeat((4 - base64String.length % 4) % 4);
      const base64 = (base64String + padding)
        .replace(/\-/g, '+')
        .replace(/_/g, '/');

      try {
        const rawData = window.atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; ++i) {
          outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
      } catch (e) {
        console.error("VAPID Key Base64 conversion failed:", e);
        return null;
      }
    };

    if (!vapidKey || vapidKey.length < 30) {
      return;
    }

    const convertedVapidKey = urlBase64ToUint8Array(vapidKey);
    if (!convertedVapidKey) return;

    setIsSubscribing(true);
    try {
      if ('Notification' in window) {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          setSaveSuccess("Notification permission was denied. Please enable it in your browser settings.");
          setTimeout(() => setSaveSuccess(null), 5000);
          setIsSubscribing(false);
          return;
        }
      }

      const registration = reg || await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: convertedVapidKey
      });

      await registerPushTokenOnServer(subscription, null, 'web');
      setPushSubscription(subscription);
      setSaveSuccess("You are now subscribed to live admin notifications!");
      setTimeout(() => setSaveSuccess(null), 3000);
    } catch (err) {
      console.error("Web Push Subscription failed:", err);
    } finally {
      setIsSubscribing(false);
    }
  };
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [hasSetInitialTab, setHasSetInitialTab] = useState(false);
  const [editBiz, setEditBiz] = useState({ name: '', location: '', contactNumber: '', logoUrl: '', displayId: '' });
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const isProcessingScan = useRef(false);

  const handleLogoUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 500000) { // 500KB limit for base64 storage
        setAppError("Logo file is too large. Please use an image under 500KB.");
        return;
      }
      const reader = new FileReader();
      reader.onloadend = () => {
        setEditBiz({ ...editBiz, logoUrl: reader.result as string });
      };
      reader.readAsDataURL(file);
    }
  };

  const stopCameraStreamOnly = async () => {
    // 1. First, stop the library-managed scanner if it exists
    if (scannerRef.current) {
      try {
        if (scannerRef.current.isScanning) {
          await scannerRef.current.stop();
          console.log("Scanner library stopped successfully");
        }
        scannerRef.current.clear();
      } catch (err) {
        console.warn("Scanner library stop warning:", err);
      }
      scannerRef.current = null;
    }

    // 2. Aggressive Fail-safe: Find and stop ALL video tracks in the document
    document.querySelectorAll('video').forEach(video => {
      try {
        if (video.srcObject instanceof MediaStream) {
          video.srcObject.getTracks().forEach(track => {
            try {
              track.stop();
              console.log("Forced track stop:", track.label);
            } catch (e) {}
          });
          video.srcObject = null;
        }
      } catch (e) {}
    });
  };

  const stopScanner = async () => {
    await stopCameraStreamOnly();

    // 3. Finally, update the UI state to remove the scanner overlay
    setIsScanning(false);
    setIsProcessing(false);
    isProcessingScan.current = false;
  };

  const programsRef = useRef(programs);
  useEffect(() => {
    programsRef.current = programs;
  }, [programs]);

  // QR Scanner Effect
  useEffect(() => {
    let isMounted = true;
    let localScanner: Html5Qrcode | null = null;

    const startCamera = async () => {
      // Small delay to ensure DOM is ready
      await new Promise(resolve => setTimeout(resolve, 300));
      if (!isMounted || !isScanning) return;

      try {
        const readerEl = document.getElementById("reader");
        if (!readerEl) return;

        localScanner = new Html5Qrcode("reader");
        scannerRef.current = localScanner;
        const config = { fps: 10, qrbox: { width: 250, height: 250 } };
        
        await localScanner.start(
          { facingMode: "environment" }, 
          config, 
          async (decodedText) => {
            if (!isMounted || isProcessingScan.current) return;
            
            // Handle scan result
            if (decodedText.startsWith('v1:') || decodedText.startsWith('card:') || decodedText.length >= 10) {
              isProcessingScan.current = true;
              setIsProcessing(true);
              // Shut down the camera stream immediately so the device is released instantly
              await stopCameraStreamOnly();
              await addStamp(decodedText);
            } else if (decodedText.startsWith('join:')) {
              isProcessingScan.current = true;
              setIsProcessing(true);
              const progId = decodedText.replace('join:', '');
              const prog = programsRef.current.find(p => p.id === progId);
              if (prog) {
                await stopScanner();
                joinProgram(prog.id, prog.businessId);
              }
            }
          },
          () => {} // Ignore errors
        );

        // Safe Guard: Check if we got unmounted or stopped scanning while start() was running
        if (!isMounted || !isScanning) {
          console.log("Scanner started but we are no longer active. Stopping immediately.");
          try {
            if (localScanner.isScanning) {
              await localScanner.stop();
            }
          } catch (stopError) {
            console.warn("Silent stop of scanner during unmount check:", stopError);
          }
          return;
        }
      } catch (err: any) {
        if (!isMounted) return;
        console.error("Scanner error:", err);
        if (err.toString().includes("NotAllowedError") || err.toString().includes("Permission denied")) {
          setScanError(
            <div className="flex flex-col gap-3">
              <p>Camera access was denied. This usually happens because the browser blocks camera access inside a preview window.</p>
              <button 
                onClick={() => window.open(window.location.href, '_blank')}
                className="w-full py-2.5 bg-coffee-dark text-white rounded-xl text-xs font-bold shadow-sm hover:bg-opacity-90 transition-all flex items-center justify-center gap-2"
              >
                <ExternalLink size={14} /> Open in New Tab to Scan
              </button>
            </div>
          );
        } else {
          setScanError("Could not start camera. Please ensure no other app is using it and try again.");
        }
      }
    };

    if (isScanning) {
      setScanError(null);
      startCamera();
    }

    return () => {
      isMounted = false;
      isProcessingScan.current = false;
      
      // Let's stop the global reference
      if (scannerRef.current) {
        const s = scannerRef.current;
        scannerRef.current = null;
        try {
          if (s.isScanning) {
            s.stop().catch(() => {});
          } else {
            // Even if not scanning, try to stop gracefully
            s.stop().catch(() => {});
          }
        } catch (e) {}
      }

      // Also stop the local scanner if it exists but wasn't in scannerRef
      if (localScanner) {
        const s = localScanner;
        localScanner = null;
        try {
          if (s.isScanning) {
            s.stop().catch(() => {});
          } else {
            s.stop().catch(() => {});
          }
        } catch (e) {}
      }

      // Final track cleanup: stop all video tracks and avoid Uncaught RenderedCameraImpl onabort
      document.querySelectorAll('video').forEach(video => {
        try {
          if (video.srcObject instanceof MediaStream) {
            video.srcObject.getTracks().forEach(track => {
              try {
                track.stop();
              } catch (e) {}
            });
            video.srcObject = null;
          }
        } catch (e) {}
      });
    };
  }, [isScanning]);


  // Handle Auth & Profile
  useEffect(() => {
    if (!user) {
      setProfile(null);
      return;
    }

    const userRef = doc(db, 'users', user.uid);
    const unsubscribe = onSnapshot(userRef, (docSnap) => {
      if (docSnap.exists()) {
        const p = { uid: user.uid, ...docSnap.data() } as UserProfile;
        
        // User profile loaded
        setProfile(p);
        setViewMode(p.role);
        
        // --- Owner Profile Fix ---
        if (user.email === 'anoopjoy1988@gmail.com' && p.name !== 'Anoop Joy') {
          updateDoc(userRef, { name: 'Anoop Joy' }).catch(() => {});
        }
        
        if (!hasSetInitialTab) {
          if (p.role === 'admin') {
            setIsAdminMode(true);
            setActiveTab('admin_home');
          } else if (p.role === 'partner') {
            setIsAdminMode(false);
            setActiveTab('partner');
          } else {
            setActiveTab('explore');
          }
          setHasSetInitialTab(true);
        }
      } else {
        const isOwner = user.email === 'anoopjoy1988@gmail.com';
        const newProfile: UserProfile = {
          uid: user.uid,
          name: isOwner ? 'Anoop Joy' : (user.displayName || 'Guest User'),
          email: user.email || '',
          // Security rules only allow 'admin' for the verified owner email
          role: isOwner && user.emailVerified ? 'admin' : 'partner'
        };
        setDoc(userRef, newProfile).catch(e => handleFirestoreError(e, OperationType.WRITE, `users/${user.uid}`));
      }
    }, (e) => handleFirestoreError(e, OperationType.GET, `users/${user.uid}`));

    return () => unsubscribe();
  }, [user]);

  // Fetch Global Data (Businesses & Programs)
  useEffect(() => {
    if (!user) return;
    const unsubBiz = onSnapshot(collection(db, 'businesses'), (snapshot) => {
      const bizs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Business));
      setBusinesses(bizs);
      
      // Auto-Repair Business Data (Display ID, Owner ID) - Admin only for performance
      if (isAdminMode) {
        bizs.forEach(async (biz) => {
          if (!biz.displayId || !biz.ownerId) {
            console.log(`Repairing business ${biz.name}...`);
            await updateDoc(doc(db, 'businesses', biz.id), {
              displayId: biz.displayId || biz.name.toUpperCase().slice(0, 3) + Math.floor(Math.random() * 1000),
              ownerId: biz.ownerId || user.uid
            }).catch(console.error);
          }
        });
      }
    }, (e) => handleFirestoreError(e, OperationType.LIST, 'businesses'));

    const unsubProg = onSnapshot(collection(db, 'programs'), (snapshot) => {
      setPrograms(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as LoyaltyProgram)));
    }, (e) => handleFirestoreError(e, OperationType.LIST, 'programs'));

    return () => { unsubBiz(); unsubProg(); };
  }, [user, isAdminMode, businesses.length]);

  // Data Repair Service for Admins (Loyalty Cards)
  useEffect(() => {
    if (!user || !isAdminMode || !allCards.length || !businesses.length) return;

    const repairCards = async () => {
      console.log("Admin Data Service: Checking for cards to repair...");
      const updates = allCards.filter(c => !c.businessOwnerId).map(async (card) => {
        const biz = businesses.find(b => b.id === card.businessId);
        if (biz?.ownerId) {
          console.log(`Healing card ${card.id} with owner ${biz.ownerId}`);
          return updateDoc(doc(db, 'loyaltyCards', card.id), {
            businessOwnerId: biz.ownerId,
            lastUpdated: serverTimestamp() // Required by security rules
          });
        }
      });
      await Promise.all(updates.filter(Boolean));
    };

    repairCards().catch(console.error);
  }, [user, isAdminMode, allCards.length, businesses.length]);

  // Fetch My Cards (Customer Wallet)
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, 'loyaltyCards'), where('userId', '==', user.uid));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setMyCards(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as LoyaltyCard)));
    }, (e) => handleFirestoreError(e, OperationType.LIST, 'loyaltyCards'));
    return () => unsubscribe();
  }, [user]);

  // Handle Auto-Join on link scan once user and data are loaded
  useEffect(() => {
    if (!user || !programs.length || !businesses.length) return;

    const pendingJoinId = localStorage.getItem('pending_join_program_id');
    if (!pendingJoinId) return;

    // Check if customer already joined this program
    const alreadyJoined = myCards.some(card => card.programId === pendingJoinId);
    
    if (alreadyJoined) {
      console.log(`User already has card for program ${pendingJoinId}. Clearing pending state and navigating to wallet.`);
      localStorage.removeItem('pending_join_program_id');
      setActiveTab('wallet');
      return;
    }

    const prog = programs.find(p => p.id === pendingJoinId);
    if (prog) {
      console.log(`Auto-joining program: ${pendingJoinId}`);
      localStorage.removeItem('pending_join_program_id');
      joinProgram(prog.id, prog.businessId);
    }
  }, [user, programs, businesses, myCards]);

  // Fetch Business Cards (for Partners or Admin)
  useEffect(() => {
    if (!user || !businesses.length) return;
    
    let q;
    const myBiz = businesses.find(b => b.ownerId === user.uid);

    if (isAdminMode && activeTab !== 'partner') {
      if (!selectedAdminBizId) {
        setAllCards([]);
        return;
      }
      // Admin satisfies rules via isAdmin() check, can query by businessId alone
      q = query(collection(db, 'loyaltyCards'), where('businessId', '==', selectedAdminBizId));
    } else {
      if (!myBiz) {
        setAllCards([]);
        return;
      }
      // Partner MUST query by businessOwnerId to satisfy Firestore's "list" security rules
      q = query(collection(db, 'loyaltyCards'), where('businessOwnerId', '==', user.uid));
    }

    const unsub = onSnapshot(q, (snapshot) => {
      let cards = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as LoyaltyCard));
      console.log(`Fetched ${cards.length} cards for ${isAdminMode && activeTab !== 'partner' ? 'Admin' : 'Partner Dashboard'}`);
      setAllCards(cards);
    }, (e) => handleFirestoreError(e, OperationType.LIST, 'loyaltyCards'));
    return unsub;
  }, [user, businesses, isAdminMode, selectedAdminBizId, activeTab]);

  // Wipe entire database to provide a fresh, clean app (Admin-only action)
  const handleCleanDatabase = async () => {
    if (!window.confirm("ARE YOU SURE? This will permanently delete ALL data (users, businesses, programs, loyalty cards, reports, and usernames) from the database to give you a clean slate.")) {
      return;
    }
    setIsProcessing(true);
    try {
      const collectionsToClean = [
        'loyaltyCards',
        'programs',
        'businesses',
        'reports',
        'admin_subscriptions',
        'usernames'
      ];
      let deletedCount = 0;
      for (const col of collectionsToClean) {
        try {
          const snap = await getDocs(collection(db, col));
          for (const d of snap.docs) {
            await deleteDoc(doc(db, col, d.id));
            deletedCount++;
          }
        } catch (colErr) {
          console.warn(`Error cleaning collection ${col}:`, colErr);
        }
      }
      // Clean users except current admin
      try {
        const uSnap = await getDocs(collection(db, 'users'));
        for (const d of uSnap.docs) {
          if (d.id !== auth.currentUser?.uid) {
            await deleteDoc(doc(db, 'users', d.id));
            deletedCount++;
          }
        }
      } catch (uErr) {
        console.warn("Error cleaning users:", uErr);
      }

      localStorage.clear();

      setSaveSuccess(`Database cleaned! Removed ${deletedCount} records. App is now completely fresh.`);
      setTimeout(() => {
        window.location.reload();
      }, 2500);
    } catch (err: any) {
      console.error("Clean database failed:", err);
      setAppError("Clean database failed: " + (err.message || err));
    } finally {
      setIsProcessing(false);
    }
  };

  const handleAuth = async () => {
    setAppError(null);
    setIsProcessing(true);

    try {
      if (authView === 'login') {
        const cleanIdentifier = username.trim().toLowerCase();
        const cleanPin = pin.trim();

        if (!cleanIdentifier || !cleanPin) {
          setAppError("Please enter your username (or email) and 6-digit PIN.");
          setIsProcessing(false);
          return;
        }

        if (cleanPin.length !== 6 || !/^\d{6}$/.test(cleanPin)) {
          setAppError("PIN code must be exactly 6 digits.");
          setIsProcessing(false);
          return;
        }

        let resolvedEmail = '';
        if (cleanIdentifier.includes('@')) {
          resolvedEmail = cleanIdentifier;
        } else {
          // Resolve email from short username lookup
          try {
            const uSnap = await getDoc(doc(db, 'usernames', cleanIdentifier));
            if (!uSnap.exists()) {
              setAppError(`Username "${cleanIdentifier}" not found. Please check spelling or create an account.`);
              setIsProcessing(false);
              return;
            }
            resolvedEmail = (uSnap.data().email || '').toLowerCase().trim();
          } catch (lookupErr: any) {
            console.error("Username lookup error:", lookupErr);
            setAppError("Unable to verify username. You can also sign in using your registered email address.");
            setIsProcessing(false);
            return;
          }
        }

        if (!resolvedEmail) {
          setAppError("Could not resolve account for this username. Please try your email address.");
          setIsProcessing(false);
          return;
        }

        // Strict Admin Portal Authorization
        if (authRole === 'admin' && resolvedEmail !== 'anoopjoy1988@gmail.com') {
          setAppError("Access Denied: Only anoopjoy1988@gmail.com is authorized for the Admin Portal.");
          setIsProcessing(false);
          return;
        }

        const cred = await signInWithEmailAndPassword(auth, resolvedEmail, cleanPin);
        
        // --- Owner Auto-Upgrade ---
        if (cred.user.email?.toLowerCase() === 'anoopjoy1988@gmail.com') {
          console.log("Admin Auto-Upgrade triggered for:", cred.user.email);
          try {
            await setDoc(doc(db, 'users', cred.user.uid), {
              uid: cred.user.uid,
              email: cred.user.email,
              name: cred.user.displayName || cred.user.email?.split('@')[0] || 'Admin',
              username: cleanIdentifier.includes('@') ? (cred.user.displayName || 'admin').toLowerCase() : cleanIdentifier,
              role: 'admin'
            }, { merge: true });
          } catch (syncErr) {
            console.warn("Minor sync error (likely already admin):", syncErr);
          }
        }

        // Verify role for admin
        if (authRole === 'admin') {
          const uDoc = await getDoc(doc(db, 'users', cred.user.uid));
          if (!uDoc.exists() || uDoc.data().role !== 'admin' || cred.user.email?.toLowerCase() !== 'anoopjoy1988@gmail.com') {
            await signOut(auth);
            setAppError("Access Denied: Only anoopjoy1988@gmail.com has administrator privileges.");
            setIsProcessing(false);
            return;
          }
          setIsAdminMode(true);
          setActiveTab('admin_home');
        } else {
          setIsAdminMode(false);
          setActiveTab('partner');
        }
      } else if (authView === 'signup') {
        const cleanName = displayName.trim();
        const cleanUsername = username.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
        const cleanEmail = email.trim().toLowerCase();
        const cleanPin = pin.trim();
        const cleanConfirmPin = confirmPin.trim();

        if (!cleanName || !cleanUsername || !cleanEmail || !cleanPin) {
          setAppError("All fields (Full Name, Short Username, Email, and 6-Digit PIN) are required.");
          setIsProcessing(false);
          return;
        }

        if (cleanUsername.length < 3) {
          setAppError("Username must be at least 3 characters (letters, numbers, underscores).");
          setIsProcessing(false);
          return;
        }

        if (cleanPin.length !== 6 || !/^\d{6}$/.test(cleanPin)) {
          setAppError("PIN code must be exactly 6 digits.");
          setIsProcessing(false);
          return;
        }

        if (cleanPin !== cleanConfirmPin) {
          setAppError("PIN and Confirm PIN do not match.");
          setIsProcessing(false);
          return;
        }

        // Strict Admin Signup Authorization
        if (authRole === 'admin' && cleanEmail !== 'anoopjoy1988@gmail.com') {
          setAppError("Access Denied: Only anoopjoy1988@gmail.com is authorized as Administrator.");
          setIsProcessing(false);
          return;
        }

        // Verify username uniqueness
        try {
          const uDoc = await getDoc(doc(db, 'usernames', cleanUsername));
          if (uDoc.exists()) {
            setAppError(`The username "${cleanUsername}" is already taken. Please choose another username.`);
            setIsProcessing(false);
            return;
          }
        } catch (uErr) {
          console.warn("Username availability check notice:", uErr);
        }

        const cred = await createUserWithEmailAndPassword(auth, cleanEmail, cleanPin);
        const isAdminSignup = authRole === 'admin' || cleanEmail === 'anoopjoy1988@gmail.com';

        await setDoc(doc(db, 'users', cred.user.uid), {
          uid: cred.user.uid,
          name: cleanName,
          username: cleanUsername,
          email: cleanEmail,
          role: isAdminSignup ? 'admin' : authRole,
          createdAt: serverTimestamp()
        });

        // Reserve short username
        await setDoc(doc(db, 'usernames', cleanUsername), {
          uid: cred.user.uid,
          email: cleanEmail,
          username: cleanUsername,
          createdAt: serverTimestamp()
        });

        if (isAdminSignup) {
          setIsAdminMode(true);
          setActiveTab('admin_home');
        } else {
          setIsAdminMode(false);
          setActiveTab('partner');
        }
      } else if (authView === 'forgot') {
        let cleanEmail = '';
        if (authRole === 'admin') {
          const inputVal = (email.trim() || username.trim() || 'anoopjoy1988@gmail.com').toLowerCase();
          if (inputVal === 'anoopjoy1988@gmail.com') {
            cleanEmail = 'anoopjoy1988@gmail.com';
          } else if (!inputVal.includes('@')) {
            try {
              const uSnap = await getDoc(doc(db, 'usernames', inputVal));
              if (uSnap.exists() && (uSnap.data().email || '').toLowerCase() === 'anoopjoy1988@gmail.com') {
                cleanEmail = 'anoopjoy1988@gmail.com';
              }
            } catch (err) {
              console.warn("Admin username check:", err);
            }
          }
          if (cleanEmail !== 'anoopjoy1988@gmail.com') {
            setAppError("Access Denied: Only anoopjoy1988@gmail.com is authorized to reset the Admin PIN.");
            setIsProcessing(false);
            return;
          }
        } else {
          const inputVal = username.trim().toLowerCase() || email.trim().toLowerCase();
          if (!inputVal) {
            setAppError("Please enter your short username or email address.");
            setIsProcessing(false);
            return;
          }
          cleanEmail = inputVal;
          if (!cleanEmail.includes('@')) {
            const uSnap = await getDoc(doc(db, 'usernames', cleanEmail));
            if (uSnap.exists()) {
              cleanEmail = (uSnap.data().email || '').toLowerCase();
            } else {
              setAppError(`No account found for username "${inputVal}". Please enter your registered email address.`);
              setIsProcessing(false);
              return;
            }
          }
        }

        await sendPasswordResetEmail(auth, cleanEmail);
        setSaveSuccess(`Reset link sent to: ${cleanEmail}! Open the email, enter your new 6-digit PIN code, then come back here to log in.`);
        setTimeout(() => {
          setAuthView('login');
          setSaveSuccess(null);
        }, 10000);
      }
      setHasSetInitialTab(true);
    } catch (e: any) {
      console.warn("Auth event handled:", e.code || e.message || e);
      let msg = e.message;
      if (e.code === 'auth/user-not-found') {
        msg = "Account not found. Please check your username/email or click 'Create Account'.";
      } else if (e.code === 'auth/wrong-password') {
        msg = "Incorrect 6-digit PIN. If you forgot your PIN, use the reset link below.";
      } else if (e.code === 'auth/email-already-in-use') {
        msg = "An account with this email already exists. Please log in with your username and 6-digit PIN.";
        setAuthView('login');
      } else if (e.code === 'auth/invalid-credential') {
        msg = "Incorrect username/email or 6-digit PIN. Please double-check your credentials.";
      }
      setAppError(msg);
    } finally {
      setIsProcessing(false);
    }
  };

  const logout = () => {
    setIsSplashing(true);
    signOut(auth);
    setIsAdminMode(false);
    setHasSetInitialTab(false);
    setActiveTab('explore');
    setAuthView('main');
    setUsername('');
    setEmail('');
    setPin('');
    setConfirmPin('');
    setShowPin(false);
    setTimeout(() => setIsSplashing(false), 2500);
  };

  const sendVerificationEmail = async () => {
    if (!auth.currentUser) return;
    setIsProcessing(true);
    try {
      await sendEmailVerification(auth.currentUser);
      setSaveSuccess("Verification email sent! Please check your inbox.");
      setTimeout(() => setSaveSuccess(null), 5000);
    } catch (e: any) {
      let msg = e.message;
      if (e.toString().includes('error-code:-26') || e.code?.includes('-26')) {
        msg = "Communication Error (Code -26): The verification request was blocked. Please try opening the app in a New Tab to complete this action.";
      }
      setAppError(msg);
    } finally {
      setIsProcessing(false);
    }
  };

  const deleteAccount = async () => {
    if (!user) return;
    try {
      setIsProcessing(true);

      // 1. Delete all user's loyalty cards (GDPR compliance / database cleanup)
      const cardsQuery = query(collection(db, 'loyaltyCards'), where('userId', '==', user.uid));
      const cardsSnapshot = await getDocs(cardsQuery);
      for (const cardDoc of cardsSnapshot.docs) {
        await deleteDoc(doc(db, 'loyaltyCards', cardDoc.id));
      }

      // 2. Delete user profile document from Firestore
      await deleteDoc(doc(db, 'users', user.uid));
      
      // 3. Delete Firebase Auth user account
      await user.delete();

      setIsDeletingAccountFlow(false);
      setShowDeleteConfirm(false);
      setDeleteConfirmText('');
      setIsProcessing(false);
      setSaveSuccess("Account deleted successfully.");
    } catch (e: any) {
      setIsProcessing(false);
      let errMsg = e.message || String(e);
      if (e.code === 'auth/requires-recent-login') {
        errMsg = "For security reasons, please sign out and sign back in again before deleting your account.";
      }
      setAppError(errMsg);
      setTimeout(() => setAppError(null), 6000);
      console.error("Account delete error:", e);
    }
  };

  const submitReport = async () => {
    if (!user || !showReportModal || !reportReason) return;
    try {
      setIsProcessing(true);
      await addDoc(collection(db, 'reports'), {
        targetId: showReportModal.id,
        targetType: showReportModal.type,
        reporterId: user.uid,
        reason: reportReason,
        createdAt: serverTimestamp()
      });
      
      setIsProcessing(false);
      setShowReportModal(null);
      setReportReason('');
      setSaveSuccess("Report submitted. Thank you for helping keep RetivoX safe.");
    } catch (e) {
      setIsProcessing(false);
      handleFirestoreError(e, OperationType.CREATE, 'reports');
    }
  };

  const switchRole = async (newRole: UserRole) => {
    if (!user) return;
    try {
      await updateDoc(doc(db, 'users', user.uid), { role: newRole });
      setActiveTab('home');
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, `users/${user.uid}`);
    }
  };

  // --- Partner Actions ---
  const createBusiness = async (name: string, type: 'cafe' | 'gym' = 'cafe') => {
    if (!user) return;
    try {
      // Update user role to partner first to allow business creation
      const userRef = doc(db, 'users', user.uid);
      await updateDoc(userRef, { role: 'partner' });

      // Generate a simple unique-looking ID
      const randomId = Math.floor(1000 + Math.random() * 9000);
      const displayId = `#${randomId}`;

      await addDoc(collection(db, 'businesses'), {
        name,
        displayId,
        type,
        ownerId: user.uid,
        createdAt: serverTimestamp(),
        location: '',
        contactNumber: '',
        logoUrl: ''
      });

      // Notify Admins
      notifyAdmins("New Cafe Registered", `${name} has joined the platform!`, '/admin');
    } catch (e) {
      handleFirestoreError(e, OperationType.CREATE, 'businesses');
    }
  };

  const updateBusiness = async (data: Partial<Business>) => {
    const myBiz = businesses.find(b => b.ownerId === user?.uid);
    if (!myBiz) return;
    try {
      await updateDoc(doc(db, 'businesses', myBiz.id), data);
      setShowBusinessSettings(false);
      setSaveSuccess("Café details updated successfully!");
      setTimeout(() => setSaveSuccess(null), 3000);
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, `businesses/${myBiz.id}`);
    }
  };

  const deleteBusinessById = async (biz: Business) => {
    setIsDeletingCafe(true);
    try {
      const progSnap = await getDocs(query(collection(db, 'programs'), where('businessId', '==', biz.id)));
      for (const p of progSnap.docs) {
        await deleteDoc(p.ref);
      }
      const cardSnap = await getDocs(query(collection(db, 'loyaltyCards'), where('businessId', '==', biz.id)));
      for (const c of cardSnap.docs) {
        await deleteDoc(c.ref);
      }
      await deleteDoc(doc(db, 'businesses', biz.id));

      if (selectedAdminBizId === biz.id) {
        setSelectedAdminBizId(null);
      }
      setCafeToDelete(null);
      setSaveSuccess(`Cafe "${biz.name} ${biz.displayId}" deleted successfully.`);
      setTimeout(() => setSaveSuccess(null), 4000);
    } catch (err: any) {
      console.error("Failed to delete business:", err);
      handleFirestoreError(err, OperationType.DELETE, `businesses/${biz.id}`);
    } finally {
      setIsDeletingCafe(false);
    }
  };

  const handleSignOut = async () => {
    setShowSignOutConfirm(false);
    try {
      await signOut(auth);
      setIsAdminMode(false);
      setSelectedAdminBizId(null);
      setHasSetInitialTab(false);
      setActiveTab('partner');
      setAuthView('main');
      setUsername('');
      setEmail('');
      setPin('');
      setConfirmPin('');
      setShowPin(false);
      setAppError(null);
      setSaveSuccess(null);
    } catch (e) {
      console.error("Error signing out:", e);
    }
  };

  const createProgram = async (businessId: string, title: string, itemName: string, goal: number, reward: string) => {
    try {
      await addDoc(collection(db, 'programs'), {
        businessId,
        title,
        itemName,
        goal,
        reward,
        isActive: true,
        createdAt: serverTimestamp()
      });

      // Notify Admins
      const biz = businesses.find(b => b.id === businessId);
      notifyAdmins("New Program Created", `${biz?.name} added a new program: ${title}`, '/admin');
    } catch (e) {
      handleFirestoreError(e, OperationType.CREATE, 'programs');
    }
  };

  const updateProgram = async (programId: string, data: Partial<LoyaltyProgram>) => {
    try {
      await updateDoc(doc(db, 'programs', programId), data);
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, `programs/${programId}`);
    }
  };

  const deleteProgram = async (programId: string) => {
    try {
      await updateDoc(doc(db, 'programs', programId), { 
        isActive: false,
        closedAt: serverTimestamp()
      });
      setProgramToDelete(null);
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, `programs/${programId}`);
    }
  };

  // --- Customer Actions ---
  const joinProgram = async (programId: string, businessId: string) => {
    if (!user) return;
    const prog = programs.find(p => p.id === programId);
    if (!prog || !prog.isActive) {
      setAppError("This program is closed and no longer accepting new members.");
      return;
    }
    const biz = businesses.find(b => b.id === businessId);
    if (!biz) {
      setAppError("Could not find business info. Please try again in a moment.");
      return;
    }
    
    try {
      const docRef = await addDoc(collection(db, 'loyaltyCards'), {
        userId: user.uid,
        programId,
        businessId,
        businessOwnerId: biz.ownerId, // Now guaranteed to be correct if biz exists
        businessName: biz.name,
        businessLogo: biz.logoUrl || '',
        programTitle: prog.title,
        itemName: prog.itemName,
        goal: prog.goal,
        currentStamps: 0,
        lastUpdated: serverTimestamp()
      });
      setJustJoined(docRef.id);
      setShowJoinQR(null);
      
      // Auto-switch to wallet after a delay
      setTimeout(() => {
        setJustJoined(null);
        setActiveTab('wallet');
      }, 5000);
    } catch (e) {
      handleFirestoreError(e, OperationType.CREATE, 'loyaltyCards');
    }
  };

  const addStamp = async (tokenOrId: string) => {
    let cardId = tokenOrId;
    if (tokenOrId.startsWith('card:')) {
      cardId = tokenOrId.replace('card:', '').trim();
    }
    
    // Validate if it's a secure token
    if (tokenOrId.startsWith('v1:')) {
      const validation = validateSecureToken(tokenOrId);
      if (!validation.valid) {
        const msg = validation.error || "Invalid or expired QR code.";
        setScanResult(`Error: ${msg}`);
        setStampError(msg);
        await stopScanner();
        setTimeout(() => {
          setStampError(null);
          setScanResult(null);
          isProcessingScan.current = false;
        }, 3000);
        return;
      }
      cardId = validation.cardId!;
    }

    // Search in allCards (since partner is scanning a customer)
    const card = allCards.find(c => c.id === cardId);
    if (!card) {
      const msg = "Card not found. Please ensure the QR code is a valid loyalty card.";
      setScanResult(`Error: ${msg}`);
      setStampError(msg);
      
      // Background cleanup
      await stopScanner();
      
      setTimeout(() => {
        setStampError(null);
        setScanResult(null);
        setActiveTab('partner');
        isProcessingScan.current = false;
      }, 3000);
      return;
    }

    if (card.isCompleted) {
      const msg = "This loyalty pass is already completed.";
      setScanResult(`Error: ${msg}`);
      setStampError(msg);
      
      await stopScanner();
      
      setTimeout(() => {
        setStampError(null);
        setScanResult(null);
        setActiveTab('partner');
        isProcessingScan.current = false;
      }, 3000);
      return;
    }
    
    const prog = programs.find(p => p.id === card.programId);
    // Allow stamps if program is active OR if it's in the grace period (inactive but has closedAt)
    const isGracePeriod = prog && !prog.isActive && !!prog.closedAt;
    
    if (!prog || (!prog.isActive && !isGracePeriod)) {
      const msg = !prog ? "Program not found" : "This program is no longer active and the grace period has ended.";
      setScanResult(`Error: ${msg}`);
      setStampError(msg);
      
      await stopScanner();
      
      setTimeout(() => {
        setStampError(null);
        setScanResult(null);
        setActiveTab('partner');
        isProcessingScan.current = false;
      }, 3000);
      return;
    }

    try {
      const cardRef = doc(db, 'loyaltyCards', cardId);
      let message = "";
      
      await runTransaction(db, async (transaction) => {
        const cardDoc = await transaction.get(cardRef);
        if (!cardDoc.exists()) {
          throw new Error("Card not found in database.");
        }
        
        const cardData = cardDoc.data() as LoyaltyCard;
        
        // 1. 2-Second Cooldown: Prevent accidental double-scans
        const lastUpdated = cardData.lastUpdated?.toMillis() || 0;
        const cooldownMs = 2 * 1000; // 2 seconds
        if (Date.now() - lastUpdated < cooldownMs) {
          const secondsLeft = Math.ceil((cooldownMs - (Date.now() - lastUpdated)) / 1000);
          throw new Error(`Cooldown active. Please wait ${secondsLeft}s before next stamp.`);
        }

        if (cardData.currentStamps >= prog.goal) {
          // Redemption logic
          if (!prog.isActive) {
            transaction.update(cardRef, {
              isCompleted: true,
              lastUpdated: serverTimestamp()
            });
            message = "Reward redeemed! Pass completed.";
          } else {
            transaction.update(cardRef, {
              currentStamps: 0,
              lastUpdated: serverTimestamp()
            });
            message = "Reward redeemed! Card reset for next reward.";
          }
        } else {
          // Adding a stamp
          const newStamps = cardData.currentStamps + 1;
          transaction.update(cardRef, {
            currentStamps: increment(1),
            lastUpdated: serverTimestamp()
          });
          
          if (newStamps === prog.goal) {
            message = "Goal reached! Reward is ready for the customer.";
          } else {
            message = `Stamp added! (${newStamps}/${prog.goal})`;
          }
        }
      });
      
      setScanResult(message);
      setStampSuccess(message);

      // Notify Admins
      if (message.includes("redeemed")) {
        notifyAdmins("Reward Redeemed!", `A customer at ${prog?.businessId} just redeemed their reward!`, '/admin');
      } else {
        notifyAdmins("Stamp Added", `A customer just got a stamp at ${prog?.businessId}`, '/admin');
      }
      
      // Background cleanup
      await stopScanner();
      
      setTimeout(() => {
        setStampSuccess(null);
        setScanResult(null);
        setActiveTab('partner');
        isProcessingScan.current = false;
      }, 3000);
    } catch (e: any) {
      isProcessingScan.current = false;
      await stopScanner();
      
      const errorMessage = e?.message || String(e);
      if (errorMessage.includes("Cooldown active")) {
        setStampError(errorMessage);
        setScanResult(`Error: ${errorMessage}`);
        
        setTimeout(() => {
          setStampError(null);
          setScanResult(null);
          setActiveTab('partner');
        }, 3000);
      } else {
        handleFirestoreError(e, OperationType.UPDATE, `loyaltyCards/${cardId}`);
      }
    }
  };
  if (isSplashing) {
    return (
      <div className="h-screen bg-white flex flex-col items-center justify-center p-6 text-center max-w-md mx-auto relative overflow-hidden shadow-2xl">
        <motion.div 
          initial={{ scale: 0.8, opacity: 0 }} 
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.8, ease: "easeOut" }}
          className="w-24 h-24 mb-6 shadow-[0_15px_35px_rgba(61,43,31,0.25)] overflow-hidden rounded-[2rem] bg-coffee-dark/5 p-1"
        >
          <img src="icon.png" alt="RetivoX Logo" className="w-full h-full object-contain rounded-[1.8rem]" />
        </motion.div>
        <motion.h1 
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4, duration: 0.6 }}
          className="text-4xl font-black text-gray-900 mb-2 tracking-tighter select-none"
        >
          <span className="inline-block [text-shadow:1px_1px_0_#dcd3cc,_2px_2px_0_#c4b5aa]">
            Retivo<span className="text-[#8d6e63]">X</span>
          </span>
         </motion.h1>
         <div className="mt-6 flex flex-col items-center gap-2">
          <div className="w-24 h-1 bg-gray-100 rounded-full overflow-hidden">
             <motion.div 
               className="h-full bg-coffee-dark" 
               initial={{ width: 0 }}
               animate={{ width: "100%" }}
               transition={{ duration: 2.2, ease: "easeInOut" }}
             />
          </div>
          <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest mt-1">Turning moments into habits...</p>
        </div>
      </div>
    );
  }

  if (loading || isAuthChecking) return (
    <div className="h-screen flex items-center justify-center bg-gray-50 max-w-md mx-auto relative shadow-2xl">
      <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: "linear" }} className="w-12 h-12 border-4 border-coffee-dark border-t-transparent rounded-full" />
    </div>
  );

  if (publicJoinId) {
    return (
      <PublicCustomerPassView 
        programId={publicJoinId}
        onSwitchToOwner={() => {
          setPublicJoinId(null);
          localStorage.removeItem('pending_join_program_id');
          const newUrl = window.location.origin + window.location.pathname;
          window.history.replaceState({}, document.title, newUrl);
        }}
      />
    );
  }

  if (!user || isDeletingAccountFlow) return (
    <div className="h-screen bg-white flex flex-col items-center justify-center p-6 text-center max-w-md mx-auto relative overflow-hidden shadow-2xl">
      <motion.div 
        initial={{ scale: 0.8, opacity: 0 }} 
        animate={{ scale: 1, opacity: 1 }} 
        className={`${authView === 'main' ? 'w-24 h-24 mb-6' : 'w-16 h-16 mb-2'} shadow-[0_15px_35px_rgba(61,43,31,0.25)] overflow-hidden rounded-[2.3rem] transition-all duration-300`}
      >
        <img 
          src="icon.png" 
          alt="RetivoX Logo" 
          className="w-full h-full object-cover"
        />
      </motion.div>
      
      <h1 className={`${authView === 'main' ? 'text-4xl mb-2' : 'text-3xl mb-0.5'} font-black text-gray-900 tracking-tighter select-none transition-all duration-300`}>
        <span className="inline-block [text-shadow:1px_1px_0_#dcd3cc,_2px_2px_0_#c4b5aa]">
          Retivo<span className="text-[#8d6e63]">X</span>
        </span>
      </h1>
      <p className={`${authView === 'main' ? 'text-base mb-8' : 'text-xs mb-4'} text-gray-500 max-w-[300px] font-medium leading-tight transition-all duration-300`}>
        Turn moments into habits
      </p>
      
      <AnimatePresence>
        {appError && (
          <motion.div 
            initial={{ opacity: 0, y: -10 }} 
            animate={{ opacity: 1, y: 0 }} 
            exit={{ opacity: 0, y: -10 }}
            className="w-full max-w-xs mb-8 p-4 bg-red-50 border border-red-100 rounded-2xl text-red-600 text-sm font-medium flex flex-col gap-3 text-left relative"
          >
            <div className="flex items-start gap-3">
              <AlertCircle size={18} className="shrink-0 mt-0.5" />
              <p className="pr-6 leading-tight">{appError}</p>
            </div>
            
            {appError.includes("new tab") && (
              <button 
                onClick={() => window.open(window.location.href, '_blank')}
                className="w-full py-2.5 bg-red-600 text-white rounded-xl text-xs font-bold shadow-sm hover:bg-red-700 transition-colors flex items-center justify-center gap-2"
              >
                <ExternalLink size={14} /> Open in New Tab
              </button>
            )}

            <button 
              onClick={() => setAppError(null)}
              className="absolute top-4 right-4 text-red-400 hover:text-red-600"
            >
              <X size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="w-full max-w-xs space-y-4">
        {authView === 'main' ? (
          <>
            {!HIDE_PARTNER_PORTAL && (
              <button 
                onClick={() => { 
                  setAuthView('login'); 
                  setAuthRole('partner'); 
                  setUsername('');
                  setPin('');
                  setAppError(null);
                }} 
                className="w-full py-5 bg-coffee-dark text-white rounded-[1.5rem] font-bold flex items-center justify-center gap-3 shadow-[0_10px_25px_rgba(61,43,31,0.25)] active:scale-95 transition-all text-lg"
              >
                <LogIn size={22} /> Partner Portal
              </button>
            )}
            
            {!HIDE_ADMIN_PORTAL && (
              <button 
                onClick={() => { 
                  setAuthView('login'); 
                  setAuthRole('admin'); 
                  setUsername('anoopjoy1988@gmail.com');
                  setPin('');
                  setAppError(null);
                }} 
                className="w-full py-5 bg-coffee-accent text-white rounded-[1.5rem] font-bold flex items-center justify-center gap-3 shadow-[0_10px_25px_rgba(141,110,99,0.25)] active:scale-95 transition-all text-lg"
              >
                <ShieldCheck size={22} /> Admin Portal
              </button>
            )}
          </>
        ) : (
          <motion.div 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-4 text-left"
          >
            <div className="flex items-center gap-2 mb-2">
              {!(HIDE_ADMIN_PORTAL || HIDE_PARTNER_PORTAL) && (
                <button 
                  onClick={() => { 
                    setAuthView('main'); 
                    setAppError(null);
                    setUsername('');
                    setEmail('');
                    setPin('');
                    setConfirmPin('');
                    setDisplayName('');
                    setShowPin(false);
                  }} 
                  className="p-2 -ml-2 text-gray-400 hover:text-gray-600 active:scale-90 transition-all"
                >
                  <X size={20} />
                </button>
              )}
              <h2 className="font-black text-xl text-gray-900 tracking-tight">
                {authView === 'forgot' ? (authRole === 'admin' ? 'Reset Admin 6-Digit PIN' : 'Reset Partner 6-Digit PIN') : 
                 authView === 'signup' ? 'Create Account' : 
                 authRole === 'admin' ? 'Admin Portal' : 'Partner Portal'}
              </h2>
            </div>

            {authView === 'login' && authRole === 'admin' && (
              <div className="p-3 bg-amber-50/80 border border-amber-200/80 rounded-2xl flex items-start gap-2.5 mb-2">
                <ShieldCheck size={18} className="text-amber-700 shrink-0 mt-0.5" />
                <div>
                  <p className="text-[11px] font-bold text-amber-900 leading-tight">Admin Authorization Required</p>
                  <p className="text-[10px] text-amber-700 leading-tight mt-0.5">
                    This portal is strictly restricted to <span className="font-bold underline">anoopjoy1988@gmail.com</span>. Sign in with your username/email and 6-digit PIN.
                  </p>
                </div>
              </div>
            )}

            {authView === 'login' && authRole === 'partner' && (
              <p className="text-xs text-gray-500 mb-1 leading-relaxed">
                Sign in with your short username and 6-digit PIN.
              </p>
            )}

            {authView === 'login' ? (
              <div className="space-y-3">
                <div className="space-y-0.5">
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] font-bold text-gray-400 ml-1 uppercase tracking-widest flex items-center gap-1">
                      <User size={12} />
                      {authRole === 'admin' ? 'Admin Email / Username' : 'Username or Email'}
                    </label>
                    {authRole === 'admin' && (
                      <div className="flex items-center gap-1.5 text-[10px] font-bold">
                        {username ? (
                          <button
                            type="button"
                            onClick={() => setUsername('')}
                            className="text-gray-400 hover:text-red-500 transition-colors"
                          >
                            Clear field
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setUsername('anoopjoy1988@gmail.com')}
                            className="text-coffee-accent hover:underline transition-all"
                          >
                            Use anoopjoy1988@gmail.com
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="relative">
                    <input 
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder={authRole === 'admin' ? "anoopjoy1988@gmail.com" : "Your username or email"}
                      autoCapitalize="none"
                      autoCorrect="off"
                      autoComplete="off"
                      className="w-full px-4 py-2.5 text-sm bg-gray-50 border border-gray-100 rounded-xl focus:ring-2 focus:ring-coffee-accent focus:border-transparent outline-none transition-all pr-9"
                    />
                    {username && (
                      <button 
                        type="button"
                        onClick={() => setUsername('')}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors p-1"
                        title="Clear field"
                      >
                        <X size={15} />
                      </button>
                    )}
                  </div>
                </div>

                <div className="space-y-0.5">
                  <label className="text-[10px] font-bold text-gray-400 ml-1 uppercase tracking-widest flex items-center gap-1">
                    <KeyRound size={12} />
                    6-Digit PIN Code
                  </label>
                  <div className="relative">
                    <input 
                      type={showPin ? "text" : "password"}
                      inputMode="numeric"
                      maxLength={6}
                      pattern="[0-9]*"
                      value={pin}
                      onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="••••••"
                      className="w-full px-4 py-2.5 text-center tracking-[0.6em] font-mono font-bold text-base bg-gray-50 border border-gray-100 rounded-xl focus:ring-2 focus:ring-coffee-accent focus:border-transparent outline-none transition-all pr-12"
                    />
                    <button 
                      type="button"
                      onClick={() => setShowPin(!showPin)}
                      className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
                    >
                      {showPin ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </div>

                <button 
                  onClick={handleAuth}
                  disabled={isProcessing}
                  className="w-full py-3 bg-coffee-dark text-white rounded-xl font-bold flex items-center justify-center gap-2.5 shadow-[0_8px_20px_rgba(61,43,31,0.15)] active:scale-95 disabled:opacity-50 transition-all text-sm"
                >
                  {isProcessing ? (
                    <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: 'linear' }} className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full" />
                  ) : (
                    <>
                      <LogIn size={18} /> Sign In
                    </>
                  )}
                </button>

                <div className="flex flex-col items-center gap-2 pt-1">
                  {authRole !== 'admin' && (
                    <button 
                      onClick={() => {
                        setAuthView('signup');
                        setAppError(null);
                      }}
                      className="text-xs font-bold text-coffee-accent hover:text-coffee-dark underline-offset-4 active:scale-95 transition-all"
                    >
                      New partner? Create an account
                    </button>
                  )}

                  <button 
                    onClick={() => {
                      setAuthView('forgot');
                      setAppError(null);
                      if (authRole === 'admin') {
                        setEmail('anoopjoy1988@gmail.com');
                      }
                    }}
                    className="text-[10px] font-medium text-gray-400 hover:text-gray-600 active:scale-95 transition-all"
                  >
                    {authRole === 'admin' ? 'Forgot Admin 6-digit PIN?' : 'Forgot 6-digit PIN?'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {authView === 'forgot' && (
                  <>
                    <div className="p-3 bg-blue-50 rounded-xl border border-blue-100 flex items-start gap-2 mb-2">
                      <AlertCircle size={16} className="text-blue-500 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-[10px] text-blue-700 leading-tight font-bold">
                          {authRole === 'admin' ? 'Admin 6-Digit PIN Recovery' : 'Partner 6-Digit PIN Recovery'}
                        </p>
                        <p className="text-[10px] text-blue-600 leading-tight">
                          We will email you a secure link to set your new 6-digit PIN code.
                        </p>
                      </div>
                    </div>

                    <div className="space-y-0.5">
                      <label className="text-[10px] font-bold text-gray-400 ml-1 uppercase tracking-widest">
                        {authRole === 'admin' ? 'Admin Email Address' : 'Username or Email'}
                      </label>
                      <input 
                        type={authRole === 'admin' ? "email" : "text"}
                        value={authRole === 'admin' ? (email || 'anoopjoy1988@gmail.com') : (username || email)}
                        onChange={(e) => {
                          if (authRole === 'admin') {
                            setEmail(e.target.value);
                          } else {
                            setUsername(e.target.value);
                            setEmail(e.target.value);
                          }
                        }}
                        placeholder={authRole === 'admin' ? "anoopjoy1988@gmail.com" : "Enter your username or email"}
                        className="w-full px-4 py-2.5 text-sm bg-gray-50 border border-gray-100 rounded-xl focus:ring-2 focus:ring-coffee-accent focus:border-transparent outline-none transition-all"
                      />
                    </div>
                  </>
                )}

                {authView === 'signup' && (
                  <>
                    <div className="space-y-0.5">
                      <label className="text-[10px] font-bold text-gray-400 ml-1 uppercase tracking-widest">Full Name</label>
                      <input 
                        type="text"
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        placeholder="Enter your name"
                        className="w-full px-4 py-2.5 text-sm bg-gray-50 border border-gray-100 rounded-xl focus:ring-2 focus:ring-coffee-accent focus:border-transparent outline-none transition-all"
                      />
                    </div>

                    <div className="space-y-0.5">
                      <label className="text-[10px] font-bold text-gray-400 ml-1 uppercase tracking-widest">Short Username</label>
                      <input 
                        type="text"
                        value={username}
                        onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                        placeholder="e.g. anoop88"
                        autoCapitalize="none"
                        autoCorrect="off"
                        className="w-full px-4 py-2.5 text-sm bg-gray-50 border border-gray-100 rounded-xl focus:ring-2 focus:ring-coffee-accent focus:border-transparent outline-none transition-all font-mono"
                      />
                      <p className="text-[9px] text-gray-400 ml-1">Use this short name to log in quickly without re-typing email.</p>
                    </div>

                    <div className="space-y-0.5">
                      <label className="text-[10px] font-bold text-gray-400 ml-1 uppercase tracking-widest">
                        {authRole === 'admin' ? 'Admin Email (strictly restricted)' : 'Email Address'}
                      </label>
                      <input 
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder={authRole === 'admin' ? "anoopjoy1988@gmail.com" : "name@example.com"}
                        className="w-full px-4 py-2.5 text-sm bg-gray-50 border border-gray-100 rounded-xl focus:ring-2 focus:ring-coffee-accent focus:border-transparent outline-none transition-all"
                      />
                    </div>

                    <div className="space-y-0.5">
                      <label className="text-[10px] font-bold text-gray-400 ml-1 uppercase tracking-widest">6-Digit PIN Code</label>
                      <div className="relative">
                        <input 
                          type={showPin ? "text" : "password"}
                          inputMode="numeric"
                          maxLength={6}
                          pattern="[0-9]*"
                          value={pin}
                          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                          placeholder="••••••"
                          className="w-full px-4 py-2.5 text-center tracking-[0.6em] font-mono font-bold text-base bg-gray-50 border border-gray-100 rounded-xl focus:ring-2 focus:ring-coffee-accent focus:border-transparent outline-none transition-all pr-12"
                        />
                        <button 
                          type="button"
                          onClick={() => setShowPin(!showPin)}
                          className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
                        >
                          {showPin ? <EyeOff size={18} /> : <Eye size={18} />}
                        </button>
                      </div>
                    </div>

                    <div className="space-y-0.5">
                      <label className="text-[10px] font-bold text-gray-400 ml-1 uppercase tracking-widest">Confirm 6-Digit PIN</label>
                      <input 
                        type={showPin ? "text" : "password"}
                        inputMode="numeric"
                        maxLength={6}
                        pattern="[0-9]*"
                        value={confirmPin}
                        onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        placeholder="••••••"
                        className="w-full px-4 py-2.5 text-center tracking-[0.6em] font-mono font-bold text-base bg-gray-50 border border-gray-100 rounded-xl focus:ring-2 focus:ring-coffee-accent focus:border-transparent outline-none transition-all"
                      />
                    </div>
                  </>
                )}

                <button 
                  onClick={handleAuth}
                  disabled={isProcessing}
                  className="w-full py-3 bg-coffee-dark text-white rounded-xl font-bold flex items-center justify-center gap-2.5 shadow-[0_8px_20px_rgba(61,43,31,0.15)] active:scale-95 disabled:opacity-50 transition-all mt-3 text-sm"
                >
                  {isProcessing ? (
                    <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: 'linear' }} className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full" />
                  ) : (
                    <>
                      <LogIn size={18} />
                      {authView === 'signup' ? 'Create Account' : 'Send 6-Digit PIN Reset Link'}
                    </>
                  )}
                </button>

                <div className="flex flex-col items-center gap-2 pt-1">
                  <button 
                    onClick={() => {
                      setAuthView('login');
                      setAppError(null);
                    }}
                    className="text-xs font-bold text-coffee-accent hover:text-coffee-dark underline-offset-4 active:scale-95 transition-all"
                  >
                    Back to login
                  </button>
                </div>
              </div>
            )}
          </motion.div>
        )}

        <div className="pt-4 flex flex-col items-center gap-2 mt-auto">
          <div 
            className="text-gray-400 text-[9px] font-bold uppercase tracking-wider flex items-center gap-1"
          >
            Need help? help.retivox@gmail.com
          </div>
          <div className="flex gap-4">
            <button 
              onClick={() => setShowTerms(true)}
              className="text-gray-400 text-[10px] font-medium hover:text-gray-600 underline underline-offset-4"
            >
              Terms
            </button>
            <button 
              onClick={() => setShowPrivacy(true)}
              className="text-gray-400 text-[10px] font-medium hover:text-gray-600 underline underline-offset-4"
            >
              Privacy Policy
            </button>
          </div>
          <p className="text-[10px] text-gray-300">By signing in, you agree to our terms.</p>
        </div>
      </div>

      <AnimatePresence>
        {showPrivacy && (
          <motion.div 
            initial={{ opacity: 0 }} 
            animate={{ opacity: 1 }} 
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-white overflow-y-auto p-8"
          >
            <div className="max-w-md mx-auto space-y-8 pb-20">
              <div className="flex items-center justify-between sticky top-0 bg-white py-4 border-b border-gray-100 mb-6">
                <h2 className="text-2xl font-black tracking-tight">Privacy Policy</h2>
                <button onClick={() => setShowPrivacy(false)} className="p-2 bg-gray-100 rounded-full"><X size={20} /></button>
              </div>

              <div className="prose prose-sm text-gray-600 space-y-6 text-left leading-relaxed">
                <section>
                  <h3 className="font-bold text-gray-900 text-lg">1. Data We Collect</h3>
                  <p>We collect your name and email address provided during signup. We also collect device notification tokens if you enable push notifications, and transaction data related to your loyalty stamps.</p>
                </section>

                <section>
                  <h3 className="font-bold text-gray-900 text-lg">2. How We Use Data</h3>
                  <p>Your data is used solely to provide loyalty services, track your stamps, and send you relevant rewards notifications. We do not sell or share your data with third-party advertisers.</p>
                </section>

                <section>
                  <h3 className="font-bold text-gray-900 text-lg">3. Data Storage</h3>
                  <p>All data is stored securely in Google Firebase. You can request to delete your account and all associated data at any time through the profile settings in the app.</p>
                </section>

                <section>
                  <h3 className="font-bold text-gray-900 text-lg">4. Cookies</h3>
                  <p>We use essential local storage and cookies to keep you signed in and remember your preferences.</p>
                </section>

                <p className="text-[10px] text-gray-400 pt-10">Last Updated: April 14, 2026</p>
              </div>

              <button 
                onClick={() => setShowPrivacy(false)}
                className="w-full py-4 bg-gray-900 text-white rounded-2xl font-bold shadow-xl active:scale-95 transition-transform"
              >
                Close
              </button>
            </div>
          </motion.div>
        )}

        {showTerms && (
          <motion.div 
            initial={{ opacity: 0 }} 
            animate={{ opacity: 1 }} 
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-white overflow-y-auto p-8"
          >
            <div className="max-w-md mx-auto space-y-8 pb-20">
              <div className="flex items-center justify-between sticky top-0 bg-white py-4 border-b border-gray-100 mb-6">
                <h2 className="text-2xl font-black tracking-tight">Terms & Conditions</h2>
                <button onClick={() => setShowTerms(false)} className="p-2 bg-gray-100 rounded-full"><X size={20} /></button>
              </div>

              <div className="prose prose-sm text-gray-600 space-y-6 text-left leading-relaxed">
                <section>
                  <h3 className="font-bold text-gray-900 text-lg">1. Acceptance of Terms</h3>
                  <p>By accessing or using RetivoX, you agree to be bound by these Terms and Conditions. If you do not agree, you may not use the app.</p>
                </section>

                <section>
                  <h3 className="font-bold text-gray-900 text-lg">2. Eligibility</h3>
                  <p className="font-bold text-coffee-dark">You must be at least 18 years of age to use this service.</p>
                </section>

                <section>
                  <h3 className="font-bold text-gray-900 text-lg">3. Description of Service</h3>
                  <p>RetivoX is a digital loyalty platform facilitating rewards between Businesses ("Partners") and Customers. RetivoX is not responsible for the fulfillment of rewards by Partners.</p>
                </section>

                <section>
                  <h3 className="font-bold text-gray-900 text-lg">4. User Responsibility</h3>
                  <p>Users are responsible for maintaining account security. Digital stamps have no cash value and are subject to the terms of the issuing Business Partner.</p>
                </section>

                <section>
                  <h3 className="font-bold text-gray-900 text-lg">5. Push Notifications</h3>
                  <p>RetivoX uses push notifications to provide real-time updates on your loyalty status and rewards. You can opt-out of these notifications at any time through your browser or device settings.</p>
                </section>

                <section>
                  <h3 className="font-bold text-gray-900 text-lg">6. Privacy</h3>
                  <p>We collect minimal data (name, email, and device notification tokens) to provide loyalty services and alerts. We do not sell your personal data to third parties. Your data is stored securely using Firebase.</p>
                </section>

                <section>
                  <h3 className="font-bold text-gray-900 text-lg">7. Limitation of Liability</h3>
                  <p>RetivoX is provided "as is" without warranties of any kind. We are not liable for any business disputes between Partners and Customers, or for any failure in the delivery of push notifications.</p>
                </section>

                <p className="text-[10px] text-gray-400 pt-10">Last Updated: April 14, 2026</p>
              </div>

              <button 
                onClick={() => setShowTerms(false)}
                className="w-full py-4 bg-gray-900 text-white rounded-2xl font-bold shadow-xl active:scale-95 transition-transform"
              >
                I Understand
              </button>
            </div>
          </motion.div>
        )}



        {showDeleteConfirm && (
          <div className="fixed inset-0 z-[110] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6">
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="bg-white w-full max-w-xs rounded-[2.5rem] p-8 text-center space-y-6">
              <div className="w-14 h-14 bg-red-50 text-red-500 rounded-full flex items-center justify-center mx-auto">
                <AlertTriangle size={28} />
              </div>
              <div className="space-y-2">
                <h3 className="text-lg font-bold text-gray-900">Delete Your Account?</h3>
                <p className="text-xs text-gray-500 leading-relaxed">
                  This will permanently delete your profile, loyalty history, and cannot be undone. 
                  To confirm, please type <strong className="text-red-600 select-none">DELETE</strong> below:
                </p>
              </div>
              
              <input
                type="text"
                placeholder="Type DELETE to confirm"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value.toUpperCase())}
                className="w-full px-4 py-3 bg-red-50/50 border border-red-100 rounded-xl text-center text-xs font-bold text-red-700 tracking-wider placeholder:text-gray-400 placeholder:font-normal focus:outline-none focus:ring-2 focus:ring-red-500 focus:bg-white uppercase transition-all"
              />

              <div className="space-y-2 pt-1">
                <button 
                  onClick={deleteAccount}
                  disabled={isProcessing || deleteConfirmText !== 'DELETE'}
                  className="w-full py-3.5 bg-red-600 text-white rounded-2xl font-bold shadow-lg shadow-red-200 active:scale-95 transition-transform disabled:opacity-40 disabled:scale-100 disabled:shadow-none text-sm"
                >
                  {isProcessing ? 'Deleting...' : 'Permanently Delete Account'}
                </button>
                <button 
                  onClick={() => {
                    setShowDeleteConfirm(false);
                    setIsDeletingAccountFlow(false);
                    setDeleteConfirmText('');
                  }} 
                  className="w-full py-3.5 bg-gray-50 text-gray-500 hover:bg-gray-100 rounded-2xl font-bold active:scale-95 transition-transform text-sm"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </div>
        )}

        {showReportModal && (
          <div className="fixed inset-0 z-[110] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6">
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="bg-white w-full max-w-xs rounded-[2.5rem] p-8 space-y-6">
              <div className="flex items-center justify-between">
                <h3 className="text-xl font-bold">Report Content</h3>
                <button onClick={() => setShowReportModal(null)} className="p-2 bg-gray-100 rounded-full"><X size={16} /></button>
              </div>
              <p className="text-xs text-gray-500">Reporting: <span className="font-bold text-gray-900">{showReportModal.name}</span></p>
              
              <div className="space-y-2">
                <label className="text-[10px] font-bold uppercase text-gray-400 ml-1">Reason for report</label>
                <textarea 
                  value={reportReason}
                  onChange={(e) => setReportReason(e.target.value)}
                  placeholder="e.g. Offensive language, fake business, etc."
                  className="w-full p-4 bg-gray-50 rounded-2xl text-sm border-none focus:ring-2 focus:ring-coffee-dark h-32 resize-none"
                />
              </div>

              <button 
                onClick={submitReport}
                disabled={isProcessing || !reportReason}
                className="w-full py-4 bg-gray-900 text-white rounded-2xl font-bold shadow-xl active:scale-95 transition-transform disabled:opacity-50"
              >
                {isProcessing ? 'Submitting...' : 'Submit Report'}
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );

  const renderContent = () => {
    if (appError) return <ErrorBoundary error={appError} reset={() => setAppError(null)} />;

    return (
      <div className="flex flex-col flex-1 pb-32">
        {/* Verification Banner */}
        {user && !user.emailVerified && (
          <div className="mx-6 mb-4 p-4 bg-amber-50 rounded-2xl border border-amber-100 flex items-start gap-4">
            <div className="p-2 bg-amber-100 rounded-full text-amber-600">
              <Mail size={18} />
            </div>
            <div className="flex-1 space-y-1">
              <h4 className="text-sm font-bold text-amber-900">Verify your email</h4>
              <p className="text-xs text-amber-700 leading-relaxed">
                Please verify your email address to ensure your account remains secure and authorized for rewards.
              </p>
              <button 
                onClick={sendVerificationEmail}
                disabled={isProcessing}
                className="text-xs font-bold text-amber-800 underline underline-offset-4 active:opacity-70 disabled:opacity-50"
              >
                Resend verification email
              </button>
            </div>
          </div>
        )}

        {(() => {
          // --- ADMIN VIEW ---
          if (isAdminMode) {
            switch (activeTab) {
              case 'admin_home':
                const selectedBiz = businesses.find(b => b.id === selectedAdminBizId);

                return (
                  <motion.div key="admin_home" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 space-y-4 pb-24">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 bg-gray-900 rounded-xl flex items-center justify-center text-white shadow-lg">
                    <ShieldCheck size={18} />
                  </div>
                  <h1 className="text-xl font-black tracking-tight">
                    {selectedBiz ? 'Cafe Details' : 'System Overview'}
                  </h1>
                </div>
                <div className="flex items-center gap-2">
                  <button 
                    onClick={() => subscribeToPush()}
                    disabled={isSubscribing || !!pushSubscription}
                    className={`p-2 rounded-xl flex items-center gap-2 font-bold text-xs transition-all ${
                      pushSubscription 
                        ? 'bg-emerald-50 text-emerald-600 border border-emerald-100' 
                        : 'bg-coffee-dark text-white shadow-lg active:scale-95'
                    }`}
                  >
                    {isSubscribing ? (
                      <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1 }}><Bell size={18} /></motion.div>
                    ) : pushSubscription ? (
                      <CheckCircle2 size={18} />
                    ) : (
                      <Bell size={18} />
                    )}
                  </button>
                  {selectedBiz && (
                    <button 
                      onClick={() => setSelectedAdminBizId(null)}
                      className="p-2 bg-gray-100 text-gray-600 rounded-xl hover:bg-gray-200 transition-colors"
                    >
                      <X size={18} />
                    </button>
                  )}
                  <button 
                    onClick={() => setShowSignOutConfirm(true)}
                    className="p-2 bg-red-50 text-red-600 rounded-xl hover:bg-red-100 transition-colors"
                    title="Sign Out"
                  >
                    <Power size={18} />
                  </button>
                </div>
              </div>

              {!Capacitor.isNativePlatform() && !(import.meta as any).env.VITE_FCM_VAPID_KEY && (
                <div className="bg-amber-50 border border-amber-100 p-3 rounded-2xl flex items-start gap-2.5">
                  <AlertCircle className="text-amber-500 shrink-0 mt-0.5" size={16} />
                  <div>
                    <p className="text-amber-900 text-xs font-bold">Push Notifications Not Configured</p>
                    <p className="text-amber-700 text-[10px] mt-0.5 leading-relaxed">
                      To receive web alerts, you must add VAPID keys to env vars.
                    </p>
                  </div>
                </div>
              )}



              {businesses.length === 0 ? (
                <div className="bg-white p-10 rounded-[2rem] border border-gray-100 text-center space-y-3">
                  <Store className="mx-auto text-gray-200" size={40} />
                  <p className="text-gray-400 text-xs font-medium">No businesses registered in the system yet.</p>
                </div>
              ) : !selectedBiz ? (
                /* --- LIST VIEW: Cafe Names Only --- */
                <div className="space-y-2">
                  <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 ml-2">Registered Cafes</p>
                  {businesses.map(biz => (
                    <div
                      key={biz.id}
                      className="w-full bg-white p-3 rounded-2xl border border-gray-100 shadow-sm flex items-center justify-between group transition-all"
                    >
                      <button
                        onClick={() => setSelectedAdminBizId(biz.id)}
                        className="flex items-center gap-2.5 flex-1 min-w-0 text-left active:scale-[0.98] transition-transform"
                      >
                        <div className="w-9 h-9 bg-gray-50 rounded-xl flex items-center justify-center overflow-hidden border border-gray-100 group-hover:border-coffee-light transition-colors shrink-0">
                          {biz.logoUrl ? (
                            <img src={biz.logoUrl} alt="Logo" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                          ) : (
                            <Store className="text-gray-300" size={18} />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <h3 className="font-bold text-sm text-gray-900 group-hover:text-coffee-dark transition-colors truncate">{biz.name}</h3>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">{biz.displayId || 'No ID'}</span>
                            <span className="text-[8px] px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded font-mono truncate max-w-[140px]">
                              {biz.ownerId === user.uid ? 'Owner: You' : `Owner: ${biz.ownerId?.slice(0, 6)}...`}
                            </span>
                          </div>
                        </div>
                      </button>

                      <div className="flex items-center gap-1 shrink-0 ml-2">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setCafeToDelete(biz);
                          }}
                          className="p-2 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-xl transition-colors"
                          title="Delete Cafe"
                        >
                          <Trash2 size={16} />
                        </button>
                        <button
                          onClick={() => setSelectedAdminBizId(biz.id)}
                          className="p-1 text-gray-300 group-hover:text-coffee-accent transition-colors"
                        >
                          <ChevronRight size={18} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                /* --- DETAIL VIEW: Selected Cafe Only --- */
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
                  {(() => {
                    const biz = selectedBiz;
                    
                    // ONLY ACTIVE DATA (Programs)
                    const activeProgs = programs.filter(p => p.businessId === biz.id && p.isActive);
                    
                    // Metrics:
                    // 1. Active Programs: Number of active loyalty programs for this business.
                    // 2. Active Digital Passes: Number of non-completed cards currently being collected.
                    const bizCards = allCards.filter(c => c.businessId === biz.id);
                    const activeProgramsCount = activeProgs.length;
                    const activePassesCount = bizCards.filter(c => !c.isCompleted).length;
                    
                    // Top Individual Passes (Active only)
                    const topPasses = [...bizCards]
                      .filter(c => !c.isCompleted)
                      .sort((a, b) => b.currentStamps - a.currentStamps)
                      .slice(0, 3);

                    return (
                      <div className="bg-white p-4 rounded-[1.8rem] border border-gray-100 shadow-sm space-y-4">
                        {/* Header Info */}
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="w-12 h-12 bg-gray-50 rounded-xl flex items-center justify-center overflow-hidden border border-gray-100 shadow-inner shrink-0">
                              {biz.logoUrl ? (
                                <img src={biz.logoUrl} alt="Logo" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                              ) : (
                                <Store className="text-gray-300" size={18} />
                              )}
                            </div>
                            <div className="min-w-0">
                              <h3 className="font-black text-lg leading-tight text-gray-900 truncate">{biz.name}</h3>
                              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                <span className="px-1.5 py-0.5 bg-gray-900 text-white rounded text-[7px] font-black uppercase tracking-tighter">
                                  {biz.type}
                                </span>
                                <span className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">{biz.displayId || 'No ID'}</span>
                                <span className="text-[8px] text-gray-400 font-mono">
                                  Owner: {biz.ownerId === user.uid ? 'You (anoopjoy1988@gmail.com)' : biz.ownerId}
                                </span>
                              </div>
                            </div>
                          </div>

                          <button
                            onClick={() => setCafeToDelete(biz)}
                            className="px-3 py-2 bg-red-50 text-red-600 hover:bg-red-100 rounded-xl transition-colors flex items-center gap-1.5 text-xs font-bold shrink-0"
                            title="Delete this cafe"
                          >
                            <Trash2 size={15} />
                            <span>Delete</span>
                          </button>
                        </div>

                        {/* Business Details & Active Metrics (Side by Side Grid) */}
                        <div className="grid grid-cols-2 gap-4 pt-3 border-t border-gray-50">
                          <div className="space-y-2">
                            <div className="flex items-center gap-1.5 text-gray-400">
                              <ShieldCheck size={11} />
                              <p className="text-[8px] font-extrabold uppercase tracking-widest">Details</p>
                            </div>
                            <div className="space-y-1.5">
                              <div className="flex items-center gap-1.5">
                                <div className="w-6 h-6 shrink-0 bg-amber-50 rounded-lg flex items-center justify-center text-amber-600">
                                  <MapPin size={11} />
                                </div>
                                <div className="min-w-0">
                                  <p className="text-[7px] font-bold text-gray-400 uppercase leading-none mb-0.5">Location</p>
                                  <p className="text-[11px] font-bold text-gray-900 truncate">{biz.location || 'N/A'}</p>
                                </div>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <div className="w-6 h-6 shrink-0 bg-rose-50 rounded-lg flex items-center justify-center text-rose-600">
                                  <Smartphone size={11} />
                                </div>
                                <div className="min-w-0">
                                  <p className="text-[7px] font-bold text-gray-400 uppercase leading-none mb-0.5">Contact</p>
                                  <p className="text-[11px] font-bold text-gray-900 truncate">{biz.contactNumber || 'N/A'}</p>
                                </div>
                              </div>
                            </div>
                          </div>

                          <div className="space-y-2">
                            <div className="flex items-center gap-1.5 text-gray-400">
                              <BarChart3 size={11} />
                              <p className="text-[8px] font-extrabold uppercase tracking-widest">Metrics</p>
                            </div>
                            <div className="space-y-1.5">
                              <div className="bg-gray-50 p-1.5 rounded-xl border border-gray-100 flex items-center justify-between px-2">
                                <span className="text-[8px] font-bold text-gray-400 uppercase">Programs</span>
                                <span className="text-xs font-black text-gray-900">{activeProgramsCount}</span>
                              </div>
                              <div className="bg-gray-50 p-1.5 rounded-xl border border-gray-100 flex items-center justify-between px-2">
                                <span className="text-[8px] font-bold text-gray-400 uppercase">Passes</span>
                                <span className="text-xs font-black text-gray-900">{activePassesCount}</span>
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* Top Passes */}
                        <div className="space-y-2 pt-3 border-t border-gray-50">
                          <div className="flex items-center gap-1.5 text-gray-400">
                            <Trophy size={11} />
                            <p className="text-[8px] font-extrabold uppercase tracking-widest">Top Active Passes</p>
                          </div>
                          {topPasses.length === 0 ? (
                            <p className="text-xs text-gray-400 italic ml-1 select-none py-1">No active pass data yet.</p>
                          ) : (
                            <div className="space-y-1 ml-1">
                              {topPasses.map((card, idx) => (
                                <div key={card.id} className="flex items-center justify-between p-2 bg-gray-50/50 rounded-xl border border-gray-100/60">
                                  <div className="flex items-center gap-2">
                                    <div className={`w-4.5 h-4.5 rounded-full flex items-center justify-center text-[7px] font-black ${
                                      idx === 0 ? 'bg-amber-100 text-amber-600' : 
                                      idx === 1 ? 'bg-gray-200 text-gray-600' : 
                                      'bg-orange-100 text-orange-600'
                                    }`}>
                                      {idx + 1}
                                    </div>
                                    <span className="font-mono text-gray-500 text-[9px]">ID: {card.id.slice(0, 8)}...</span>
                                  </div>
                                  <span className="font-bold text-gray-900 text-[11px]">{card.currentStamps} Stamps</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                </motion.div>
              )}
            </motion.div>
          );
        case 'profile':
          return (
            <motion.div key="profile" initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} className="p-4 flex flex-col items-center text-center pb-24">
              <div className="w-20 h-20 rounded-full bg-coffee-cream mb-3 border-2 border-white shadow-md overflow-hidden flex items-center justify-center">
                {user.photoURL ? (
                  <img src={user.photoURL} alt="Profile" referrerPolicy="no-referrer" className="w-full h-full object-cover" />
                ) : (
                  <User className="text-coffee-dark/20" size={32} />
                )}
              </div>
              <h2 className="text-lg font-bold">{profile?.name}</h2>
              <p className="text-gray-500 text-xs mb-6">{profile?.email}</p>
              
              <div className="w-full space-y-2 mb-6 max-w-xs">
                <button 
                  onClick={() => setShowPrivacy(true)}
                  className="w-full py-3 bg-gray-100 text-gray-700 rounded-2xl font-bold flex items-center justify-center gap-2 active:scale-95 transition-transform text-sm"
                >
                  <ShieldCheck size={18} /> Privacy Policy
                </button>

                {/* App Version & In-App Update Checker */}
                <div className="w-full bg-white rounded-2xl p-3.5 border border-gray-100 flex items-center justify-between shadow-sm text-left">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-xl bg-coffee-cream flex items-center justify-center text-coffee-dark shrink-0">
                      <Sparkles size={16} />
                    </div>
                    <div>
                      <p className="text-xs font-bold text-gray-900">App Version</p>
                      <p className="text-[10px] text-gray-400 font-mono">v{installedAppVersion}</p>
                    </div>
                  </div>
                  <button 
                    onClick={() => checkForAppUpdates(true)} 
                    disabled={isCheckingUpdate}
                    className="px-3 py-1.5 bg-coffee-dark text-white rounded-xl text-xs font-bold active:scale-95 transition-transform flex items-center gap-1.5 disabled:opacity-50"
                  >
                    <RefreshCw size={12} className={isCheckingUpdate ? "animate-spin" : ""} />
                    {isCheckingUpdate ? "Checking..." : "Check for Updates"}
                  </button>
                </div>

                <button 
                  onClick={() => setShowSignOutConfirm(true)}
                  className="w-full py-3 bg-gray-100 text-gray-700 rounded-2xl font-bold flex items-center justify-center gap-2 active:scale-95 transition-transform text-sm"
                >
                  <LogOut size={18} /> Sign Out
                </button>
              </div>
              
              <button 
                onClick={() => {
                  setDeleteConfirmText('');
                  setIsDeletingAccountFlow(true);
                  setShowDeleteConfirm(true);
                }} 
                className="text-xs text-[#ef4444] hover:text-[#dc2626] font-bold underline underline-offset-4 mt-6 active:opacity-75 transition-all focus:outline-none"
              >
                Delete Account
              </button>
            </motion.div>
          );
        default:
          setActiveTab('admin_home');
          return null;
      }
    }

    // --- PARTNER VIEW ---
    if (activeTab === 'partner') {
      const myBiz = businesses.find(b => b.ownerId === user.uid);
      const myProgs = programs.filter(p => p.businessId === myBiz?.id);
      
      // Data Integrity Auto-Fix: If we find cards for this business that are missing businessOwnerId,
      // we fix them so they show up in the queries for this owner.
      // (This only applies if the owner happens to see them via a different query or if they are in allCards)
      
      const bizCards = allCards.filter(c => {
        if (!myBiz || c.businessId !== myBiz.id) return false;
        return true; // Keep all cards for stats
      });
      
      const activeProgramsCount = myProgs.filter(p => p.isActive).length;
      const activePassesCount = bizCards.filter(c => !c.isCompleted).length;
      
      console.log(`Partner Dashboard: Found ${bizCards.length} total cards, ${activeProgramsCount} active programs, ${activePassesCount} active passes.`);

      const isProfileIncomplete = !myBiz || myBiz.name === 'RetivoX' || !myBiz.location || !myBiz.contactNumber;

      return (
        <motion.div key="partner" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 space-y-6 pb-24">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-2xl font-bold leading-tight">
                {myBiz?.name || 'Business Manager'}
                {myBiz?.displayId ? (
                  <span className="ml-2 text-gray-400 font-medium text-lg">{myBiz.displayId}</span>
                ) : (
                  <span className="ml-2 text-amber-500 text-xs font-bold bg-amber-50 px-2 py-1 rounded-lg animate-pulse">
                    ID Pending
                  </span>
                )}
              </h1>
              {myBiz && (
                <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-1">
                  {myBiz.location && (
                    <div className="flex items-center gap-1 text-xs text-gray-500">
                      <MapPin size={10} className="text-gray-400" />
                      <span>{myBiz.location}</span>
                    </div>
                  )}
                  {myBiz.contactNumber && (
                    <div className="flex items-center gap-1 text-xs text-gray-500">
                      <Smartphone size={10} className="text-gray-400" />
                      <span>{myBiz.contactNumber}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              {myBiz && (
                <button 
                  onClick={() => {
                    const hasId = !!myBiz.displayId;
                    const generatedId = hasId ? myBiz.displayId : `#${Math.floor(1000 + Math.random() * 9000)}`;
                    
                    setEditBiz({
                      name: myBiz.name || '',
                      location: myBiz.location || '',
                      contactNumber: myBiz.contactNumber || '',
                      logoUrl: myBiz.logoUrl || '',
                      displayId: generatedId || ''
                    });
                    setShowBusinessSettings(true);
                  }}
                  className="p-2 bg-gray-100 text-gray-600 rounded-xl hover:bg-gray-200 transition-colors"
                  title="Business Settings"
                >
                  <Settings size={20} />
                </button>
              )}
              <button 
                onClick={() => checkForAppUpdates(true)}
                disabled={isCheckingUpdate}
                className="p-2 bg-coffee-cream text-coffee-dark rounded-xl hover:bg-opacity-80 transition-colors disabled:opacity-50"
                title={`App Version v${installedAppVersion} - Check for Updates`}
              >
                <RefreshCw size={20} className={isCheckingUpdate ? "animate-spin" : ""} />
              </button>
              <button 
                onClick={() => setShowSignOutConfirm(true)}
                className="p-2 bg-red-50 text-red-600 rounded-xl hover:bg-red-100 transition-colors"
                title="Sign Out"
              >
                <Power size={20} />
              </button>
            </div>
          </div>

          {!myBiz ? (
            <div className="bg-white p-8 rounded-[2.5rem] border-2 border-dashed border-gray-200 text-center space-y-4">
              <Coffee className="mx-auto text-gray-300" size={48} />
              <h3 className="font-bold">Register your Cafe</h3>
              <p className="text-sm text-gray-500">Start rewarding your loyal customers today.</p>
              <button 
                onClick={() => createBusiness('RetivoX', 'cafe')}
                className="w-full py-3 bg-coffee-dark text-white rounded-2xl font-bold"
              >
                Launch Cafe Dashboard
              </button>
            </div>
          ) : (
            <>
              <div className="bg-coffee-dark p-6 rounded-[2.5rem] text-white shadow-xl shadow-coffee-light/20 flex items-start gap-4">
                <div className="w-16 h-16 bg-white/20 rounded-2xl flex items-center justify-center overflow-hidden shrink-0">
                  {myBiz.logoUrl ? (
                    <img src={myBiz.logoUrl} alt="Logo" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                  ) : (
                    <Store className="text-white/40" size={32} />
                  )}
                </div>
                <div className="flex-1">
                  <h2 className="text-2xl font-bold mb-3">
                    {myBiz.name}
                    {myBiz.displayId && <span className="ml-2 text-white/50 font-medium text-lg">{myBiz.displayId}</span>}
                  </h2>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-white/10 p-2 rounded-xl text-center">
                        <p className="text-lg font-bold">{activeProgramsCount}</p>
                        <p className="text-[8px] uppercase font-bold opacity-60">Active Programs</p>
                      </div>
                      <div className="bg-white/10 p-2 rounded-xl text-center">
                        <p className="text-lg font-bold">{activePassesCount}</p>
                        <p className="text-[8px] uppercase font-bold opacity-60 tracking-wider">Active Digital Passes</p>
                      </div>
                    </div>
                </div>
              </div>

              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="font-bold text-lg">My Programs</h2>
                  {!isProfileIncomplete && (
                    <div className="flex gap-2">
                      <button 
                        onClick={() => setIsScanning(true)}
                        className="p-2 bg-emerald-50 text-emerald-600 rounded-xl flex items-center gap-2 font-bold text-xs"
                      >
                        <Scan size={18} /> Scan
                      </button>
                      <button 
                        onClick={() => setShowAddProgram(true)}
                        className="p-2 bg-coffee-cream text-coffee-dark rounded-xl flex items-center gap-2 font-bold text-xs"
                      >
                        <Plus size={18} /> Add Program
                      </button>
                    </div>
                  )}
                </div>

                {isProfileIncomplete && (
                  <div className="bg-amber-50 border border-amber-100 p-6 rounded-[2rem] text-center space-y-4">
                    <div className="w-12 h-12 bg-amber-100 rounded-full flex items-center justify-center mx-auto text-amber-600">
                      <AlertCircle size={24} />
                    </div>
                    <div className="space-y-1">
                      <h3 className="font-bold text-amber-900">Complete Your Profile</h3>
                      <p className="text-xs text-amber-700">Please provide your cafe's real name, location, and contact number to unlock loyalty programs and scanning.</p>
                    </div>
                    <button 
                      onClick={() => {
                        const hasId = !!myBiz.displayId;
                        const generatedId = hasId ? myBiz.displayId : `#${Math.floor(1000 + Math.random() * 9000)}`;
                        setEditBiz({
                          name: myBiz.name === 'RetivoX' ? '' : myBiz.name,
                          location: myBiz.location || '',
                          contactNumber: myBiz.contactNumber || '',
                          logoUrl: myBiz.logoUrl || '',
                          displayId: generatedId || ''
                        });
                        setShowBusinessSettings(true);
                      }}
                      className="w-full py-3 bg-amber-600 text-white rounded-2xl font-bold text-sm shadow-lg shadow-amber-100"
                    >
                      Update Business Details
                    </button>
                  </div>
                )}

                {!isProfileIncomplete && [...myProgs]
                  .filter(p => p.isActive)
                  .map(prog => (
                  <div key={prog.id} className="bg-white p-4 rounded-3xl border border-gray-100 flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-bold">{prog.title}</h3>
                        {!prog.isActive && <span className="text-[8px] font-black bg-red-100 text-red-600 px-1.5 py-0.5 rounded-full uppercase">Deleted</span>}
                      </div>
                      <p className="text-xs text-gray-500">Buy {prog.goal}, get {prog.reward}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <button 
                        onClick={() => setEditingProgram(prog)}
                        className="p-2 bg-gray-50 text-gray-600 rounded-xl hover:bg-gray-100 transition-colors"
                        title="Edit Program"
                      >
                        <Edit2 size={18} />
                      </button>
                      <button 
                        onClick={() => setShowJoinQR(prog.id)}
                        className="p-2 bg-coffee-cream text-coffee-dark rounded-xl hover:bg-coffee-cream/80 transition-colors"
                        title="Show Join QR"
                      >
                        <QrCode size={18} />
                      </button>
                      <div className="w-px h-4 bg-gray-100 mx-1" />
                      <button 
                        onClick={() => setProgramToDelete(prog.id)}
                        className="p-2 bg-red-50 text-red-600 rounded-xl hover:bg-red-100 transition-colors"
                        title="Delete Program"
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>


              {/* Add Program Modal */}
              <AnimatePresence>
                {showAddProgram && (
                  <motion.div 
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
                  >
                    <motion.div 
                      initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.9, y: 20 }}
                      className="bg-white w-full max-w-sm rounded-[2.5rem] p-8 space-y-6 relative"
                    >
                      <button onClick={() => setShowAddProgram(false)} className="absolute top-4 right-4 p-2 text-gray-400 hover:text-gray-600"><X size={24} /></button>
                      <h3 className="text-xl font-bold text-center">New Loyalty Program</h3>
                      
                      <div className="space-y-4">
                        <div>
                          <label className="text-[10px] font-bold uppercase text-gray-400 ml-2">Program Name (e.g. Coffee Club)</label>
                          <input 
                            type="text" 
                            value={newProg.title} 
                            onChange={(e) => setNewProg({...newProg, title: e.target.value})}
                            placeholder="Enter program name" 
                            className="w-full bg-gray-50 border-none rounded-2xl py-3 px-4 focus:ring-2 focus:ring-coffee-dark"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold uppercase text-gray-400 ml-2">Item Name (e.g. Coffee, Snack)</label>
                          <input 
                            type="text" 
                            value={newProg.itemName} 
                            onChange={(e) => {
                              const itemName = e.target.value;
                              const goalNum = parseInt(newProg.goal) || 0;
                              const reward = itemName && goalNum ? `${goalNum + 1}${getOrdinal(goalNum + 1)} ${itemName} Free` : '';
                              setNewProg({...newProg, itemName, reward});
                            }}
                            placeholder="Enter item name" 
                            className="w-full bg-gray-50 border-none rounded-2xl py-3 px-4 focus:ring-2 focus:ring-coffee-dark"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <label className="text-[10px] font-bold uppercase text-gray-400 ml-2">Buy X Items</label>
                            <input 
                              type="number" 
                              value={newProg.goal} 
                              onChange={(e) => {
                                const goal = e.target.value;
                                const goalNum = parseInt(goal) || 0;
                                const reward = newProg.itemName && goalNum ? `${goalNum + 1}${getOrdinal(goalNum + 1)} ${newProg.itemName} Free` : '';
                                setNewProg({...newProg, goal, reward});
                              }}
                              placeholder="e.g. 5"
                              className="w-full bg-gray-50 border-none rounded-2xl py-3 px-4 focus:ring-2 focus:ring-coffee-dark"
                            />
                          </div>
                          <div>
                            <label className="text-[10px] font-bold uppercase text-gray-400 ml-2">Reward (Auto-generated)</label>
                            <input 
                              type="text" 
                              value={newProg.reward} 
                              readOnly
                              placeholder="e.g. 6th Coffee Free" 
                              className="w-full bg-gray-100 border-none rounded-2xl py-3 px-4 text-gray-500 cursor-not-allowed"
                            />
                          </div>
                        </div>
                      </div>

                      <button 
                        onClick={() => {
                          createProgram(myBiz.id, newProg.title, newProg.itemName, parseInt(newProg.goal as string) || 0, newProg.reward);
                          setNewProg({ title: '', itemName: '', goal: '', reward: '' });
                          setShowAddProgram(false);
                        }}
                        disabled={!newProg.title || !newProg.itemName || !newProg.goal}
                        className="w-full py-4 bg-coffee-dark text-white rounded-2xl font-bold shadow-lg disabled:opacity-50 active:scale-95 transition-all"
                      >
                        Create Program
                      </button>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Delete Confirmation Modal */}
              <AnimatePresence>
                {programToDelete && (
                  <motion.div 
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[110] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
                  >
                    <motion.div 
                      initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.9, y: 20 }}
                      className="bg-white w-full max-w-xs rounded-[2.5rem] p-8 text-center space-y-6"
                    >
                      <div className="w-16 h-16 bg-amber-50 text-amber-500 rounded-full flex items-center justify-center mx-auto">
                        <AlertTriangle size={32} />
                      </div>
                      <div>
                        <h3 className="text-xl font-black text-gray-900">Delete Program?</h3>
                        <p className="text-sm text-gray-500 mt-2 leading-relaxed">
                          New customers won't be able to join, but existing cards will stay active.
                        </p>
                      </div>
                      <div className="flex flex-col gap-3">
                        <button 
                          onClick={() => deleteProgram(programToDelete)}
                          className="w-full py-4 bg-red-600 text-white rounded-2xl font-bold shadow-lg active:scale-95 transition-all"
                        >
                          Yes, Delete
                        </button>
                        <button 
                          onClick={() => setProgramToDelete(null)}
                          className="w-full py-4 bg-gray-100 text-gray-600 rounded-2xl font-bold active:scale-95 transition-all"
                        >
                          No, Keep it
                        </button>
                      </div>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Edit Program Modal */}
              <AnimatePresence>
                {editingProgram && (
                  <motion.div 
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
                  >
                    <motion.div 
                      initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.9, y: 20 }}
                      className="bg-white w-full max-w-sm rounded-[2.5rem] p-8 space-y-6 relative"
                    >
                      <button onClick={() => setEditingProgram(null)} className="absolute top-4 right-4 p-2 text-gray-400 hover:text-gray-600"><X size={24} /></button>
                      <h3 className="text-xl font-bold text-center">Edit Program</h3>
                      
                      <div className="space-y-4">
                        <div>
                          <label className="text-[10px] font-bold uppercase text-gray-400 ml-2">Program Name</label>
                          <input 
                            type="text" 
                            value={editingProgram.title} 
                            onChange={(e) => setEditingProgram({...editingProgram, title: e.target.value})}
                            className="w-full bg-gray-50 border-none rounded-2xl py-3 px-4 focus:ring-2 focus:ring-coffee-dark"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold uppercase text-gray-400 ml-2">Item Name</label>
                          <input 
                            type="text" 
                            value={editingProgram.itemName} 
                            onChange={(e) => {
                              const itemName = e.target.value;
                              const goalNum = editingProgram.goal;
                              const reward = itemName && goalNum ? `${goalNum + 1}${getOrdinal(goalNum + 1)} ${itemName} Free` : editingProgram.reward;
                              setEditingProgram({...editingProgram, itemName, reward});
                            }}
                            className="w-full bg-gray-50 border-none rounded-2xl py-3 px-4 focus:ring-2 focus:ring-coffee-dark"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <label className="text-[10px] font-bold uppercase text-gray-400 ml-2">Buy X Items</label>
                            <input 
                              type="number" 
                              value={editingProgram.goal} 
                              onChange={(e) => {
                                const goal = parseInt(e.target.value) || 0;
                                const reward = editingProgram.itemName && goal ? `${goal + 1}${getOrdinal(goal + 1)} ${editingProgram.itemName} Free` : editingProgram.reward;
                                setEditingProgram({...editingProgram, goal, reward});
                              }}
                              className="w-full bg-gray-50 border-none rounded-2xl py-3 px-4 focus:ring-2 focus:ring-coffee-dark"
                            />
                          </div>
                          <div>
                            <label className="text-[10px] font-bold uppercase text-gray-400 ml-2">Reward</label>
                            <input 
                              type="text" 
                              value={editingProgram.reward} 
                              readOnly
                              className="w-full bg-gray-100 border-none rounded-2xl py-3 px-4 text-gray-500 cursor-not-allowed"
                            />
                          </div>
                        </div>
                      </div>

                      <button 
                        onClick={() => {
                          updateProgram(editingProgram.id, {
                            title: editingProgram.title,
                            itemName: editingProgram.itemName,
                            goal: editingProgram.goal,
                            reward: editingProgram.reward
                          });
                          setEditingProgram(null);
                        }}
                        className="w-full py-4 bg-coffee-dark text-white rounded-2xl font-bold shadow-lg active:scale-95 transition-all"
                      >
                        Save Changes
                      </button>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Business Personalization Modal */}
              <AnimatePresence>
                {showBusinessSettings && (
                  <motion.div 
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[120] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
                  >
                    <motion.div 
                      initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.9, y: 20 }}
                      className="bg-white w-full max-w-sm rounded-[2.5rem] p-8 space-y-6 relative overflow-y-auto max-h-[90vh]"
                    >
                      <button onClick={() => {
                        setShowBusinessSettings(false);
                        setConfirmDelete(false);
                      }} className="absolute top-4 right-4 p-2 text-gray-400 hover:text-gray-600"><X size={24} /></button>
                      <div className="text-center">
                        <h3 className="text-xl font-bold">Café Personalization</h3>
                        <p className="text-xs text-gray-500 mt-1">
                          Update your café's public information.
                        </p>
                      </div>
                      
                      <div className="space-y-4">
                        <div>
                          <label className="text-[10px] font-bold uppercase text-gray-400 ml-2">Café Logo</label>
                          <div className="mt-2 flex items-center gap-4">
                            <div className="w-16 h-16 rounded-full bg-gray-50 border-2 border-dashed border-gray-200 flex items-center justify-center overflow-hidden relative group">
                              {editBiz.logoUrl ? (
                                <>
                                  <img src={editBiz.logoUrl} alt="Preview" className="w-full h-full object-cover" />
                                  <button 
                                    onClick={() => setEditBiz({ ...editBiz, logoUrl: '' })}
                                    className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white"
                                  >
                                    <Trash2 size={16} />
                                  </button>
                                </>
                              ) : (
                                <Coffee className="text-gray-300" size={24} />
                              )}
                            </div>
                            <label className="flex-1">
                              <div className="px-4 py-2 border border-gray-100 rounded-xl text-xs font-bold text-coffee-dark bg-gray-50 hover:bg-gray-100 cursor-pointer text-center transition-colors">
                                {editBiz.logoUrl ? 'Change Logo' : 'Upload Logo'}
                              </div>
                              <input type="file" accept="image/*" className="hidden" onChange={handleLogoUpload} />
                            </label>
                          </div>
                        </div>

                        <div>
                          <label className="text-[10px] font-bold uppercase text-gray-400 ml-2">
                            Café Name
                          </label>
                          <input 
                            type="text" 
                            value={editBiz.name} 
                            onChange={(e) => setEditBiz({...editBiz, name: e.target.value})}
                            placeholder="Enter café name" 
                            className="w-full bg-gray-50 border-none rounded-2xl py-3 px-4 focus:ring-2 focus:ring-coffee-dark"
                          />
                        </div>

                        <div>
                          <label className="text-[10px] font-bold uppercase text-gray-400 ml-2">
                            Place / Location
                          </label>
                          <input 
                            type="text" 
                            value={editBiz.location} 
                            onChange={(e) => setEditBiz({...editBiz, location: e.target.value})}
                            placeholder="e.g. 123 Coffee St, London" 
                            className="w-full bg-gray-50 border-none rounded-2xl py-3 px-4 focus:ring-2 focus:ring-coffee-dark"
                          />
                        </div>

                        <div>
                          <label className="text-[10px] font-bold uppercase text-gray-400 ml-2">Contact Number</label>
                          <input 
                            type="text" 
                            value={editBiz.contactNumber} 
                            onChange={(e) => setEditBiz({...editBiz, contactNumber: e.target.value})}
                            placeholder="+1 234 567 890" 
                            className="w-full bg-gray-50 border-none rounded-2xl py-3 px-4 focus:ring-2 focus:ring-coffee-dark"
                          />
                        </div>
                      </div>

                      <div className="space-y-3 pt-2">
                        <button 
                          onClick={() => {
                            if (!editBiz.name.trim()) {
                              setAppError("Café Name is required.");
                              return;
                            }
                            updateBusiness({
                              name: editBiz.name,
                              location: editBiz.location,
                              contactNumber: editBiz.contactNumber,
                              logoUrl: editBiz.logoUrl
                            });
                          }}
                          className="w-full py-4 bg-coffee-dark text-white rounded-2xl font-bold shadow-lg active:scale-95 transition-all"
                        >
                          Save Changes
                        </button>

                        {confirmDelete ? (
                          <div className="flex gap-2">
                            <button 
                              onClick={() => {
                                updateBusiness({
                                  name: "RetivoX",
                                  location: "",
                                  contactNumber: ""
                                });
                                setEditBiz({
                                  ...editBiz,
                                  name: "RetivoX",
                                  location: "",
                                  contactNumber: ""
                                });
                                setConfirmDelete(false);
                              }}
                              className="flex-1 py-4 bg-red-600 text-white rounded-2xl font-bold shadow-lg active:scale-95 transition-all"
                            >
                              Confirm Reset
                            </button>
                            <button 
                              onClick={() => setConfirmDelete(false)}
                              className="px-6 py-4 bg-gray-100 text-gray-600 rounded-2xl font-bold active:scale-95 transition-all"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button 
                            onClick={() => setConfirmDelete(true)}
                            className="w-full py-4 bg-red-50 text-red-600 rounded-2xl font-bold hover:bg-red-100 active:scale-95 transition-all flex items-center justify-center gap-2"
                          >
                            <Trash2 size={18} /> Delete Personalization
                          </button>
                        )}

                        {/* App Version & In-App Update Checker for Partner */}
                        <div className="pt-2 border-t border-gray-100">
                          <div className="bg-gray-50 rounded-2xl p-3.5 border border-gray-100 flex items-center justify-between shadow-sm text-left">
                            <div className="flex items-center gap-2.5">
                              <div className="w-8 h-8 rounded-xl bg-coffee-cream flex items-center justify-center text-coffee-dark shrink-0">
                                <Sparkles size={16} />
                              </div>
                              <div>
                                <p className="text-xs font-bold text-gray-900">App Version</p>
                                <p className="text-[10px] text-gray-400 font-mono">v{installedAppVersion}</p>
                              </div>
                            </div>
                            <button 
                              onClick={() => checkForAppUpdates(true)} 
                              disabled={isCheckingUpdate}
                              className="px-3 py-1.5 bg-coffee-dark text-white rounded-xl text-xs font-bold active:scale-95 transition-transform flex items-center gap-1.5 disabled:opacity-50"
                            >
                              <RefreshCw size={12} className={isCheckingUpdate ? "animate-spin" : ""} />
                              {isCheckingUpdate ? "Checking..." : "Check for Updates"}
                            </button>
                          </div>
                        </div>
                      </div>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Join QR Modal */}
              <AnimatePresence>
                {showJoinQR && (
                  <motion.div 
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
                  >
                    <motion.div 
                      initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.9, y: 20 }}
                      className="bg-white w-full max-w-xs rounded-[2.5rem] p-8 text-center space-y-6 relative"
                    >
                      <button onClick={() => setShowJoinQR(null)} className="absolute top-4 right-4 p-2 text-gray-400 hover:text-gray-600"><X size={24} /></button>
                      <div className="space-y-2">
                        <h3 className="text-xl font-bold">Join Program</h3>
                        <p className="text-sm text-gray-500">Customers scan this to join</p>
                      </div>
                      <div className="bg-gray-50 p-6 rounded-3xl flex items-center justify-center">
                        <QRCodeSVG value={`${window.location.origin}/?join=${showJoinQR}`} size={180} />
                      </div>
                      <p className="text-[10px] text-gray-400 font-mono uppercase tracking-widest">Program ID: {showJoinQR}</p>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>

              <AnimatePresence>
                {stampSuccess && (
                  <motion.div 
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[200] bg-emerald-500 flex flex-col items-center justify-center p-8 text-white text-center"
                  >
                    <motion.div
                      initial={{ scale: 0.5, y: 20 }}
                      animate={{ scale: 1, y: 0 }}
                      className="w-24 h-24 bg-white rounded-full flex items-center justify-center text-emerald-500 mb-8 shadow-2xl"
                    >
                      <CheckCircle2 size={48} />
                    </motion.div>
                    <h2 className="text-3xl font-bold mb-2">Success!</h2>
                    <p className="text-emerald-50 text-xl font-medium">{stampSuccess}</p>
                    <p className="mt-8 text-emerald-100 text-sm opacity-60">Returning to dashboard...</p>
                  </motion.div>
                )}
              </AnimatePresence>

              <AnimatePresence>
                {stampError && (
                  <motion.div 
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[200] bg-red-500 flex flex-col items-center justify-center p-8 text-white text-center"
                  >
                    <motion.div
                      initial={{ scale: 0.5, y: 20 }}
                      animate={{ scale: 1, y: 0 }}
                      className="w-24 h-24 bg-white rounded-full flex items-center justify-center text-red-500 mb-8 shadow-2xl"
                    >
                      <AlertCircle size={48} />
                    </motion.div>
                    <h2 className="text-3xl font-bold mb-2">Scan Failed</h2>
                    <p className="text-red-50 text-xl font-medium">{stampError}</p>
                    <p className="mt-8 text-red-100 text-sm opacity-60">Returning to dashboard...</p>
                  </motion.div>
                )}
              </AnimatePresence>

              <AnimatePresence>
                {saveSuccess && (
                  <motion.div 
                    initial={{ opacity: 0, y: 50 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 50 }}
                    className="fixed bottom-24 left-4 right-4 z-[150] bg-coffee-dark text-white p-4 rounded-2xl shadow-xl flex items-center gap-3"
                  >
                    <div className="w-10 h-10 bg-white/20 rounded-full flex items-center justify-center">
                      <ShieldCheck size={24} />
                    </div>
                    <div>
                      <p className="font-bold">Settings Saved</p>
                      <p className="text-xs opacity-80">{saveSuccess}</p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Join Success Modal */}
              <AnimatePresence>
                {justJoined && (
                  <motion.div 
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[200] bg-coffee-dark flex flex-col items-center justify-center p-8 text-white text-center"
                  >
                    <motion.div
                      initial={{ scale: 0.5, rotate: -20 }}
                      animate={{ scale: 1, rotate: 0 }}
                      className="w-24 h-24 bg-white rounded-3xl flex items-center justify-center text-coffee-dark mb-8 shadow-2xl"
                    >
                      <ShieldCheck size={48} />
                    </motion.div>
                    <h2 className="text-3xl font-bold mb-2">Joined Successfully!</h2>
                    <p className="text-coffee-cream mb-8">Adding your unique loyalty pass to your digital wallet...</p>
                    
                    <div className="w-full max-w-xs bg-white/10 border border-white/20 rounded-3xl p-6 backdrop-blur-md text-left">
                      <div className="flex items-center gap-3 mb-6">
                        <div className="w-12 h-12 bg-white rounded-2xl flex items-center justify-center text-coffee-dark font-bold overflow-hidden">
                          {(() => {
                            const biz = businesses.find(b => b.id === myCards.find(c => c.id === justJoined)?.businessId);
                            return biz?.logoUrl ? (
                              <img src={biz.logoUrl} alt="Logo" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                            ) : (
                              biz?.name[0] || 'L'
                            );
                          })()}
                        </div>
                        <div>
                          <p className="text-[10px] font-bold opacity-60 uppercase tracking-widest">Loyalty Pass</p>
                          <p className="font-bold text-lg leading-tight">
                            {businesses.find(b => b.id === myCards.find(c => c.id === justJoined)?.businessId)?.name || 'Loading...'}
                            {(() => {
                              const biz = businesses.find(b => b.id === myCards.find(c => c.id === justJoined)?.businessId);
                              return biz?.displayId && <span className="ml-2 opacity-60 font-medium text-sm">{biz.displayId}</span>;
                            })()}
                          </p>
                          {(() => {
                            const biz = businesses.find(b => b.id === myCards.find(c => c.id === justJoined)?.businessId);
                            return (
                              <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-1">
                                {biz?.location && (
                                  <div className="flex items-center gap-1 text-[10px] text-white/70">
                                    <MapPin size={10} />
                                    <span>{biz.location}</span>
                                  </div>
                                )}
                                {biz?.contactNumber && (
                                  <div className="flex items-center gap-1 text-[10px] text-white/70">
                                    <Smartphone size={10} />
                                    <span>{biz.contactNumber}</span>
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                        </div>
                      </div>

                      <div className="h-1 bg-white/20 rounded-full overflow-hidden mb-4">
                        <motion.div 
                          initial={{ width: 0 }} animate={{ width: '100%' }}
                          transition={{ duration: 2 }}
                          className="h-full bg-white"
                        />
                      </div>
                    </div>
                    <button 
                      onClick={() => setJustJoined(null)}
                      className="w-full max-w-xs mt-8 py-4 bg-white text-coffee-dark rounded-2xl font-bold shadow-lg active:scale-95 transition-all"
                    >
                      View in Wallet
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Full Digital Pass Modal */}
              <AnimatePresence>
                {selectedCard && (
                  <motion.div 
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[200] bg-black/80 backdrop-blur-md flex items-center justify-center p-6"
                  >
                    <motion.div 
                      initial={{ scale: 0.9, y: 50 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.9, y: 50 }}
                      className="w-full max-w-sm bg-coffee-dark rounded-[2.5rem] overflow-hidden shadow-2xl relative"
                    >
                      <div className="absolute top-6 right-6 flex gap-2">
                        <button 
                          onClick={() => {
                            const biz = businesses.find(b => b.id === selectedCard.businessId);
                            setShowReportModal({ id: selectedCard.businessId, type: 'business', name: biz?.name || 'This Business' });
                          }}
                          className="p-2 bg-white/10 text-white/60 rounded-full hover:bg-white/20 hover:text-white transition-all"
                          title="Report offensive content"
                        >
                          <Flag size={18} />
                        </button>
                        <button 
                          onClick={() => setSelectedCard(null)} 
                          className="p-2 bg-white/10 text-white rounded-full hover:bg-white/20 transition-colors"
                        >
                          <X size={20} />
                        </button>
                      </div>

                      {/* Pass Header */}
                      <div className="p-8 pb-6 text-white">
                        <div className="flex items-center gap-4 mb-8">
                          <div className="w-16 h-16 bg-white rounded-2xl flex items-center justify-center text-coffee-dark font-bold text-2xl overflow-hidden shadow-lg">
                            {(() => {
                              const biz = businesses.find(b => b.id === selectedCard.businessId);
                              return biz?.logoUrl ? (
                                <img src={biz.logoUrl} alt="Logo" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                              ) : (
                                biz?.name[0] || 'L'
                              );
                            })()}
                          </div>
                          <div>
                            <p className="text-[10px] font-bold opacity-60 uppercase tracking-widest">Loyalty Pass</p>
                            <h3 className="text-2xl font-bold leading-tight">
                              {businesses.find(b => b.id === selectedCard.businessId)?.name}
                              {(() => {
                                const biz = businesses.find(b => b.id === selectedCard.businessId);
                                return biz?.displayId && <span className="ml-2 text-white/50 font-medium text-lg">{biz.displayId}</span>;
                              })()}
                            </h3>
                            {(() => {
                              const biz = businesses.find(b => b.id === selectedCard.businessId);
                              return (
                                <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-1">
                                  {biz?.location && (
                                    <div className="flex items-center gap-1 text-[10px] text-white/70">
                                      <MapPin size={10} />
                                      <span>{biz.location}</span>
                                    </div>
                                  )}
                                  {biz?.contactNumber && (
                                    <div className="flex items-center gap-1 text-[10px] text-white/70">
                                      <Smartphone size={10} />
                                      <span>{biz.contactNumber}</span>
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                          </div>
                        </div>

                        <div className="space-y-4">
                          {(() => {
                            const prog = programs.find(p => p.id === selectedCard.programId);
                            return (
                              <div>
                                <p className="text-[10px] font-bold opacity-60 uppercase tracking-widest mb-1">Program</p>
                                <p className="font-medium">{prog?.title}</p>
                              </div>
                            );
                          })()}
                        </div>
                      </div>

                      {/* Pass Body (QR Code Area) */}
                      <div className="bg-white p-8 pt-10 rounded-t-[3rem] text-center space-y-6">
                        <div className="bg-gray-50 p-6 rounded-3xl flex flex-col items-center justify-center border-2 border-dashed border-gray-100 relative overflow-hidden">
                          <QRCodeSVG value={generateSecureToken(selectedCard.id, selectedCard.currentStamps)} size={180} />
                          <p className="mt-4 text-[10px] text-gray-400 font-mono uppercase tracking-widest">Pass ID: {selectedCard.id.slice(0,12)}</p>
                        </div>
                        
                        <div className="space-y-4">
                          <div className="space-y-2">
                            {(() => {
                              const prog = programs.find(p => p.id === selectedCard.programId);
                              if (!prog) return null;
                              return (
                                <>
                                  <div className="flex justify-between items-end mb-1">
                                    <p className="text-xs font-bold text-gray-400 uppercase">Progress</p>
                                    <p className="text-xl font-black text-coffee-dark">{selectedCard.currentStamps}<span className="text-sm text-gray-300 font-normal">/{prog.goal}</span></p>
                                  </div>
                                  <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
                                    <motion.div 
                                      initial={{ width: 0 }}
                                      animate={{ width: `${(selectedCard.currentStamps / prog.goal) * 100}%` }}
                                      className="h-full bg-coffee-dark"
                                    />
                                  </div>
                                  <p className="text-[10px] text-gray-400 font-medium">
                                    {prog.goal - selectedCard.currentStamps} more stamps until your reward!
                                  </p>
                                </>
                              );
                            })()}
                          </div>

                          <div className="grid grid-cols-2 gap-3">
                            <button 
                              onClick={async () => {
                                const biz = businesses.find(b => b.id === selectedCard.businessId);
                                const prog = programs.find(p => p.id === selectedCard.programId);
                                try {
                                  const response = await fetchWithAuth(getApiUrl('/api/wallet/generate-pass'), {
                                    method: 'POST',
                                    body: JSON.stringify({
                                      cardId: selectedCard.id,
                                      businessName: biz?.name,
                                      programTitle: prog?.title,
                                      currentStamps: selectedCard.currentStamps,
                                      goal: prog?.goal,
                                      reward: prog?.reward,
                                      type: 'google',
                                      businessId: selectedCard.businessId,
                                      programId: selectedCard.programId
                                    })
                                  });
                                  const data = await response.json();
                                  
                                  if (!response.ok) {
                                    setAppError(data.error || "Failed to generate wallet pass.");
                                    setTimeout(() => setAppError(null), 5000);
                                    return;
                                  }

                                  if (data.message) {
                                    setSaveSuccess(data.message);
                                    setTimeout(() => setSaveSuccess(null), 5000);
                                  } else if (data.saveUrl) {
                                    if (Capacitor.isNativePlatform()) {
                                      await Browser.open({ url: data.saveUrl }).catch(e => {
                                        console.error("Browser plugin error:", e);
                                        window.open(data.saveUrl, '_blank');
                                      });
                                    } else {
                                      window.open(data.saveUrl, '_blank');
                                    }
                                  }
                                } catch (err) {
                                  console.error(err);
                                  setAppError("Failed to connect to wallet service. Please try again later.");
                                  setTimeout(() => setAppError(null), 5000);
                                }
                              }}
                              className="h-12 flex items-center justify-center bg-black rounded-2xl active:scale-95 transition-transform overflow-hidden px-4"
                            >
                              <img 
                                src="/add-to-google-wallet.svg" 
                                alt="Add to Google Wallet" 
                                className="h-6"
                              />
                            </button>

                            <button 
                              onClick={() => {
                                setSaveSuccess("Apple Wallet integration requires an Apple Developer account and certificates. In this demo, this button represents the 'Add to Apple Wallet' flow.");
                                setTimeout(() => setSaveSuccess(null), 5000);
                              }}
                              className="h-12 flex items-center justify-center bg-black rounded-2xl active:scale-95 transition-transform overflow-hidden px-4"
                            >
                              <div className="flex items-center gap-2">
                                <svg viewBox="0 0 384 512" className="h-5 w-5 fill-white"><path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z"/></svg>
                                <span className="text-white text-xs font-bold">Add to Apple Wallet</span>
                              </div>
                            </button>
                          </div>
                        </div>

                        <button 
                          onClick={() => setSelectedCard(null)}
                          className="w-full py-4 bg-gray-100 text-gray-600 rounded-2xl font-bold active:scale-95 transition-all"
                        >
                          Close Pass
                        </button>
                      </div>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>

              <AnimatePresence>
                {isScanning && (
                  <motion.div 
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[150] bg-black flex flex-col"
                  >
                    {/* Header */}
                    <div className="p-6 flex items-center justify-between border-b border-white/10 bg-black/50 backdrop-blur-md sticky top-0 z-20">
                      <div>
                        <h3 className="text-white font-bold text-lg">Scanner</h3>
                        <p className="text-white/40 text-[10px] uppercase tracking-widest font-bold">Partner Mode</p>
                      </div>
                      <button onClick={stopScanner} className="p-2 bg-white/10 text-white rounded-full hover:bg-white/20 transition-colors">
                        <X size={24} />
                      </button>
                    </div>

                    {/* Scrollable Content */}
                    <div className="flex-1 overflow-y-auto">
                      <div className="p-6 space-y-8">
                        {/* Scanner View */}
                        <div className="relative w-full max-w-sm mx-auto aspect-square overflow-hidden rounded-[2.5rem] bg-gray-900 border-2 border-emerald-500/30 shadow-2xl shadow-emerald-500/10">
                          <div id="reader" className="w-full h-full" />
                          {!isProcessing && (
                            <motion.div 
                              animate={{ top: ['0%', '100%', '0%'] }}
                              transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                              className="absolute left-0 right-0 h-0.5 bg-emerald-400 shadow-[0_0_15px_rgba(52,211,153,0.8)] z-10"
                            />
                          )}
                        </div>

                        {/* Status/Results */}
                        <div className="max-w-sm mx-auto space-y-4">
                          {isProcessing ? (
                            <div className="flex flex-col items-center gap-4 py-4">
                              <motion.div 
                                animate={{ rotate: 360 }}
                                transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
                                className="w-10 h-10 border-4 border-emerald-400 border-t-transparent rounded-full"
                              />
                              <p className="text-emerald-400 font-bold animate-pulse">Processing Scan...</p>
                            </div>
                          ) : scanError ? (
                            <div className="bg-red-500/20 border border-red-500/50 p-6 rounded-[2rem] space-y-4">
                              <div className="flex items-center gap-3 text-red-400">
                                <AlertCircle size={24} />
                                <h4 className="font-bold">Camera Blocked</h4>
                              </div>
                              <div className="text-red-200/80 text-sm leading-relaxed">
                                {scanError}
                              </div>
                              
                              <div className="space-y-3 pt-2">
                                <button 
                                  onClick={() => window.open(window.location.href, '_blank')}
                                  className="w-full py-3 bg-white text-black rounded-2xl font-bold text-sm flex items-center justify-center gap-2 active:scale-95 transition-all"
                                >
                                  <ExternalLink size={18} /> Open in New Tab
                                </button>
                                
                                <button 
                                  onClick={async () => {
                                    await stopScanner();
                                    setTimeout(() => setIsScanning(true), 100);
                                  }}
                                  className="w-full py-3 bg-red-500/20 text-red-200 border border-red-500/30 rounded-2xl font-bold text-sm active:scale-95 transition-all"
                                >
                                  Try Again
                                </button>
                              </div>

                              <div className="pt-4 border-t border-white/10">
                                <p className="text-[10px] text-white/40 font-bold uppercase tracking-widest mb-2">How to fix:</p>
                                <ul className="text-[10px] text-white/60 space-y-1 list-disc pl-4">
                                  <li>Click the "Camera" icon in your browser address bar</li>
                                  <li>Select "Always allow" for this site</li>
                                  <li>Refresh the page or try again</li>
                                </ul>
                              </div>
                            </div>
                          ) : scanResult ? (
                            <motion.div 
                              initial={{ scale: 0.9, opacity: 0 }} 
                              animate={{ scale: 1, opacity: 1 }} 
                              className={`${
                                scanResult.includes('Error') ? 'bg-red-500' : 
                                scanResult.includes('redeemed') ? 'bg-coffee-accent' : 
                                'bg-emerald-500'
                              } text-white py-4 px-6 rounded-3xl font-bold text-sm shadow-xl text-center`}
                            >
                              {scanResult}
                            </motion.div>
                          ) : (
                            <div className="text-center py-2">
                              <p className="text-white/60 text-sm font-medium">Point camera at the customer's QR code</p>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          )}
        </motion.div>
      );
    }

    // --- CUSTOMER VIEW ---
    switch (activeTab) {
      case 'explore':
        const myBusinessIds = businesses.filter(b => b.ownerId === user?.uid).map(b => b.id);
        // Show active programs OR inactive programs that have a closedAt timestamp (history)
        const myFilteredPrograms = programs.filter(p => {
          const isMyBiz = myBusinessIds.includes(p.businessId);
          if (!isMyBiz) return false;
          return p.isActive || !!p.closedAt;
        });

        const sortedExplorePrograms = [...myFilteredPrograms].sort((a, b) => {
          if (a.isActive && !b.isActive) return -1;
          if (!a.isActive && b.isActive) return 1;
          return 0;
        });

        return (
          <motion.div key="explore" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 space-y-6 pb-24">
            <h1 className="text-2xl font-bold">Explore</h1>
            {sortedExplorePrograms.length === 0 ? (
              <div className="text-center py-20 space-y-4">
                <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto text-gray-400">
                  <Search size={32} />
                </div>
                <p className="text-gray-500 text-sm">No active programs found. Create your first program in the Home tab!</p>
              </div>
            ) : (
              sortedExplorePrograms
                .map(prog => {
                  const biz = businesses.find(b => b.id === prog.businessId);
                  const joined = myCards.some(c => c.programId === prog.id && !c.isCompleted);
                  return (
                    <div 
                      key={prog.id} 
                      className={`bg-white p-5 rounded-[2rem] border shadow-sm space-y-4 transition-all ${prog.isActive ? 'border-gray-100' : 'border-gray-200 opacity-60 grayscale-[0.3]'}`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className={`w-12 h-12 rounded-xl flex items-center justify-center font-bold overflow-hidden border ${prog.isActive ? 'bg-gray-50 text-coffee-dark border-gray-100' : 'bg-gray-100 text-gray-400 border-gray-200'}`}>
                            {biz?.logoUrl ? (
                              <img src={biz.logoUrl} alt="Logo" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                            ) : (
                              biz?.name[0]
                            )}
                          </div>
                          <div>
                            <h3 className={`font-bold ${prog.isActive ? 'text-gray-900' : 'text-gray-500'}`}>{prog.title}</h3>
                            <div className="flex flex-col gap-0.5">
                              <div className="flex items-center gap-1 text-xs text-gray-500">
                                <span>{biz?.name}</span>
                                {biz?.displayId && <span className="text-gray-400 font-medium text-[10px] ml-1">{biz.displayId}</span>}
                                {biz?.location && (
                                  <>
                                    <span className="text-gray-300">•</span>
                                    <span className="flex items-center gap-0.5"><MapPin size={10} />{biz.location}</span>
                                  </>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          <span className={`px-2 py-1 text-[10px] font-bold rounded-lg uppercase ${prog.isActive ? 'bg-coffee-cream text-coffee-dark' : 'bg-gray-100 text-gray-400'}`}>{biz?.type}</span>
                          <span className={`text-[8px] font-black px-2 py-0.5 rounded-full uppercase tracking-tighter ${prog.isActive ? 'bg-emerald-100 text-emerald-600' : 'bg-gray-200 text-gray-500'}`}>
                            {prog.isActive ? 'Active' : 'Inactive'}
                          </span>
                        </div>
                      </div>
                      <p className={`text-sm ${prog.isActive ? 'text-gray-600' : 'text-gray-400 italic'}`}>
                        {prog.isActive ? `Buy ${prog.goal} items, get the ${prog.reward}.` : `This offer is no longer available.`}
                      </p>
                      
                      {prog.isActive ? (
                        <div className="flex gap-3">
                          {!joined ? (
                            <button 
                              onClick={() => joinProgram(prog.id, prog.businessId)}
                              className="flex-1 py-3 bg-coffee-dark text-white rounded-2xl font-bold text-sm shadow-md active:scale-95 transition-all"
                            >
                              Join Program
                            </button>
                          ) : (
                            <div className="flex-1 py-3 bg-gray-50 text-coffee-dark rounded-2xl font-bold text-sm text-center border border-gray-100">
                              Already Joined
                            </div>
                          )}
                          <button 
                            onClick={() => setShowReportModal({ id: prog.id, type: 'program', name: prog.title })}
                            className="p-3 bg-gray-50 text-gray-400 rounded-2xl hover:bg-gray-100 transition-colors"
                            title="Report offensive content"
                          >
                            <Flag size={18} />
                          </button>
                        </div>
                      ) : (
                        <div className="flex gap-3">
                          <div className="flex-1 py-3 bg-gray-50 text-gray-400 rounded-2xl font-bold text-sm text-center border border-gray-100 cursor-not-allowed">
                            Program Closed
                          </div>
                          <button 
                            onClick={() => setShowReportModal({ id: prog.id, type: 'program', name: prog.title })}
                            className="p-3 bg-gray-50 text-gray-400 rounded-2xl hover:bg-gray-100 transition-colors"
                          >
                            <Flag size={18} />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })
            )}
          </motion.div>
        );
      case 'wallet':
        const myBizIdsForWallet = businesses.filter(b => b.ownerId === user?.uid).map(b => b.id);
        // Hide completed cards. Also hide cards for programs that were closed without a 'closedAt' timestamp (Legacy test programs)
        const myFilteredCards = myCards.filter(c => {
          const bizMatch = myBizIdsForWallet.includes(c.businessId);
          if (!bizMatch || c.isCompleted) return false;
          
          const prog = programs.find(p => p.id === c.programId);
          if (!prog) return false;
          
          // If program is inactive, only show it if it has a closedAt timestamp (meaning it's a future graceful closure)
          if (!prog.isActive && !prog.closedAt) return false;
          
          return true;
        });

        const sortedCards = [...myFilteredCards]
          .sort((a, b) => {
            const progA = programs.find(p => p.id === a.programId);
            const progB = programs.find(p => p.id === b.programId);
            if (progA?.isActive && !progB?.isActive) return -1;
            if (!progA?.isActive && progB?.isActive) return 1;
            return 0;
          });

        const activePassesCount = myFilteredCards.filter(c => {
          const p = programs.find(prog => prog.id === c.programId);
          // Count cards that are either for active programs OR for closed programs but not completed
          return p && (p.isActive || !c.isCompleted);
        }).length;

        return (
          <motion.div key="wallet" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="p-4 space-y-6 pb-24">
            <div className="flex items-center justify-between mb-6">
              <h1 className="text-2xl font-bold">Digital Wallet</h1>
              <div className="bg-coffee-cream px-3 py-1 rounded-full">
                <p className="text-[10px] font-black text-coffee-dark uppercase tracking-tighter">
                  {activePassesCount} Active {activePassesCount === 1 ? 'Pass' : 'Passes'}
                </p>
              </div>
            </div>

            {activePassesCount > 0 && (
              <div className="bg-white p-6 rounded-[2.5rem] border border-gray-100 shadow-sm flex items-center gap-4">
                <div className="w-12 h-12 bg-coffee-dark rounded-2xl flex items-center justify-center text-white shadow-lg shadow-coffee-light/20">
                  <Smartphone size={24} />
                </div>
                <div>
                  <p className="text-2xl font-black text-gray-900">{activePassesCount}</p>
                  <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">Active Digital Passes</p>
                </div>
              </div>
            )}

            {sortedCards.length === 0 ? (
              <div className="text-center py-20 space-y-4">
                <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto text-gray-400">
                  <Smartphone size={32} />
                </div>
                <p className="text-gray-500 text-sm">Your wallet is empty. Join your own programs in the Explore tab!</p>
              </div>
            ) : (
              <div className="space-y-6">
                {programs.length === 0 && sortedCards.length > 0 ? (
                  Array.from({ length: 2 }).map((_, i) => <SkeletonCard key={i} />)
                ) : (
                  sortedCards.map(card => {
                    const prog = programs.find(p => p.id === card.programId);
                    const biz = businesses.find(b => b.id === card.businessId);
                    
                    // Use denormalized data as fallback
                    const displayBizName = card.businessName || biz?.name || 'Loading...';
                    const displayProgTitle = card.programTitle || prog?.title || 'Loading...';
                    const displayGoal = card.goal || prog?.goal || 10;
                    const displayReward = prog?.reward || 'Reward Loading...';
                    const isActive = prog ? prog.isActive : true;

                    return (
                      <motion.div 
                        key={card.id} 
                        layout
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        onClick={() => setSelectedCard(card)}
                        className={`bg-white rounded-[2.5rem] p-6 shadow-xl border relative overflow-hidden cursor-pointer active:scale-[0.98] transition-all ${isActive ? 'border-gray-100' : 'border-orange-100'}`}
                      >
                        <div className={`absolute top-0 left-0 right-0 h-32 ${isActive ? 'bg-coffee-dark' : 'bg-orange-600'}`} />
                        
                        {!isActive && (
                          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 bg-white/90 backdrop-blur-sm text-orange-600 text-[10px] font-black px-4 py-1.5 rounded-full shadow-lg border border-orange-100 uppercase tracking-widest whitespace-nowrap">
                            Closing Soon • Final Cycle
                          </div>
                        )}
                        
                        <div className="relative z-10">
                          <div className="flex justify-between items-start mb-8 text-white">
                            <div>
                              <p className="text-[10px] uppercase tracking-widest font-bold opacity-80 mb-1">Loyalty Pass</p>
                              <h2 className="text-2xl font-black">
                                {displayBizName}
                              </h2>
                              <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-1">
                                {(biz?.location || card.businessId) && (
                                  <div className="flex items-center gap-1 text-[10px] text-white/70">
                                    <MapPin size={10} />
                                    <span>{biz?.location || 'Local Store'}</span>
                                  </div>
                                )}
                              </div>
                            </div>
                            <div className={`w-12 h-12 bg-white rounded-2xl flex items-center justify-center font-black text-xl shadow-lg overflow-hidden ${isActive ? 'text-coffee-dark' : 'text-orange-600'}`}>
                              {biz?.logoUrl || card.businessLogo ? (
                                <img src={biz?.logoUrl || card.businessLogo} alt="Logo" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                              ) : (
                                displayBizName[0]
                              )}
                            </div>
                          </div>

                          <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-50 mb-6">
                            <div className="flex justify-between items-end mb-4">
                              <div>
                                <p className="text-xs text-gray-400 font-bold uppercase">{displayProgTitle}</p>
                                <p className="font-bold text-gray-900">{displayReward}</p>
                              </div>
                              <div className="text-right">
                                <p className={`text-3xl font-black ${isActive ? 'text-coffee-dark' : 'text-orange-600'}`}>{card.currentStamps}<span className="text-sm text-gray-400 font-normal">/{displayGoal}</span></p>
                              </div>
                            </div>
                            
                            <div className="flex flex-wrap gap-2">
                              {Array.from({ length: displayGoal }).map((_, i) => (
                                <div 
                                  key={i} 
                                  className={`w-8 h-8 rounded-full flex items-center justify-center border-2 transition-colors duration-500 ${i < card.currentStamps ? (isActive ? 'bg-coffee-dark border-coffee-dark' : 'bg-orange-600 border-orange-600') + ' text-white' : 'border-gray-200 text-transparent'}`}
                                >
                                  <Coffee size={14} />
                                </div>
                              ))}
                            </div>
                          </div>

                          <div className="bg-gray-50 p-6 rounded-3xl flex flex-col items-center justify-center space-y-4">
                            <div className="bg-white p-4 rounded-2xl shadow-sm relative overflow-hidden">
                              <QRCodeSVG value={generateSecureToken(card.id, card.currentStamps)} size={140} />
                            </div>
                            <div className="text-center space-y-1">
                              <p className={`text-xs font-bold uppercase tracking-widest ${isActive ? 'text-emerald-600' : 'text-orange-600'}`}>
                                {isActive ? 'Secure Pass Active' : 'Final Cycle Active'}
                              </p>
                              <div className="flex items-center justify-center gap-2">
                                <ShieldCheck size={10} className="text-emerald-500" />
                                <p className="text-[10px] text-gray-400 font-mono">Verified Digital Pass</p>
                              </div>
                            </div>
                          </div>
                        </div>
                      </motion.div>
                    );
                  })
                )}
              </div>
            )}
          </motion.div>
        );
      case 'profile':
        return (
          <motion.div key="profile" initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} className="p-4 flex flex-col items-center text-center pb-24">
            <div className="w-20 h-20 rounded-full bg-coffee-cream mb-3 border-2 border-white shadow-md overflow-hidden flex items-center justify-center">
              {user.photoURL ? (
                <img src={user.photoURL} alt="Profile" referrerPolicy="no-referrer" className="w-full h-full object-cover" />
              ) : (
                <User className="text-coffee-dark/20" size={32} />
              )}
            </div>
            <h2 className="text-lg font-bold">{profile?.name}</h2>
            <p className="text-gray-500 text-xs mb-6">{profile?.email}</p>
            
            <div className="w-full space-y-2 mb-6 max-w-xs">
              <button 
                onClick={() => setShowPrivacy(true)} 
                className="w-full py-3 bg-gray-100 text-gray-700 rounded-2xl font-bold flex items-center justify-center gap-2 active:scale-95 transition-transform text-sm hover:bg-gray-200"
              >
                <ShieldCheck size={18} /> Privacy Policy
              </button>

              {/* App Version & In-App Update Checker */}
              <div className="w-full bg-white rounded-2xl p-3.5 border border-gray-100 flex items-center justify-between shadow-sm text-left">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-xl bg-coffee-cream flex items-center justify-center text-coffee-dark shrink-0">
                    <Sparkles size={16} />
                  </div>
                  <div>
                    <p className="text-xs font-bold text-gray-900">App Version</p>
                    <p className="text-[10px] text-gray-400 font-mono">v{installedAppVersion}</p>
                  </div>
                </div>
                <button 
                  onClick={() => checkForAppUpdates(true)} 
                  disabled={isCheckingUpdate}
                  className="px-3 py-1.5 bg-coffee-dark text-white rounded-xl text-xs font-bold active:scale-95 transition-transform flex items-center gap-1.5 disabled:opacity-50"
                >
                  <RefreshCw size={12} className={isCheckingUpdate ? "animate-spin" : ""} />
                  {isCheckingUpdate ? "Checking..." : "Check for Updates"}
                </button>
              </div>

              <button 
                onClick={() => setShowSignOutConfirm(true)} 
                className="w-full py-3 bg-gray-100 text-gray-700 rounded-2xl font-bold flex items-center justify-center gap-2 active:scale-95 transition-transform text-sm hover:bg-gray-200"
              >
                <LogOut size={18} /> Sign Out
              </button>
            </div>
            
            {/* Delete Account link aligned with design requirements */}
            <button 
              onClick={() => {
                setDeleteConfirmText('');
                setIsDeletingAccountFlow(true);
                setShowDeleteConfirm(true);
              }} 
              className="text-xs text-[#ef4444] hover:text-[#dc2626] font-bold underline underline-offset-4 mt-6 active:opacity-75 transition-all focus:outline-none"
            >
              Delete Account
            </button>
          </motion.div>
        );
      default:
        return null;
    }
  })()}
</div>
);
};

  return (
    <div className="h-screen max-h-[100dvh] bg-gray-50 font-sans text-gray-900 max-w-md mx-auto relative overflow-hidden flex flex-col shadow-2xl">
      <header className="shrink-0 z-40 bg-white/80 backdrop-blur-md border-b border-gray-100 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-10 h-10 overflow-hidden rounded-xl shadow-sm border border-gray-100">
            <img 
              src="icon.png" 
              alt="RetivoX" 
              className="w-full h-full object-cover"
            />
          </div>
          <span className="font-black text-2xl tracking-tighter text-gray-900 select-none [text-shadow:1px_1px_0_#dcd3cc,_2px_2px_0_#c4b5aa]">
            Retivo<span className="text-[#8d6e63]">X</span>
          </span>
         </div>
         <div className="flex items-center gap-2">
          {!isAdminMode && profile?.role === 'partner' && <span className="text-[8px] font-black bg-emerald-500 text-white px-2 py-1 rounded-full uppercase tracking-tighter">Partner</span>}
          {!isAdminMode && <button className="p-2 hover:bg-gray-100 rounded-full transition-colors"><Bell size={22} className="text-gray-600" /></button>}
        </div>
      </header>

      <main className="flex-1 overflow-y-auto min-h-0 relative">
        <AnimatePresence mode="wait">{renderContent()}</AnimatePresence>
      </main>

      <nav className="absolute bottom-0 left-0 right-0 bg-white/90 backdrop-blur-xl border-t border-gray-100 px-4 py-4 flex items-center justify-between z-50 rounded-t-[2rem] shadow-2xl">
        {isAdminMode ? (
          <>
            <div className="flex-1 flex justify-center">
              <NavButton 
                active={activeTab === 'admin_home'} 
                onClick={() => setActiveTab('admin_home')} 
                icon={<Home size={24} />} 
                label="Home" 
              />
            </div>
            <div className="flex-1 flex justify-center">
              <NavButton 
                active={activeTab === 'profile'} 
                onClick={() => setActiveTab('profile')} 
                icon={<User size={24} />} 
                label="Profile" 
              />
            </div>
          </>
        ) : (
          <>
            <NavButton 
              active={activeTab === 'partner'} 
              onClick={() => setActiveTab('partner')} 
              icon={<LayoutDashboard size={24} />} 
              label="HOME" 
            />
            <NavButton active={activeTab === 'explore'} onClick={() => setActiveTab('explore')} icon={<MapPin size={24} />} label="Explore" />
            <NavButton active={activeTab === 'wallet'} onClick={() => setActiveTab('wallet')} icon={<Smartphone size={24} />} label="Wallet" />
            <NavButton active={activeTab === 'profile'} onClick={() => setActiveTab('profile')} icon={<User size={24} />} label="Profile" />
          </>
        )}
      </nav>







      {/* Delete Cafe Confirmation Modal */}
      <AnimatePresence>
        {cafeToDelete && (
          <motion.div 
            initial={{ opacity: 0 }} 
            animate={{ opacity: 1 }} 
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          >
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }} 
              animate={{ scale: 1, opacity: 1 }} 
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white w-full max-w-sm rounded-[2.5rem] p-8 shadow-2xl space-y-6 text-center"
            >
              <div className="w-16 h-16 bg-red-50 text-red-500 rounded-full flex items-center justify-center mx-auto">
                <Trash2 size={32} />
              </div>
              <div className="space-y-2">
                <h3 className="text-xl font-bold text-gray-900">Delete Cafe?</h3>
                <p className="text-sm text-gray-500">
                  Are you sure you want to delete <strong className="text-gray-800">{cafeToDelete.name} ({cafeToDelete.displayId})</strong>? This action cannot be undone.
                </p>
                <div className="mt-3 p-3 bg-gray-50 rounded-xl text-left border border-gray-100 text-[11px] space-y-1">
                  <div>
                    <span className="text-gray-400 font-bold uppercase text-[9px] block">DOCUMENT ID</span>
                    <span className="font-mono text-gray-700 break-all">{cafeToDelete.id}</span>
                  </div>
                  <div>
                    <span className="text-gray-400 font-bold uppercase text-[9px] block">OWNER ID</span>
                    <span className="font-mono text-gray-700 break-all">
                      {cafeToDelete.ownerId === user?.uid ? `${cafeToDelete.ownerId} (Your Account)` : cafeToDelete.ownerId}
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-3">
                <button 
                  onClick={() => deleteBusinessById(cafeToDelete)}
                  disabled={isDeletingCafe}
                  className="w-full py-4 bg-red-600 hover:bg-red-700 text-white rounded-2xl font-bold shadow-lg shadow-red-200 active:scale-95 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  <Trash2 size={18} />
                  {isDeletingCafe ? 'Deleting...' : 'Yes, Delete Cafe'}
                </button>
                <button 
                  onClick={() => setCafeToDelete(null)}
                  disabled={isDeletingCafe}
                  className="w-full py-4 bg-gray-100 text-gray-600 rounded-2xl font-bold active:scale-95 transition-all"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Background In-App Update Modal */}
      <AnimatePresence>
        {availableUpdate && (
          <motion.div 
            initial={{ opacity: 0 }} 
            animate={{ opacity: 1 }} 
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[210] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          >
            <motion.div 
              initial={{ scale: 0.9, opacity: 0, y: 20 }} 
              animate={{ scale: 1, opacity: 1, y: 0 }} 
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="bg-white w-full max-w-sm rounded-[2.5rem] p-7 shadow-2xl space-y-5 text-center border border-gray-100 overflow-hidden"
            >
              <div className="relative">
                <div className="w-16 h-16 bg-amber-50 text-amber-600 rounded-2xl flex items-center justify-center mx-auto shadow-inner border border-amber-100/60">
                  <Download size={30} className="animate-bounce" />
                </div>
                <div className="absolute top-0 right-1/4">
                  <Sparkles size={16} className="text-amber-400 animate-pulse" />
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 bg-amber-100 text-amber-800 rounded-full text-[10px] font-black uppercase tracking-wider mb-1">
                  Update Ready
                </div>
                <h3 className="text-xl font-black text-gray-900 leading-tight">New Version Available!</h3>
                <p className="text-xs text-gray-500">
                  Version <strong className="text-gray-800">v{availableUpdate.latestVersion}</strong> is ready to download.
                  <span className="block text-[10px] text-gray-400 mt-0.5 font-mono">Current: v{installedAppVersion}</span>
                </p>
              </div>

              {availableUpdate.releaseNotes && (
                <div className="bg-gray-50 p-3.5 rounded-2xl text-left border border-gray-100 text-xs space-y-1 max-h-32 overflow-y-auto">
                  <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">What's New</p>
                  <p className="text-gray-600 text-xs leading-relaxed whitespace-pre-line font-medium">
                    {availableUpdate.releaseNotes}
                  </p>
                </div>
              )}

              <div className="flex flex-col gap-2.5 pt-1">
                <button 
                  onClick={async () => {
                    const defaultDownloadUrl = 'https://github.com/anoopjoy1988/retivox-backend/releases/latest';
                    const url = availableUpdate.downloadUrl || defaultDownloadUrl;
                    if (Capacitor.isNativePlatform()) {
                      try {
                        await Browser.open({ url });
                      } catch (err) {
                        window.open(url, '_system');
                      }
                    } else {
                      window.open(url, '_blank');
                    }
                  }}
                  className="w-full py-4 bg-coffee-dark text-white rounded-2xl font-bold shadow-lg shadow-coffee-dark/20 active:scale-95 transition-all flex items-center justify-center gap-2 text-sm"
                >
                  <Download size={18} />
                  Download & Install Update
                </button>
                <button 
                  onClick={() => {
                    sessionStorage.setItem(`dismissed_update_${availableUpdate.latestVersion}`, 'true');
                    setAvailableUpdate(null);
                  }}
                  className="w-full py-3 bg-gray-100 text-gray-600 rounded-2xl font-bold active:scale-95 transition-all text-xs"
                >
                  Remind Me Later
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Global Sign Out Confirmation Modal */}
      <AnimatePresence>
        {showSignOutConfirm && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowSignOutConfirm(false)}
            className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm cursor-pointer"
          >
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-white w-full max-w-sm rounded-[2.5rem] p-8 shadow-2xl space-y-6 text-center relative cursor-default"
            >
              <button 
                onClick={() => setShowSignOutConfirm(false)} 
                className="absolute right-5 top-5 p-2 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-100 transition-colors"
                title="Close"
              >
                <X size={18} />
              </button>

              <div className="w-20 h-20 bg-red-50 rounded-full flex items-center justify-center mx-auto text-red-600">
                <Power size={40} />
              </div>
              <div className="space-y-2">
                <h3 className="text-xl font-bold text-gray-900">Sign Out Safely?</h3>
                <p className="text-sm text-gray-500">
                  Are you sure you want to end your session? You will need to sign in again to access your dashboard.
                </p>
              </div>
              <div className="flex flex-col gap-3">
                <button 
                  onClick={handleSignOut}
                  className="w-full py-4 bg-red-600 text-white rounded-2xl font-bold shadow-lg shadow-red-200 active:scale-95 transition-all"
                >
                  Yes, Sign Out
                </button>
                <button 
                  onClick={() => setShowSignOutConfirm(false)}
                  className="w-full py-4 bg-gray-100 text-gray-600 rounded-2xl font-bold active:scale-95 transition-all"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function NavButton({ active, onClick, icon, label }: { active: boolean, onClick: () => void, icon: ReactNode, label: string }) {
  return (
    <button onClick={onClick} className={`flex flex-col items-center gap-1 transition-all duration-300 ${active ? 'text-coffee-dark scale-110' : 'text-gray-400 hover:text-gray-600'}`}>
      <div className="relative">
        {icon}
        {active && <motion.div layoutId="nav-indicator" className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-1 h-1 bg-coffee-dark rounded-full" />}
      </div>
      <span className="text-[10px] font-bold uppercase tracking-widest">{label}</span>
    </button>
  );
}



