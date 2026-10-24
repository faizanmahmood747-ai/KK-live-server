```javascript
import express from "express";
import { AccessToken } from "livekit-server-sdk";
import admin from "firebase-admin";

const app = express();

app.use(express.json({ limit: "100kb" }));

// --------------------------------------------------
// ENVIRONMENT CONFIGURATION
// --------------------------------------------------

const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

// --------------------------------------------------
// FIREBASE ADMIN INITIALIZATION
// --------------------------------------------------

let firebaseReady = false;

try {
  if (!admin.apps.length) {
    // Recommended: configure Firebase Admin using
    // Application Default Credentials on the server.
    //
    // For Vercel, set FIREBASE_SERVICE_ACCOUNT_JSON
    // to the complete service-account JSON string.

    const serviceAccountJson =
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

    if (serviceAccountJson) {
      const serviceAccount = JSON.parse(serviceAccountJson);

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    } else {
      admin.initializeApp({
        credential: admin.credential.applicationDefault()
      });
    }
  }

  firebaseReady = true;
  console.log("Firebase Admin initialized.");
} catch (error) {
  console.error(
    "Firebase Admin initialization failed:",
    error.message
  );
}

const db = firebaseReady ? admin.firestore() : null;

// --------------------------------------------------
// CONSTANT GIFT PRICES
// The server, not the Android app, controls prices.
// --------------------------------------------------

const GIFTS = {
  Rose: {
    price: 50,
    emoji: "🌹"
  },
  Heart: {
    price: 200,
    emoji: "❤️"
  },
  Diamond: {
    price: 500,
    emoji: "💎"
  },
  Crown: {
    price: 1000,
    emoji: "👑"
  },
  Rocket: {
    price: 5000,
    emoji: "🚀"
  },
  Lion: {
    price: 10000,
    emoji: "🦁"
  }
};

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function requireFirebase() {
  if (!firebaseReady || !db) {
    const error = new Error(
      "Firebase Admin is not configured on the server."
    );
    error.status = 503;
    throw error;
  }
}

async function authenticateUser(req, res, next) {
  try {
    requireFirebase();

    const authorization = req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Login verification token is required."
      });
    }

    const idToken = authorization.slice(7).trim();

    if (!idToken) {
      return res.status(401).json({
        success: false,
        error: "Login verification token is empty."
      });
    }

    const decodedToken = await admin.auth().verifyIdToken(idToken);

    req.user = {
      uid: decodedToken.uid
    };

    next();
  } catch (error) {
    console.error("Authentication failed:", error.message);

    return res.status(error.status || 401).json({
      success: false,
      error:
        error.status === 503
          ? "Firebase Admin is not configured."
          : "Login verification failed. Please log in again."
    });
  }
}

function validSessionId(sessionId) {
  return (
    typeof sessionId === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(sessionId)
  );
}

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "KK Live server is running.",
    firebaseReady
  });
});

// --------------------------------------------------
// LIVEKIT TOKEN
// --------------------------------------------------

app.get("/token", async (req, res) => {
  try {
    const room = String(req.query.room || "").trim();
    const identity = String(req.query.identity || "").trim();

    if (!room || !identity) {
      return res.status(400).json({
        error: "room and identity are required."
      });
    }

    if (room.length > 128 || identity.length > 128) {
      return res.status(400).json({
        error: "Room or identity is too long."
      });
    }

    if (
      !LIVEKIT_URL ||
      !LIVEKIT_API_KEY ||
      !LIVEKIT_API_SECRET
    ) {
      return res.status(500).json({
        error: "LiveKit server configuration is missing."
      });
    }

    const token = new AccessToken(
      LIVEKIT_API_KEY,
      LIVEKIT_API_SECRET,
      {
        identity,
        ttl: "1h"
      }
    );

    token.addGrant({
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true
    });

    const jwt = await token.toJwt();

    return res.json({
      token: jwt,
      url: LIVEKIT_URL,
      room,
      identity
    });
  } catch (error) {
    console.error("Token generation failed:", error);

    return res.status(500).json({
      error: "Could not generate token."
    });
  }
});

// --------------------------------------------------
// GET WALLET
// GET /wallet
// Requires: Authorization: Bearer <Firebase ID token>
// --------------------------------------------------

app.get("/wallet", authenticateUser, async (req, res) => {
  try {
    const uid = req.user.uid;

    const userRef = db.collection("users").doc(uid);

    const result = await db.runTransaction(async (transaction) => {
      const userSnapshot = await transaction.get(userRef);

      if (!userSnapshot.exists) {
        const error = new Error("User profile not found.");
        error.status = 404;
        throw error;
      }

      const userData = userSnapshot.data();

      let coins = userData.coins;

      if (coins === undefined || coins === null) {
        // New wallets start at zero. No free coins are added.
        coins = 0;

        transaction.update(userRef, {
          coins: 0
        });
      }

      if (
        typeof coins !== "number" ||
        !Number.isSafeInteger(coins) ||
        coins < 0
      ) {
        const error = new Error("Wallet balance is invalid.");
        error.status = 500;
        throw error;
      }

      return coins;
    });

    return res.json({
      success: true,
      coins: result
    });
  } catch (error) {
    console.error("Wallet loading failed:", error);

    return res.status(error.status || 500).json({
      success: false,
      error: error.message || "Could not load wallet."
    });
  }
});

// --------------------------------------------------
// SEND GIFT
// POST /gift
// Body: { "sessionId": "...", "giftName": "Rose" }
// Requires: Authorization: Bearer <Firebase ID token>
// --------------------------------------------------

app.post("/gift", authenticateUser, async (req, res) => {
  try {
    const senderUid = req.user.uid;

    const sessionId = String(req.body.sessionId || "").trim();
    const giftName = String(req.body.giftName || "").trim();

    if (!validSessionId(sessionId)) {
      return res.status(400).json({
        success: false,
        error: "A valid live session ID is required."
      });
    }

    const gift = GIFTS[giftName];

    if (!gift) {
      return res.status(400).json({
        success: false,
        error: "This gift is not supported."
      });
    }

    const userRef = db.collection("users").doc(senderUid);

    const sessionRef = db
      .collection("live_sessions")
      .doc(sessionId);

    const giftRef = sessionRef.collection("gifts").doc();

    const transactionResult = await db.runTransaction(
      async (transaction) => {
        const userSnapshot = await transaction.get(userRef);
        const sessionSnapshot = await transaction.get(sessionRef);

        if (!userSnapshot.exists) {
          const error = new Error("User profile not found.");
          error.status = 404;
          throw error;
        }

        if (!sessionSnapshot.exists) {
          const error = new Error("Live session not found.");
          error.status = 404;
          throw error;
        }

        const userData = userSnapshot.data();
        const sessionData = sessionSnapshot.data();

        const coins = userData.coins;

        if (
          typeof coins !== "number" ||
          !Number.isSafeInteger(coins) ||
          coins < 0
        ) {
          const error = new Error("Wallet balance is invalid.");
          error.status = 500;
          throw error;
        }

        if (coins < gift.price) {
          const error = new Error("Not enough coins.");
          error.status = 400;
          throw error;
        }

        const hostUid = String(
          sessionData.hostUid || sessionData.userId || ""
        ).trim();

        if (!hostUid) {
          const error = new Error(
            "Live session does not have a valid host."
          );
          error.status = 400;
          throw error;
        }

        if (hostUid === senderUid) {
          const error = new Error(
            "You cannot send a gift to your own live session."
          );
          error.status = 400;
          throw error;
        }

        const hostRef = db.collection("users").doc(hostUid);
        const hostSnapshot = await transaction.get(hostRef);

        if (!hostSnapshot.exists) {
          const error = new Error("Host profile not found.");
          error.status = 404;
          throw error;
        }

        const updatedCoins = coins - gift.price;

        // Platform/host split: host receives 30% as diamonds.
        // 10,000 diamonds = Rs 200.
        const hostDiamonds = Math.floor(gift.price * 0.30);

        const hostData = hostSnapshot.data();
        const oldDiamonds = Number(hostData.diamonds || 0);

        if (
          !Number.isSafeInteger(oldDiamonds) ||
          oldDiamonds < 0
        ) {
          const error = new Error("Host diamond balance is invalid.");
          error.status = 500;
          throw error;
        }

        transaction.update(userRef, {
          coins: updatedCoins
        });

        transaction.update(hostRef, {
          diamonds: oldDiamonds + hostDiamonds
        });

        transaction.set(giftRef, {
          senderUid,
          hostUid,
          sessionId,
          giftName,
          emoji: gift.emoji,
          price: gift.price,
          hostDiamonds,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return {
          coins: updatedCoins,
          hostDiamonds,
          giftName,
          emoji: gift.emoji
        };
      }
    );

    return res.json({
      success: true,
      coins: transactionResult.coins,
      gift: transactionResult.giftName,
      emoji: transactionResult.emoji,
      hostDiamonds: transactionResult.hostDiamonds
    });
  } catch (error) {
    console.error("Gift sending failed:", error);

    return res.status(error.status || 500).json({
      success: false,
      error: error.message || "Could not send gift."
    });
  }
});

// --------------------------------------------------
// 404 HANDLER
// --------------------------------------------------

app.use((req, res) => {
  return res.status(404).json({
    success: false,
    error: `Route not found: ${req.method} ${req.path}`
  });
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`KK Live server listening on port ${PORT}`);
});
```
