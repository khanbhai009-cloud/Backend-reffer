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
    
    await setDoc(userRef, {
      id: userId,
      name: firstName,
      photoURL: photoUrl,
      frontendOpened: true,
      // refferBy logic is handled in transaction below to avoid overwrite if exists
    }, { merge: true });

    await runTransaction(db, async (transaction) => {
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists()) return;

      const data = userDoc.data();
      
      // Initialize defaults if missing
      if (data.coins === undefined) transaction.update(userRef, { coins: 0, reffer: 0, rewardGiven: false, tasksCompleted: 0, totalWithdrawals: 0 });
      
      // Set RefferBy if it's a new user and not set yet
      if (!data.refferBy && referralId && referralId !== userId) {
          transaction.update(userRef, { refferBy: referralId });
      }

      // Re-fetch strictly for reward logic
      const freshDoc = await transaction.get(userRef);
      const freshData = freshDoc.data();
      const currentReferrerId = freshData.refferBy;

      if (freshData.frontendOpened && !freshData.rewardGiven && currentReferrerId) {
        const referrerRef = doc(db, 'users', currentReferrerId);
        const referrerDoc = await transaction.get(referrerRef);

        if (referrerDoc.exists()) {
          const referrerData = referrerDoc.data();
          const newCoins = (referrerData.coins || 0) + 500;
          const newRefferCount = (referrerData.reffer || 0) + 1;

          transaction.update(referrerRef, {
            coins: newCoins,
            reffer: newRefferCount
          });

          transaction.update(userRef, {
            rewardGiven: true
          });

          const rewardRef = doc(db, 'ref_rewards', userId);
          transaction.set(rewardRef, {
            userId: userId,
            referrerId: currentReferrerId,
            reward: 500,
            createdAt: serverTimestamp()
          });
        }
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

    // 👇 MAIN CHANGE IS HERE 👇
    await bot.sendPhoto(message.chat.id, 'https://i.ibb.co/CKK6Hyqq/1e48400d0ef9.jpg', {
      caption: welcomeCaption,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { 
              text: '▶ Open App', 
              // 'url' ki jagah hum 'web_app' use karenge
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
