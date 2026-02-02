import TelegramBot from 'node-telegram-bot-api';
import { initializeApp, getApps, getApp } from 'firebase/app';
import { 
  getFirestore, 
  doc, 
  setDoc, 
  runTransaction, 
  serverTimestamp, 
  increment 
} from 'firebase/firestore';

// ------------------------------------------------------------------
// 1. CONFIGURATION & INITIALIZATION
// ------------------------------------------------------------------

// Firebase Configuration (Replace placeholders with Environment Variables in production)
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY || "YOUR_API_KEY",
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: process.env.FIREBASE_PROJECT_ID || "YOUR_PROJECT_ID",
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "YOUR_SENDER_ID",
  appId: process.env.FIREBASE_APP_ID || "YOUR_APP_ID"
};

// Initialize Firebase (Singleton pattern for Serverless)
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
const db = getFirestore(app);

// Initialize Telegram Bot (Stateless Mode)
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });

// ------------------------------------------------------------------
// 2. HELPER FUNCTIONS
// ------------------------------------------------------------------

/**
 * Fetches the user's profile photo URL from Telegram.
 * Returns null if no photo exists or API fails (to prevent timeouts).
 */
async function getUserProfilePhotoUrl(userId) {
  try {
    const userProfile = await bot.getUserProfilePhotos(userId, { limit: 1 });
    if (userProfile.total_count > 0 && userProfile.photos.length > 0) {
      const fileId = userProfile.photos[0][0].file_id;
      const fileLink = await bot.getFileLink(fileId);
      return fileLink;
    }
  } catch (error) {
    console.warn(`Failed to fetch photo for ${userId}:`, error.message);
  }
  return null;
}

/**
 * Creates or Merges the User in Firestore.
 * Sets frontendOpened = true immediately as per requirements.
 */
async function createOrEnsureUser(userId, firstName, photoURL, referralId) {
  const userRef = doc(db, 'users', userId.toString());
  
  const userData = {
    id: userId,
    name: firstName,
    photoURL: photoURL, // Updates photo if changed
    frontendOpened: true, // Marked immediately
    // Only set these if document doesn't exist (handled by merge logic below slightly differently, 
    // but for strict merging we use setDoc with merge)
  };

  // We need to ensure we don't overwrite existing counters if the user exists.
  // However, setDoc with merge doesn't support "set if missing" easily for fields without reading first.
  // To keep it "One Request", we will use a setDoc with merge, but we initiate counters only if they likely don't exist.
  // A safer way in one-pass is to use default values in the object, but merge:true will overwrite strictly defined values.
  // Strategy: We rely on the Transaction in processReferralReward to handle the sensitive logic.
  // Here we just ensure the document exists and basic info is updated.
  
  await setDoc(userRef, {
    ...userData,
    // We strictly initialize these only if they might be missing. 
    // Since we can't condition inside setDoc, we assume the UI handles display of 0 if missing,
    // OR we use a transaction for creation too. 
    // FOR SPEED: We will just update identity fields. The reward logic initializes the rest if needed.
  }, { merge: true });
  
  // To strictly follow the "Schema" requirement (fields must exist), 
  // we do a quick check-and-set or trust the transaction.
  // Let's ensure the ref field is set if this is a new user.
  if (referralId) {
     // We only set refferBy if it's currently null or missing. This requires a read.
     // To avoid the read penalty, we accept that 'merge' might overwrite if we send it.
     // Better approach: handle "refferBy" inside the reward transaction to ensure we don't overwrite an existing referrer.
  }
}

/**
 * ATOMIC REWARD LOGIC
 * Handles the logic: Check Conditions -> Increment Referrer -> Update User -> Log Reward
 */
async function processReferralReward(userId, referralId) {
  if (!referralId || referralId === userId.toString()) return; // Invalid referral

  const userRef = doc(db, 'users', userId.toString());
  const referrerRef = doc(db, 'users', referralId.toString());
  const rewardRef = doc(db, 'ref_rewards', userId.toString());

  try {
    await runTransaction(db, async (transaction) => {
      // 1. Get current User State
      const userSnap = await transaction.get(userRef);
      if (!userSnap.exists()) return; // Should exist from createOrEnsureUser
      
      const userData = userSnap.data();

      // 2. Check Conditions (Strict)
      // frontendOpened === true (We just set this)
      // rewardGiven === false
      // refferBy is set (or we set it now)
      
      if (userData.rewardGiven === true) return; // Already rewarded
      
      // Check if we need to assign the referrer (First time)
      let currentReferrer = userData.refferBy;
      if (!currentReferrer && referralId) {
        currentReferrer = referralId;
        transaction.set(userRef, { refferBy: currentReferrer }, { merge: true });
      }

      // If still no referrer, abort
      if (!currentReferrer) return;

      // 3. Execute Reward Updates
      // Increment Referrer
      transaction.set(referrerRef, {
        coins: increment(500),
        reffer: increment(1)
      }, { merge: true });

      // Update User (Mark reward given)
      transaction.update(userRef, {
        rewardGiven: true
      });

      // Create Ledger Entry
      transaction.set(rewardRef, {
        userId: userId,
        referrerId: currentReferrer,
        reward: 500,
        createdAt: serverTimestamp()
      });
    });
  } catch (e) {
    console.error("Transaction failed: ", e);
    // We suppress errors here to ensure the welcome message still sends.
  }
}

// ------------------------------------------------------------------
// 3. MAIN HANDLER (VERCEL)
// ------------------------------------------------------------------

export default async function handler(req, res) {
  // 1. Parse Input
  const body = req.body;
  
  // 2. Basic Validation (Is this a Telegram message?)
  if (!body || !body.message) {
    return res.status(200).send('No message found');
  }

  const msg = body.message;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const firstName = msg.from.first_name || 'User';
  const text = msg.text || '';

  try {
    // 3. Extract Referral Parameter (/start ref123)
    let referralId = null;
    if (text.startsWith('/start')) {
      const parts = text.split(' ');
      if (parts.length > 1) {
        referralId = parts[1];
      }
    }

    // 4. Get Photo URL (Async, non-blocking preferred, but we need it for DB)
    const photoURL = await getUserProfilePhotoUrl(userId);

    // 5. Firestore Operations
    // A. Initialize/Update User
    // We use a safe merge to ensure 'frontendOpened' is true and fields exist
    // Note: To strictly initialize counters to 0 on *first* creation, we rely on the fact that
    // Firestore treats missing fields as undefined. We can default them in the UI or use a Pre-condition check.
    // For this implementation, we merge the identity data.
    const userRef = doc(db, 'users', userId.toString());
    
    // We read the doc first to check if we need to initialize counters (0)
    // This adds 1 read but ensures the "Strict Data Model" isn't full of nulls.
    const userSnap = await getDocSafe(userRef);
    
    const baseData = {
      id: userId,
      name: firstName,
      photoURL: photoURL || null,
      frontendOpened: true, // REQUIREMENT
    };

    if (!userSnap.exists) {
      // New User: Initialize all defaults
      await setDoc(userRef, {
        ...baseData,
        coins: 0,
        reffer: 0,
        refferBy: referralId || null,
        tasksCompleted: 0,
        totalWithdrawals: 0,
        rewardGiven: false
      });
    } else {
      // Existing User: Update identity and frontend status only
      await setDoc(userRef, baseData, { merge: true });
    }

    // B. Run Referral Logic (Atomic Transaction)
    // Only runs if a referral ID was present or previously set
    await processReferralReward(userId, referralId);

    // 6. Send Response Message
    const imageUrl = "https://i.ibb.co/CKK6Hyqq/1e48400d0ef9.jpg";
    const caption = `👋 Hi! Welcome ${firstName} ⭐\nYaha aap tasks complete karke real rewards kama sakte ho!\n\n🔥 Daily Tasks\n🔥 Video Watch\n🔥 Mini Apps\n🔥 Referral Bonus\n🔥 Auto Wallet System\n\nReady to earn?\nTap START and your journey begins!`;

    const opts = {
      caption: caption,
      reply_markup: {
        inline_keyboard: [
          [
            { 
              text: "▶ Open App", 
              url: "https://khanbhai009-cloud.github.io/Telegram-bot-web" 
            }
          ],
          [
            { text: "📢 Channel", url: "https://t.me/finisher_tech" },
            { text: "🌐 Community", url: "https://t.me/finisher_techg" }
          ]
        ]
      }
    };

    await bot.sendPhoto(chatId, imageUrl, opts);

  } catch (error) {
    console.error('Error processing webhook:', error);
    // Even on error, return 200 to Telegram to stop them from retrying indefinitely
  }

  // 7. Final Response to Vercel
  res.status(200).send('OK');
}

// Helper to avoid imports messing up if getDoc is used directly inside conditional logic
import { getDoc } from 'firebase/firestore';
async function getDocSafe(ref) {
  const snap = await getDoc(ref);
  return { exists: snap.exists(), data: snap.exists() ? snap.data() : null };
               }

