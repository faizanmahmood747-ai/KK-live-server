```javascript
import express from "express";
import { AccessToken } from "livekit-server-sdk";
import admin from "firebase-admin";

const app = express();

app.use(express.json({ limit: "100kb" }));

// LiveKit configuration
const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

// Firebase Admin configuration
let firebaseReady = false;
let db = null;

try {
  if (!admin.apps.length) {
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

  db = admin.firestore();
  firebaseReady = true;

  console.log("Firebase Admin initialized.");
} catch (error) {
  console.error(
    "Firebase Admin initialization failed:",
    error.message
  );
}

// Gift prices controlled by the server
const GIFTS = {
  Rose: { price: 50, emoji: "🌹" },
  Heart: { price: 200, emoji: "❤️" },
  Diamond: { price: 500, emoji: "💎" },
  Crown: { price: 1000, emoji: "👑" },
  Rocket: { price: 5000, emoji: "🚀" },
  Lion: { price: 10000, emoji: "🦁" }
};

function requireFirebase() {
  if (!firebaseReady || !db) {
    const error = new Error(
      "Firebase Admin is not configured on the server."
    );
    error.status = 503;
    throw error;
  }
}

// Verify Firebase ID token
async function authenticateUser(req, res, next) {
  try {
    requireFirebase();

    const authorization = req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Firebase login token is required."
      });
    }

    const idToken = authorization.slice(7).trim();

    if (!idToken) {
      return res.status(401).json({
        success: false,
        error: "Firebase login token is empty."
      });
    }

    const decodedToken =
      await admin.auth().verifyIdToken(idToken);

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

// Basic health check
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "KK Live server is running.",
    firebaseReady
  });
});

// Generate LiveKit token
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

    return res.json({
      token: await token.toJwt(),
      url: LIVEKIT_URL,
      room,
      identity
    });
  } catch (error) {
    console.error("Token generation failed:", error);

    return res.status(500).json({
      error: "Could not generate LiveKit token."
    });
  }
});

// Load wallet
app.get("/wallet", authenticateUser, async (req, res) => {
  try {
    const userRef = db.collection("users").doc(req.user.uid);

    const coins = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(userRef);

      if (!snapshot.exists) {
        const error = new Error("User profile not found.");
        error.status = 404;
        throw error;
      }

      const userData = snapshot.data();
      let balance = userData.coins;

      if (balance === undefined || balance === null) {
        balance = 0;
        transaction.update(userRef, { coins: 0 });
      }

      if (
        typeof balance !== "number" ||
        !Number.isSafeInteger(balance) ||
        balance < 0
      ) {
        const error = new Error("Invalid wallet balance.");
        error.status = 500;
        throw error;
      }

      return balance;
    });

    return res.json({
      success: true,
      coins
    });
  } catch (error) {
    console.error("Wallet loading failed:", error);

    return res.status(error.status || 500).json({
      success: false,
      error: error.message || "Could not load wallet."
    });
  }
});

// Send gift
app.post("/gift", authenticateUser, async (req, res) => {
  try {
    const senderUid = req.user.uid;
    const sessionId = String(req.body.sessionId || "").trim();
    const giftName = String(req.body.giftName || "").trim();

    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid live session ID."
      });
    }

    const gift = GIFTS[giftName];

    if (!gift) {
      return res.status(400).json({
        success: false,
        error: "Unsupported gift."
      });
    }

    const userRef = db.collection("users").doc(senderUid);
    const sessionRef = db
      .collection("live_sessions")
      .doc(sessionId);

    const giftRef = sessionRef.collection("gifts").doc();

    const result = await db.runTransaction(async (transaction) => {
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
      const balance = userData.coins;

      if (
        typeof balance !== "number" ||
        !Number.isSafeInteger(balance) ||
        balance < 0
      ) {
        const error = new Error("Invalid wallet balance.");
        error.status = 500;
        throw error;
      }

      if (balance < gift.price) {
        const error = new Error("Not enough coins.");
        error.status = 400;
        throw error;
      }

      const hostUid = String(
        sessionData.hostUid || sessionData.userId || ""
      ).trim();

      if (!hostUid) {
        const error = new Error(
          "Live session does not contain a host UID."
        );
        error.status = 400;
        throw error;
      }

      if (hostUid === senderUid) {
        const error = new Error(
          "You cannot gift yourself."
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

      const oldDiamonds = Number(
        hostSnapshot.data().diamonds || 0
      );

      if (
        !Number.isSafeInteger(oldDiamonds) ||
        oldDiamonds < 0
      ) {
        const error = new Error("Invalid host diamond balance.");
        error.status = 500;
        throw error;
      }

      const newBalance = balance - gift.price;
      const hostDiamonds = Math.floor(gift.price * 0.30);

      transaction.update(userRef, {
        coins: newBalance
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
        coins: newBalance,
        hostDiamonds
      };
    });

    return res.json({
      success: true,
      coins: result.coins,
      gift: giftName,
      emoji: gift.emoji,
      hostDiamonds: result.hostDiamonds
    });
  } catch (error) {
    console.error("Gift sending failed:", error);

    return res.status(error.status || 500).json({
      success: false,
      error: error.message || "Could not send gift."
    });
  }
});

// Unknown routes
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `Route not found: ${req.method} ${req.path}`
  });
});

// Vercel serverless entry point
export default app;
```
