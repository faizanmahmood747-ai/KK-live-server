```javascript
import express from "express";
import { AccessToken } from "livekit-server-sdk";
import admin from "firebase-admin";

const app = express();

app.use(express.json({ limit: "100kb" }));

// ========================================
// LIVEKIT CONFIGURATION
// ========================================

const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

// ========================================
// FIREBASE ADMIN CONFIGURATION
// ========================================

let db = null;
let firebaseAuth = null;
let firebaseReady = false;

try {
  const serviceAccountJson =
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!serviceAccountJson) {
    console.error(
      "FIREBASE_SERVICE_ACCOUNT_JSON is missing"
    );
  } else {
    const serviceAccount = JSON.parse(serviceAccountJson);

    if (admin.apps.length === 0) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    }

    db = admin.firestore();
    firebaseAuth = admin.auth();
    firebaseReady = true;

    console.log("Firebase Admin initialized");
  }
} catch (error) {
  console.error(
    "Firebase initialization failed:",
    error.message
  );
}

// ========================================
// GIFT CATALOGUE
// ========================================

const GIFTS = {
  Rose: {
    name: "Rose",
    emoji: "🌹",
    price: 10
  },
  Heart: {
    name: "Heart",
    emoji: "❤️",
    price: 50
  },
  Diamond: {
    name: "Diamond",
    emoji: "💎",
    price: 100
  },
  Crown: {
    name: "Crown",
    emoji: "👑",
    price: 500
  }
};

const STARTING_COINS = 300;

// ========================================
// VERIFY FIREBASE LOGIN
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
  } catch (error) {
    console.error(
      "Firebase token verification failed:",
      error.message
    );

    res.status(401).json({
      error: "Invalid or expired Firebase login token"
    });

    return null;
  }
}

// ========================================
// HOME ROUTE
// ========================================

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "K.K Live server is running",
    features: ["LiveKit", "Wallet", "Gifts"]
  });
});

// ========================================
// LIVEKIT TOKEN
// ========================================

app.get("/token", async (req, res) => {
  try {
    const room = String(req.query.room || "").trim();
    const identity = String(req.query.identity || "").trim();

    if (
      !room ||
      !identity ||
      room.length > 200 ||
      identity.length > 128
    ) {
      return res.status(400).json({
        error: "Valid room and identity are required"
      });
    }

    if (
      !LIVEKIT_URL ||
      !LIVEKIT_API_KEY ||
      !LIVEKIT_API_SECRET
    ) {
      console.error("LiveKit environment variables are missing");

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
    console.error("Token generation failed:", error);

    return res.status(500).json({
      error: "Could not generate LiveKit token"
    });
  }
});

// ========================================
// GET WALLET
// New users receive 300 coins.
// Existing balances are preserved.
// ========================================

app.get("/wallet", async (req, res) => {
  try {
    const user = await verifyFirebaseUser(req, res);

    if (!user) return;

    const walletRef = db
      .collection("wallets")
      .doc(user.uid);

    const balance = await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(walletRef);

      if (snapshot.exists) {
        const coins = snapshot.data().coins;

        if (!Number.isSafeInteger(coins) || coins < 0) {
          throw new Error("WALLET_DATA_INVALID");
        }

        return coins;
      }

      tx.create(walletRef, {
        uid: user.uid,
        coins: STARTING_COINS,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return STARTING_COINS;
    });

    return res.status(200).json({
      success: true,
      coins: balance
    });
  } catch (error) {
    console.error("Wallet request failed:", error);

    if (error.message === "WALLET_DATA_INVALID") {
      return res.status(500).json({
        error: "Wallet data needs administrator review"
      });
    }

    return res.status(500).json({
      error: "Could not load wallet"
    });
  }
});

// ========================================
// SEND GIFT
// ========================================

app.post("/gift", async (req, res) => {
  try {
    const user = await verifyFirebaseUser(req, res);

    if (!user) return;

    const sessionId = String(
      req.body?.sessionId || ""
    ).trim();

    const giftName = String(
      req.body?.giftName || ""
    ).trim();

    if (
      !sessionId ||
      sessionId.length > 200 ||
      sessionId.includes("/")
    ) {
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

    const sessionRef = db
      .collection("live_sessions")
      .doc(sessionId);

    const walletRef = db
      .collection("wallets")
      .doc(user.uid);

    const senderRef = db
      .collection("users")
      .doc(user.uid);

    const giftRef = sessionRef
      .collection("gifts")
      .doc();

    const result = await db.runTransaction(async (tx) => {
      const sessionSnapshot = await tx.get(sessionRef);
      const walletSnapshot = await tx.get(walletRef);
      const senderSnapshot = await tx.get(senderRef);

      if (!sessionSnapshot.exists) {
        throw new Error("LIVE_SESSION_NOT_FOUND");
      }

      const session = sessionSnapshot.data();

      if (session.status !== "live") {
        throw new Error("LIVE_SESSION_NOT_ACTIVE");
      }

      if (session.hostUid === user.uid) {
        throw new Error("CANNOT_GIFT_SELF");
      }

      if (!walletSnapshot.exists) {
        throw new Error("WALLET_NOT_INITIALIZED");
      }

      const currentCoins = walletSnapshot.data().coins;

      if (
        !Number.isSafeInteger(currentCoins) ||
        currentCoins < 0
      ) {
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
        user.email ||
        "Viewer"
      ).trim().slice(0, 80);

      const remainingCoins = currentCoins - gift.price;

      tx.update(walletRef, {
        coins: remainingCoins,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      tx.create(giftRef, {
        senderUid: user.uid,
        senderName,
        giftName: gift.name,
        emoji: gift.emoji,
        price: gift.price,
        sentAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return {
        coins: remainingCoins,
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
    console.error("Gift request failed:", error);

    const errors = {
      LIVE_SESSION_NOT_FOUND: [
        404,
        "Live session not found"
      ],
      LIVE_SESSION_NOT_ACTIVE: [
        400,
        "This live session is not active"
      ],
      CANNOT_GIFT_SELF: [
        400,
        "You cannot send a gift to your own live"
      ],
      WALLET_NOT_INITIALIZED: [
        400,
        "Load your wallet before sending gifts"
      ],
      WALLET_DATA_INVALID: [
        500,
        "Wallet data needs administrator review"
      ],
      INSUFFICIENT_COINS: [
        400,
        "Not enough coins"
      ]
    };

    const knownError = errors[error.message];

    if (knownError) {
      return res.status(knownError[0]).json({
        error: knownError[1]
      });
    }

    return res.status(500).json({
      error: "Could not send gift"
    });
  }
});

// ========================================
// ERROR HANDLER
// ========================================

app.use((error, req, res, next) => {
  console.error("Express error:", error);

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).json({
    error: "Internal server error"
  });
});

// ========================================
// EXPORT FOR VERCEL
// ========================================

export default app;

// Local development only.
// Vercel imports the exported Express app.
if (!process.env.VERCEL && process.env.NODE_ENV !== "production") {
  const PORT = process.env.PORT || 10000;

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`K.K Live server listening on port ${PORT}`);
  });
}
```
