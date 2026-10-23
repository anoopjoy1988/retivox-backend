import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { QRCodeSVG } from 'qrcode.react';
import { 
  Coffee, 
  Sparkles, 
  CheckCircle2, 
  MapPin, 
  Phone, 
  ExternalLink, 
  ShieldCheck, 
  AlertCircle,
  Share2,
  Store,
  RefreshCw
} from 'lucide-react';

interface PublicCustomerPassViewProps {
  programId: string;
  onSwitchToOwner: () => void;
}

interface ProgramData {
  id: string;
  title: string;
  itemName: string;
  goal: number;
  reward: string;
  businessId: string;
  isActive: boolean;
}

interface BusinessData {
  id?: string;
  name: string;
  logoUrl?: string;
  location?: string;
  contactNumber?: string;
  displayId?: string;
}

export const PublicCustomerPassView: React.FC<PublicCustomerPassViewProps> = ({
  programId,
  onSwitchToOwner
}) => {
  const [loading, setLoading] = useState(true);
  const [program, setProgram] = useState<ProgramData | null>(null);
  const [business, setBusiness] = useState<BusinessData | null>(null);
  const [cardId, setCardId] = useState<string | null>(null);
  const [currentStamps, setCurrentStamps] = useState<number>(0);
  const [goal, setGoal] = useState<number>(10);
  const [isCompleted, setIsCompleted] = useState<boolean>(false);
  
  const [isAddingGoogle, setIsAddingGoogle] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [justStamped, setJustStamped] = useState(false);
  const prevStampsRef = useRef<number>(0);

  // Generate or retrieve persistent customer ID for this browser
  const getCustomerId = () => {
    let cid = localStorage.getItem('retivox_customer_device_id');
    if (!cid) {
      cid = `cust_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      localStorage.setItem('retivox_customer_device_id', cid);
    }
    return cid;
  };

  // 1. Initial Load: Fetch Program, Business, and Create/Retrieve Card
  useEffect(() => {
    let isMounted = true;
    const customerId = getCustomerId();
    const storedCardKey = `retivox_card_${programId}`;
    const storedCardId = localStorage.getItem(storedCardKey);

    const init = async () => {
      try {
        setLoading(true);
        // Load program info from backend
        const res = await fetch(`/api/public/program/${programId}`);
        if (!res.ok) {
          throw new Error("Loyalty program not found or has ended.");
        }
        const data = await res.json();
        if (!isMounted) return;

        setProgram(data.program);
        setBusiness(data.business);
        setGoal(data.program.goal || 10);

        // Join or retrieve card
        const joinRes = await fetch('/api/public/join-pass', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            programId,
            customerId,
            passType: 'web'
          })
        });

        if (joinRes.ok) {
          const joinData = await joinRes.json();
          if (!isMounted) return;
          if (joinData.cardId) {
            setCardId(joinData.cardId);
            localStorage.setItem(storedCardKey, joinData.cardId);
            setCurrentStamps(joinData.card?.currentStamps || 0);
            prevStampsRef.current = joinData.card?.currentStamps || 0;
            setIsCompleted(joinData.card?.isCompleted || false);
          }
        }
      } catch (err: any) {
        if (!isMounted) return;
        setErrorMessage(err.message || "Failed to load loyalty pass.");
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    init();
    return () => { isMounted = false; };
  }, [programId]);

  // 2. Poll for Live Stamp Updates when cashier stamps the card
  useEffect(() => {
    if (!cardId) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/public/card/${cardId}`);
        if (res.ok) {
          const card = await res.json();
          const newStamps = card.currentStamps || 0;
          if (newStamps > prevStampsRef.current) {
            setJustStamped(true);
            setTimeout(() => setJustStamped(false), 4000);
          }
          prevStampsRef.current = newStamps;
          setCurrentStamps(newStamps);
          setIsCompleted(card.isCompleted || false);
        }
      } catch (_) {}
    }, 3000);

    return () => clearInterval(interval);
  }, [cardId]);

  // Handle "Add to Google Wallet"
  const handleAddToGoogleWallet = async () => {
    setIsAddingGoogle(true);
    setErrorMessage(null);
    setStatusMessage(null);

    try {
      const customerId = getCustomerId();
      const res = await fetch('/api/public/join-pass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          programId,
          customerId,
          passType: 'google'
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to generate Google Wallet pass.");
      }

      if (data.wallet?.saveUrl) {
        // Open Google's native Add to Wallet screen
        window.location.href = data.wallet.saveUrl;
      } else if (data.wallet?.message) {
        setStatusMessage(data.wallet.message);
      } else {
        setStatusMessage("Your digital card is active! You can bookmark this page or take a screenshot of your QR code.");
      }
    } catch (err: any) {
      setErrorMessage(err.message || "Could not connect to Google Wallet service.");
    } finally {
      setIsAddingGoogle(false);
    }
  };

  const handleShareLink = () => {
    const url = window.location.href;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2500);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#1B120C] text-white flex flex-col items-center justify-center p-6 text-center">
        <motion.div 
          animate={{ rotate: 360 }}
          transition={{ repeat: Infinity, duration: 1.2, ease: "linear" }}
          className="w-12 h-12 border-4 border-[#D4A373] border-t-transparent rounded-full mb-4"
        />
        <h2 className="text-xl font-bold">Opening Your Loyalty Pass...</h2>
        <p className="text-white/60 text-sm mt-1">No app download needed</p>
      </div>
    );
  }

  if (errorMessage && !program) {
    return (
      <div className="min-h-screen bg-[#1B120C] text-white flex flex-col items-center justify-center p-6 text-center">
        <div className="w-16 h-16 bg-red-500/20 text-red-400 rounded-3xl flex items-center justify-center mb-4 border border-red-500/30">
          <AlertCircle size={32} />
        </div>
        <h2 className="text-2xl font-bold mb-2">Offer Not Found</h2>
        <p className="text-white/60 text-sm max-w-xs mb-6">{errorMessage}</p>
        <button 
          onClick={onSwitchToOwner}
          className="py-3 px-6 bg-white/10 hover:bg-white/20 rounded-2xl font-bold text-sm transition-all"
        >
          Go to Partner Portal
        </button>
      </div>
    );
  }

  const remaining = Math.max(0, goal - currentStamps);
  const qrValue = cardId ? `card:${cardId}` : `join:${programId}`;

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#1C130D] via-[#2A1D15] to-[#120B07] text-white flex flex-col items-center justify-between p-4 sm:p-6 select-none">
      
      {/* Top Bar / Cafe Header */}
      <div className="w-full max-w-md pt-2 pb-4 flex items-center justify-between border-b border-white/10">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-[#D4A373] text-[#1C130D] font-black text-lg flex items-center justify-center overflow-hidden shadow-lg border border-white/20">
            {business?.logoUrl ? (
              <img src={business.logoUrl} alt="Logo" className="w-full h-full object-cover" />
            ) : (
              business?.name?.[0] || <Coffee size={22} />
            )}
          </div>
          <div>
            <h1 className="font-bold text-base sm:text-lg leading-tight flex items-center gap-1.5">
              {business?.name || 'Cafe Loyalty'}
              <ShieldCheck size={16} className="text-[#D4A373]" />
            </h1>
            {business?.location && (
              <p className="text-[11px] text-white/60 flex items-center gap-1">
                <MapPin size={11} />
                <span className="truncate max-w-[200px]">{business.location}</span>
              </p>
            )}
          </div>
        </div>

        <button 
          onClick={handleShareLink}
          className="p-2.5 bg-white/10 hover:bg-white/20 rounded-full text-white/80 transition-all flex items-center justify-center"
          title="Share Pass Link"
        >
          <Share2 size={16} />
        </button>
      </div>

      {/* Main Loyalty Card Container */}
      <div className="w-full max-w-md my-auto py-4 space-y-4">
        
        {/* Celebration Banner on Live Stamp */}
        <AnimatePresence>
          {justStamped && (
            <motion.div 
              initial={{ opacity: 0, y: -20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -20 }}
              className="bg-emerald-500/20 border border-emerald-400/50 p-4 rounded-2xl flex items-center gap-3 text-emerald-200 shadow-xl backdrop-blur-md"
            >
              <CheckCircle2 size={24} className="text-emerald-400 shrink-0" />
              <div>
                <p className="font-bold text-sm">Stamp Received! 🎉</p>
                <p className="text-xs text-emerald-300/80">Your digital pass was just updated by the barista.</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* The Digital Card */}
        <motion.div 
          initial={{ scale: 0.96, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="relative bg-[#241710] border-2 border-[#D4A373]/30 rounded-[2.5rem] p-6 shadow-2xl overflow-hidden backdrop-blur-md"
        >
          {/* Subtle glowing ambient background */}
          <div className="absolute -top-24 -right-24 w-48 h-48 bg-[#D4A373]/15 rounded-full blur-3xl pointer-events-none" />
          <div className="absolute -bottom-24 -left-24 w-48 h-48 bg-[#D4A373]/10 rounded-full blur-3xl pointer-events-none" />

          {/* Card Title & Reward Header */}
          <div className="flex justify-between items-start mb-5 relative z-10">
            <div>
              <span className="text-[10px] font-bold uppercase tracking-widest text-[#D4A373] bg-[#D4A373]/10 px-2.5 py-1 rounded-full border border-[#D4A373]/20">
                Digital Loyalty Pass
              </span>
              <h2 className="text-xl font-bold text-white mt-2 leading-tight">
                {program?.title || 'Reward Card'}
              </h2>
            </div>
            <div className="text-right">
              <span className="text-2xl font-black text-[#D4A373]">{currentStamps}</span>
              <span className="text-sm font-normal text-white/40">/{goal}</span>
              <p className="text-[9px] uppercase tracking-wider text-white/50 font-bold">Stamps</p>
            </div>
          </div>

          {/* Stamp Grid */}
          <div className="grid grid-cols-5 gap-2.5 my-5 relative z-10">
            {Array.from({ length: goal }).map((_, idx) => {
              const isFilled = idx < currentStamps;
              const isGoal = idx === goal - 1;

              return (
                <motion.div 
                  key={idx}
                  whileHover={{ scale: 1.05 }}
                  className={`aspect-square rounded-2xl flex flex-col items-center justify-center relative transition-all duration-300 ${
                    isFilled 
                      ? 'bg-gradient-to-br from-[#D4A373] to-[#B37D4E] text-[#1C130D] shadow-lg shadow-[#D4A373]/20 border border-[#FAEDCD]/40'
                      : 'bg-white/5 border border-dashed border-white/15 text-white/30'
                  }`}
                >
                  {isFilled ? (
                    <Coffee size={18} className="stroke-[2.5]" />
                  ) : isGoal ? (
                    <Sparkles size={16} className="text-[#D4A373]/60" />
                  ) : (
                    <span className="text-xs font-semibold">{idx + 1}</span>
                  )}
                </motion.div>
              );
            })}
          </div>

          {/* Reward Target Notice */}
          <div className="bg-white/5 border border-white/10 rounded-2xl p-3 flex items-center justify-between text-xs mb-5 relative z-10">
            <span className="text-white/60">Reward:</span>
            <span className="font-bold text-[#FAEDCD]">
              {program?.reward || `${program?.itemName || 'Coffee'} on the house`}
            </span>
          </div>

          {/* Barcode/QR Code for Cashier Scan */}
          <div className="bg-white rounded-3xl p-4 flex flex-col items-center justify-center text-center shadow-xl relative z-10">
            <QRCodeSVG value={qrValue} size={150} level="M" />
            <p className="text-[11px] font-bold text-gray-800 mt-2 tracking-wide uppercase">
              Show at Checkout to Stamp
            </p>
            <p className="text-[9px] font-mono text-gray-400">
              {cardId ? `PASS: ${cardId.slice(0, 12)}...` : 'Generating card...'}
            </p>
          </div>

          <p className="text-center text-[11px] text-white/50 mt-4 font-medium">
            {isCompleted ? (
              <span className="text-emerald-400 font-bold">✨ Reward ready to redeem!</span>
            ) : remaining === 1 ? (
              <span className="text-[#D4A373] font-bold">🔥 Only 1 more stamp until your reward!</span>
            ) : (
              <span>Collect {remaining} more stamps to claim your reward</span>
            )}
          </p>
        </motion.div>

        {/* Wallet Save Action Buttons */}
        <div className="space-y-3 pt-2">
          
          {/* Add to Google Wallet Button */}
          <button 
            onClick={handleAddToGoogleWallet}
            disabled={isAddingGoogle}
            className="w-full h-14 bg-black text-white rounded-2xl font-bold flex items-center justify-center gap-3 shadow-xl hover:bg-neutral-900 active:scale-95 transition-all border border-white/10 px-4 disabled:opacity-50"
          >
            {isAddingGoogle ? (
              <div className="flex items-center gap-2">
                <RefreshCw size={18} className="animate-spin text-white" />
                <span className="text-sm">Connecting Google Wallet...</span>
              </div>
            ) : (
              <img 
                src="/add-to-google-wallet.svg" 
                alt="Add to Google Wallet" 
                className="h-7"
              />
            )}
          </button>

          {/* Add to Apple Wallet */}
          <button 
            onClick={() => {
              setStatusMessage("Apple Wallet pass requires Apple Developer certificates (.p12). You can bookmark this web page or add it to your iPhone home screen for 1-tap access!");
            }}
            className="w-full h-12 bg-white/10 hover:bg-white/15 text-white rounded-2xl font-bold text-xs flex items-center justify-center gap-2.5 active:scale-95 transition-all border border-white/10"
          >
            <svg viewBox="0 0 384 512" className="h-4 w-4 fill-white">
              <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z"/>
            </svg>
            Add to Apple Wallet
          </button>
        </div>

        {/* Feedback / Notification Dialog */}
        <AnimatePresence>
          {statusMessage && (
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="bg-[#D4A373]/20 border border-[#D4A373]/40 p-4 rounded-2xl text-xs text-[#FAEDCD] space-y-1"
            >
              <div className="flex items-center gap-1.5 font-bold">
                <Sparkles size={14} className="text-[#D4A373]" />
                Notice
              </div>
              <p>{statusMessage}</p>
            </motion.div>
          )}

          {errorMessage && (
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="bg-red-500/20 border border-red-500/40 p-4 rounded-2xl text-xs text-red-200"
            >
              {errorMessage}
            </motion.div>
          )}

          {copiedLink && (
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="bg-emerald-500/20 border border-emerald-500/40 p-3 rounded-2xl text-xs text-emerald-200 text-center font-bold"
            >
              Pass link copied to clipboard!
            </motion.div>
          )}
        </AnimatePresence>

        {/* Zero-Install Helper Note */}
        <p className="text-[11px] text-center text-white/40 leading-relaxed pt-2">
          💡 <strong>No app download required.</strong> Tap "Add to Google Wallet" above to save this card to your phone, or bookmark this browser tab.
        </p>
      </div>

      {/* Footer / Switch to Shop Owner Mode */}
      <div className="w-full max-w-md pt-4 pb-2 border-t border-white/10 flex justify-between items-center text-[11px] text-white/50">
        <span className="flex items-center gap-1">
          <Store size={12} /> Cafe Partner
        </span>
        <button 
          onClick={onSwitchToOwner}
          className="text-[#D4A373] hover:underline font-bold"
        >
          Are you the shop owner? Sign In →
        </button>
      </div>

    </div>
  );
};
