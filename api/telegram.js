import TelegramBot from 'node-telegram-bot-api';
import { initializeApp } from 'firebase/app';
import { 
  getFirestore, 
  doc, 
  setDoc, 
  runTransaction, 
  serverTimestamp 
} from 'firebase/firestore';

// --- 1. CONFIGURATION ---
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });

// --- 2. HELPER FUNCTIONS ---

const extractReferralId = (text) => {
  if (!text || !text.startsWith('/start')) return null;
  const parts = text.split(' ');
  if (parts.length < 2) return null;
  const payload = parts[1];
  if (payload.startsWith('ref')) {
    return payload.replace('ref', '');
  }
  return payload;
};

const getUserPhoto = async (userId) => {
  try {
    const photos = await bot.getUserProfilePhotos(userId, { limit: 1 });
    if (photos.total_count > 0) {
      const fileId = photos.photos[0][0].file_id;
      const file = await bot.getFile(fileId);
      return `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    }
  } catch (error) {
    console.error('Error fetching photo:', error);
  }
  return null;
};

// --- 3. CORE LOGIC ---

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ status: 'ok', message: 'Telegram Bot Webhook Active' });
  }

  try {
    const { message } = req.body;

    if (!message || !message.from || message.from.is_bot) {
      return res.status(200).send('OK');
    }

    const user = message.from;
    const userId = user.id.toString();
    const firstName = user.first_name || 'User';
    const text = message.text || '';

    if (!text.startsWith('/start')) {
      return res.status(200).send('OK');
    }

    const referralId = extractReferralId(text);
    const photoUrl = await getUserPhoto(userId);

    const userRef = doc(db, 'users', userId);
    
    // Step 1: Ensure User Exists (Outside transaction to simplify)
    await setDoc(userRef, {
      id: userId,
      name: firstName,
      photoURL: photoUrl,
      frontendOpened: true
    }, { merge: true });

    // Step 2: Atomic Transaction (FIXED: All Reads First -> Then Writes)
    await runTransaction(db, async (transaction) => {
      // --- READ PHASE ---
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists()) return; // Should exist due to Step 1

      const userData = userDoc.data();
      const currentReferrer = userData.refferBy;
      
      // Determine effective Referrer ID (Existing > New from URL)
      let finalReferrerId = currentReferrer;
      if (!finalReferrerId && referralId && referralId !== userId) {
        finalReferrerId = referralId;
      }

      let referrerDoc = null;
      // Only read referrer if we might need to give a reward
      if (finalReferrerId && !userData.rewardGiven) {
        const referrerRef = doc(db, 'users', finalReferrerId);
        referrerDoc = await transaction.get(referrerRef);
      }

      // --- WRITE PHASE ---
      
      const userUpdates = {};
      
      // Initialize defaults if missing
      if (userData.coins === undefined) {
        userUpdates.coins = 0;
        userUpdates.reffer = 0;
        userUpdates.tasksCompleted = 0;
        userUpdates.totalWithdrawals = 0;
        userUpdates.rewardGiven = false;
      }

      // Set Referrer if new
      if (!currentReferrer && finalReferrerId) {
        userUpdates.refferBy = finalReferrerId;
      }

      // Reward Logic
      if (referrerDoc && referrerDoc.exists() && !userData.rewardGiven) {
        // 1. Mark User as rewarded
        userUpdates.rewardGiven = true;

        // 2. Credit Referrer
        const refData = referrerDoc.data();
        const newCoins = (refData.coins || 0) + 500;
        const newRefferCount = (refData.reffer || 0) + 1;
        
        transaction.update(doc(db, 'users', finalReferrerId), {
          coins: newCoins,
          reffer: newRefferCount
        });

        // 3. Create Ledger Entry
        const rewardRef = doc(db, 'ref_rewards', userId);
        transaction.set(rewardRef, {
          userId: userId,
          referrerId: finalReferrerId,
          reward: 500,
          createdAt: serverTimestamp()
        });
      }

      // Commit User Updates (if any)
      if (Object.keys(userUpdates).length > 0) {
        transaction.update(userRef, userUpdates);
      }
    });

    const welcomeCaption = `
👋 *Hi! Welcome ${firstName}* ⭐
Yaha aap tasks complete karke real rewards kama sakte ho!

🔥 *Daily Tasks*
🔥 *Video Watch*
🔥 *Mini Apps*
🔥 *Referral Bonus*
🔥 *Auto Wallet System*

Ready to earn?
Tap START and your journey begins!
    `;

    await bot.sendPhoto(message.chat.id, 'https://i.ibb.co/CKK6Hyqq/1e48400d0ef9.jpg', {
      caption: welcomeCaption,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { 
              text: '▶ Open App', 
              web_app: { url: 'https://khanbhai009-cloud.github.io/Telegram-bot-web' } 
            } 
          ],
          [
            { text: '📢 Channel', url: 'https://t.me/finisher_tech' },
            { text: '🌐 Community', url: 'https://t.me/finisher_techg' }
          ]
        ]
      }
    });

    return res.status(200).send('OK');

  } catch (error) {
    console.error('Webhook Error:', error);
    return res.status(200).send('Error');
  }
}
