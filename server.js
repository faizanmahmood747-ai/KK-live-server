```javascript
import express from "express";
import { AccessToken } from "livekit-server-sdk";
import admin from "firebase-admin";

const app = express();
app.use(express.json({ limit: "100kb" }));

// ========================================
// CONFIGURATION
// ========================================

const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

const HOST_SHARE_PERCENT = 30;
const DIAMONDS_PER_RUPEE_UNIT = 10000;
const RUPEES_PER_DIAMOND_UNIT = 200;
const MIN_WITHDRAWAL_DIAMONDS = 50000;

let firebaseReady = false;
let db = null;
let firebaseAuth = null;

try {
  const serviceAccountJson =
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (serviceAccountJson) {
    const serviceAccount = JSON.parse(serviceAccountJson);

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    }

    db = admin.firestore();
    firebaseAuth = admin.auth();
    firebaseReady = true;

    console.log("Firebase Admin initialized");
  } else {
    console.error("Firebase service account is not configured");
  }
} catch (error) {
  console.error("Firebase initialization failed:", error.message);
}

// ========================================
// GIFT CATALOGUE
// Prices are controlled by the server.
// ========================================

const GIFTS = {
  Rose: {
    name: "Rose",
    emoji: "🌹",
    price: 50
  },
  Heart: {
    name: "Heart",
    emoji: "❤️",
    price: 200
  },
  Diamond: {
    name: "Diamond",
    emoji: "💎",
    price: 500
  },
  Crown: {
    name: "Crown",
    emoji: "👑",
    price: 1000
  },
  Rocket: {
    name: "Rocket",
    emoji: "🚀",
    price: 5000
  },
  Lion: {
    name: "Lion",
    emoji: "🦁",
    price: 10000
  }
};

// ========================================
// HELPER: VERIFY FIREBASE LOGIN
// ========================================

async function verifyFirebaseUser(req, res) {
  if (!firebaseReady || !firebaseAuth || !db) {
    res.status(503).json({
      error: "Firebase server configuration is unavailable"
    });
    return null;
  }

  const authorization = req.headers.authorization || "";

  if (!authorization.startsWith("Bearer ")) {
    res.status(401).json({
      error: "Firebase login token is required"
    });
    return null;
  }

  const idToken = authorization.substring(7).trim();

  if (!idToken) {
    res.status(401).json({
      error: "Firebase login token is required"
    });
    return null;
  }

  try {
    return await firebaseAuth.verifyIdToken(idToken);
  } catch {
    res.status(401).json({
      error: "Invalid or expired Firebase login token"
    });
    return null;
  }
}

// ========================================
// HELPERS
// ========================================

function validDocumentId(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= 200 &&
    !value.includes("/")
  );
}

function getHostUid(sessionData) {
  // Confirm this field matches your actual Firestore schema.
  return (
    sessionData.hostUid ||
    sessionData.hostId ||
    sessionData.uid ||
    null
  );
}

// ========================================
// HOME
// ========================================

app.get("/", (req, res) => {
  res.status(200).send("KK Live server is running");
});

// ========================================
// LIVEKIT TOKEN
// Existing route preserved
// ========================================

app.get("/token", async (req, res) => {
  try {
    const room = String(req.query.room || "").trim();
    const identity = String(req.query.identity || "").trim();

    if (!room || !identity) {
      return res.status(400).json({
        error: "room and identity are required"
      });
    }

    if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      return res.status(500).json({
        error: "LiveKit server configuration is missing"
      });
    }

    const accessToken = new AccessToken(
      LIVEKIT_API_KEY,
      LIVEKIT_API_SECRET,
      {
        identity,
        ttl: "1h"
      }
    );

    accessToken.addGrant({
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true
    });

    const jwt = await accessToken.toJwt();

    return res.status(200).json({
      token: jwt,
      url: LIVEKIT_URL,
      room,
      identity
    });
  } catch (error) {
    console.error("Token generation failed:", error.message);

    return res.status(500).json({
      error: "Could not generate token"
    });
  }
});

// ========================================
// GET WALLET
// New wallets receive ZERO free coins.
// Existing wallet balances are preserved.
// ========================================

app.get("/wallet", async (req, res) => {
  try {
    const user = await verifyFirebaseUser(req, res);
    if (!user) return;

    const walletRef = db.collection("wallets").doc(user.uid);

    const wallet = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(walletRef);

      if (snapshot.exists) {
        const data = snapshot.data();
        const coins = data.coins;

        if (!Number.isSafeInteger(coins) || coins < 0) {
          throw new Error("WALLET_DATA_INVALID");
        }

        const diamonds = Number.isSafeInteger(data.diamonds)
          && data.diamonds >= 0
          ? data.diamonds
          : 0;

        if (data.diamonds !== diamonds) {
          transaction.update(walletRef, { diamonds });
        }

        return { coins, diamonds };
      }

      transaction.create(walletRef, {
        uid: user.uid,
        coins: 0,
        diamonds: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return { coins: 0, diamonds: 0 };
    });

    return res.status(200).json({
      success: true,
      coins: wallet.coins,
      diamonds: wallet.diamonds
    });
  } catch (error) {
    console.error("Wallet request failed:", error.message);

    return res.status(500).json({
      error: "Could not load wallet"
    });
  }
});

// ========================================
// GET GIFT CATALOGUE
// ========================================

app.get("/gifts", (req, res) => {
  return res.status(200).json({
    success: true,
    gifts: Object.values(GIFTS)
  });
});

// ========================================
// SEND GIFT
// Deduct coins and credit host diamonds.
// Host receives 30% of gift coin price.
// ========================================

app.post("/gift", async (req, res) => {
  try {
    const user = await verifyFirebaseUser(req, res);
    if (!user) return;

    const sessionId = String(req.body.sessionId || "").trim();
    const giftName = String(req.body.giftName || "").trim();

    if (!validDocumentId(sessionId)) {
      return res.status(400).json({
        error: "A valid sessionId is required"
      });
    }

    const gift = GIFTS[giftName];

    if (!gift) {
      return res.status(400).json({
        error: "Unknown gift"
      });
    }

    const sessionRef = db.collection("live_sessions").doc(sessionId);
    const walletRef = db.collection("wallets").doc(user.uid);
    const senderRef = db.collection("users").doc(user.uid);
    const giftRef = sessionRef.collection("gifts").doc();

    const result = await db.runTransaction(async (transaction) => {
      const sessionSnapshot = await transaction.get(sessionRef);
      const walletSnapshot = await transaction.get(walletRef);
      const senderSnapshot = await transaction.get(senderRef);

      if (!sessionSnapshot.exists) {
        throw new Error("LIVE_SESSION_NOT_FOUND");
      }

      const sessionData = sessionSnapshot.data();

      if (sessionData.status !== "live") {
        throw new Error("LIVE_SESSION_NOT_ACTIVE");
      }

      const hostUid = getHostUid(sessionData);

      if (!hostUid || typeof hostUid !== "string") {
        throw new Error("HOST_UID_MISSING");
      }

      if (hostUid === user.uid) {
        throw new Error("CANNOT_GIFT_SELF");
      }

      if (!walletSnapshot.exists) {
        throw new Error("WALLET_NOT_INITIALIZED");
      }

      const walletData = walletSnapshot.data();
      const currentCoins = walletData.coins;

      if (!Number.isSafeInteger(currentCoins) || currentCoins < 0) {
        throw new Error("WALLET_DATA_INVALID");
      }

      if (currentCoins < gift.price) {
        throw new Error("INSUFFICIENT_COINS");
      }

      const senderData = senderSnapshot.exists
        ? senderSnapshot.data()
        : {};

      const senderName = String(
        senderData.name ||
        senderData.displayName ||
        user.name ||
        "Viewer"
      ).trim().slice(0, 80);

      const hostWalletRef = db.collection("wallets").doc(hostUid);
      const hostWalletSnapshot = await transaction.get(hostWalletRef);

      const hostWalletData = hostWalletSnapshot.exists
        ? hostWalletSnapshot.data()
        : {};

      const currentDiamonds = hostWalletData.diamonds ?? 0;

      if (
        !Number.isSafeInteger(currentDiamonds) ||
        currentDiamonds < 0
      ) {
        throw new Error("HOST_WALLET_DATA_INVALID");
      }

      // Round down so host never receives more than 30%.
      const diamondsEarned = Math.floor(
        gift.price * HOST_SHARE_PERCENT / 100
      );

      const remainingCoins = currentCoins - gift.price;
      const newDiamonds = currentDiamonds + diamondsEarned;

      transaction.update(walletRef, {
        coins: remainingCoins,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      if (hostWalletSnapshot.exists) {
        transaction.update(hostWalletRef, {
          diamonds: newDiamonds,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } else {
        transaction.create(hostWalletRef, {
          uid: hostUid,
          coins: 0,
          diamonds: newDiamonds,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      transaction.create(giftRef, {
        senderUid: user.uid,
        senderName,
        hostUid,
        giftName: gift.name,
        emoji: gift.emoji,
        price: gift.price,
        diamondsEarned,
        sentAt: admin.firestore.FieldValue.serverTimestamp()
      });

      const earningRef = db.collection("host_earnings").doc();

      transaction.create(earningRef, {
        hostUid,
        senderUid: user.uid,
        sessionId,
        giftName: gift.name,
        coinPrice: gift.price,
        diamondsEarned,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return {
        coins: remainingCoins,
        diamondsEarned,
        gift: gift.name,
        price: gift.price,
        emoji: gift.emoji,
        senderName
      };
    });

    return res.status(200).json({
      success: true,
      message: "Gift sent successfully",
      ...result
    });
  } catch (error) {
    console.error("Gift request failed:", error.message);

    const errors = {
      LIVE_SESSION_NOT_FOUND: [404, "Live session not found"],
      LIVE_SESSION_NOT_ACTIVE: [400, "This live session is not active"],
      WALLET_NOT_INITIALIZED: [400, "Load your wallet before sending gifts"],
      WALLET_DATA_INVALID: [500, "Wallet data needs administrator review"],
      HOST_UID_MISSING: [400, "Host UID is missing from live session"],
      HOST_WALLET_DATA_INVALID: [500, "Host wallet needs administrator review"],
      INSUFFICIENT_COINS: [400, "Not enough coins. Please purchase coins."],
      CANNOT_GIFT_SELF: [400, "You cannot send gifts to your own live session"]
    };

    const mapped = errors[error.message];

    if (mapped) {
      return res.status(mapped[0]).json({ error: mapped[1] });
    }

    return res.status(500).json({
      error: "Could not send gift"
    });
  }
});

// ========================================
// HOST EARNINGS HISTORY
// ========================================

app.get("/host/earnings", async (req, res) => {
  try {
    const user = await verifyFirebaseUser(req, res);
    if (!user) return;

    const snapshot = await db.collection("host_earnings")
      .where("hostUid", "==", user.uid)
      .limit(100)
      .get();

    const earnings = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data()
    }));

    const walletSnapshot = await db.collection("wallets")
      .doc(user.uid)
      .get();

    const diamonds = walletSnapshot.exists
      ? (walletSnapshot.data().diamonds || 0)
      : 0;

    return res.status(200).json({
      success: true,
      diamonds,
      earnings
    });
  } catch (error) {
    console.error("Host earnings request failed:", error.message);

    return res.status(500).json({
      error: "Could not load host earnings"
    });
  }
});

// ========================================
// REQUEST WITHDRAWAL
// Creates a pending request only.
// Does NOT send money automatically.
// ========================================

app.post("/withdraw", async (req, res) => {
  try {
    const user = await verifyFirebaseUser(req, res);
    if (!user) return;

    const diamonds = Number(req.body.diamonds);
    const method = String(req.body.method || "").trim();
    const accountName = String(req.body.accountName || "").trim();
    const accountNumber = String(req.body.accountNumber || "").trim();

    if (
      !Number.isSafeInteger(diamonds) ||
      diamonds < MIN_WITHDRAWAL_DIAMONDS
    ) {
      return res.status(400).json({
        error: `Minimum withdrawal is ${MIN_WITHDRAWAL_DIAMONDS} diamonds`
      });
    }

    if (!["JazzCash", "EasyPaisa", "Bank"].includes(method)) {
      return res.status(400).json({
        error: "Choose JazzCash, EasyPaisa, or Bank"
      });
    }

    if (
      accountName.length < 2 ||
      accountName.length > 100 ||
      accountNumber.length < 5 ||
      accountNumber.length > 50
    ) {
      return res.status(400).json({
        error: "Valid account name and account number are required"
      });
    }

    const walletRef = db.collection("wallets").doc(user.uid);
    const withdrawalRef = db.collection("withdrawals").doc();

    const result = await db.runTransaction(async (transaction) => {
      const walletSnapshot = await transaction.get(walletRef);

      if (!walletSnapshot.exists) {
        throw new Error("WALLET_NOT_INITIALIZED");
      }

      const walletData = walletSnapshot.data();
      const currentDiamonds = walletData.diamonds || 0;

      if (
        !Number.isSafeInteger(currentDiamonds) ||
        currentDiamonds < 0
      ) {
        throw new Error("WALLET_DATA_INVALID");
      }

      if (currentDiamonds < diamonds) {
        throw new Error("INSUFFICIENT_DIAMONDS");
      }

      // 10,000 diamonds = Rs 200.
      // Round down to whole rupees.
      const amountRupees = Math.floor(
        diamonds * RUPEES_PER_DIAMOND_UNIT / DIAMONDS_PER_RUPEE_UNIT
      );

      transaction.update(walletRef, {
        diamonds: currentDiamonds - diamonds,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      transaction.create(withdrawalRef, {
        uid: user.uid,
        diamonds,
        amountRupees,
        method,
        accountName,
        accountNumber,
        status: "pending",
        requestedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return {
        withdrawalId: withdrawalRef.id,
        diamonds,
        amountRupees,
        status: "pending"
      };
    });

    return res.status(200).json({
      success: true,
      message: "Withdrawal request submitted for admin review",
      ...result
    });
  } catch (error) {
    console.error("Withdrawal request failed:", error.message);

    if (error.message === "INSUFFICIENT_DIAMONDS") {
      return res.status(400).json({
        error: "Not enough diamonds"
      });
    }

    if (error.message === "WALLET_NOT_INITIALIZED") {
      return res.status(400).json({
        error: "Host wallet not found"
      });
    }

    if (error.message === "WALLET_DATA_INVALID") {
      return res.status(500).json({
        error: "Wallet data needs administrator review"
      });
    }

    return res.status(500).json({
      error: "Could not submit withdrawal request"
    });
  }
});

// ========================================
// GET MY WITHDRAWAL REQUESTS
// ========================================

app.get("/withdrawals", async (req, res) => {
  try {
    const user = await verifyFirebaseUser(req, res);
    if (!user) return;

    const snapshot = await db.collection("withdrawals")
      .where("uid", "==", user.uid)
      .limit(100)
      .get();

    const withdrawals = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data()
    }));

    return res.status(200).json({
      success: true,
      withdrawals
    });
  } catch (error) {
    console.error("Withdrawal history failed:", error.message);

    return res.status(500).json({
      error: "Could not load withdrawal history"
    });
  }
});

// ========================================
// START SERVER
// ========================================

const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`KK Live server listening on port ${PORT}`);
});
```
