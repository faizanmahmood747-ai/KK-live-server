import express from "express";
import { AccessToken } from "livekit-server-sdk";
import admin from "firebase-admin";

const app = express();
app.use(express.json({ limit: "100kb" }));

// ================================
// LIVEKIT CONFIGURATION
// ================================

const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

// ================================
// FIREBASE ADMIN CONFIGURATION
// ================================

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

// ================================
// GIFT CATALOGUE
// Prices are controlled by the server.
// Never trust prices sent by the app.
// ================================

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

// ================================
// HELPER: VERIFY FIREBASE LOGIN
// ================================

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
    const decodedToken = await firebaseAuth.verifyIdToken(idToken);

    return decodedToken;
  } catch (error) {
    res.status(401).json({
      error: "Invalid or expired Firebase login token"
    });

    return null;
  }
}

// ================================
// HOME ROUTE
// ================================

app.get("/", (req, res) => {
  res.status(200).send("KK Live token and wallet server is running");
});

// ================================
// LIVEKIT TOKEN ROUTE
// Existing route preserved
// ================================

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
    console.error("Token generation failed:", error.message);

    return res.status(500).json({
      error: "Could not generate token"
    });
  }
});

// ================================
// GET WALLET
// Creates a wallet with 100 coins
// only if that user's wallet doesn't exist.
// ================================

app.get("/wallet", async (req, res) => {
  try {
    const user = await verifyFirebaseUser(req, res);

    if (!user) {
      return;
    }

    const walletRef = db.collection("wallets").doc(user.uid);

    const balance = await db.runTransaction(async (transaction) => {
      const walletSnapshot = await transaction.get(walletRef);

      if (walletSnapshot.exists) {
        const currentCoins = walletSnapshot.data().coins;

        if (
          !Number.isSafeInteger(currentCoins) ||
          currentCoins < 0
        ) {
          throw new Error("WALLET_DATA_INVALID");
        }

        return currentCoins;
      }

      transaction.create(walletRef, {
        uid: user.uid,
        coins: 100,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return 100;
    });

    return res.status(200).json({
      success: true,
      coins: balance
    });
  } catch (error) {
    console.error("Wallet request failed:", error.message);

    return res.status(500).json({
      error: "Could not load wallet"
    });
  }
});

// ================================
// SEND GIFT
// Firebase login + live session +
// wallet balance checked on server.
// ================================

app.post("/gift", async (req, res) => {
  try {
    const user = await verifyFirebaseUser(req, res);

    if (!user) {
      return;
    }

    const sessionId = String(req.body.sessionId || "").trim();
    const giftName = String(req.body.giftName || "").trim();

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

      if (sessionSnapshot.data().status !== "live") {
        throw new Error("LIVE_SESSION_NOT_ACTIVE");
      }

      if (!walletSnapshot.exists) {
        throw new Error("WALLET_NOT_INITIALIZED");
      }

      const walletData = walletSnapshot.data();
      const currentCoins = walletData.coins;

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
        "Viewer"
      ).trim().slice(0, 80);

      const remainingCoins = currentCoins - gift.price;

      transaction.update(walletRef, {
        coins: remainingCoins,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      transaction.create(giftRef, {
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
    console.error("Gift request failed:", error.message);

    if (error.message === "LIVE_SESSION_NOT_FOUND") {
      return res.status(404).json({
        error: "Live session not found"
      });
    }

    if (error.message === "LIVE_SESSION_NOT_ACTIVE") {
      return res.status(400).json({
        error: "This live session is not active"
      });
    }

    if (error.message === "WALLET_NOT_INITIALIZED") {
      return res.status(400).json({
        error: "Load your wallet before sending gifts"
      });
    }

    if (error.message === "WALLET_DATA_INVALID") {
      return res.status(500).json({
        error: "Wallet data needs administrator review"
      });
    }

    if (error.message === "INSUFFICIENT_COINS") {
      return res.status(400).json({
        error: "Not enough coins"
      });
    }

    return res.status(500).json({
      error: "Could not send gift"
    });
  }
});

// ================================
// START SERVER
// ================================

const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`KK Live server listening on port ${PORT}`);
});
