import express from "express";
import { AccessToken } from "livekit-server-sdk";
import admin from "firebase-admin";

const app = express();

app.use(express.json({ limit: "100kb" }));

const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

let firebaseReady = false;
let db = null;

try {
  if (!admin.apps.length) {
    const serviceAccountJson =
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

    if (!serviceAccountJson) {
      throw new Error(
        "FIREBASE_SERVICE_ACCOUNT_JSON is missing."
      );
    }

    const serviceAccount = JSON.parse(serviceAccountJson);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }

  db = admin.firestore();
  firebaseReady = true;

  console.log("Firebase Admin initialized.");
} catch (error) {
  console.error(
    "Firebase initialization failed:",
    error.message
  );
}

const GIFTS = {
  Rose: { price: 50, emoji: "🌹" },
  Heart: { price: 200, emoji: "❤️" },
  Diamond: { price: 500, emoji: "💎" },
  Crown: { price: 1000, emoji: "👑" },
  Rocket: { price: 5000, emoji: "🚀" },
  Lion: { price: 10000, emoji: "🦁" }
};

function requireFirebase(req, res, next) {
  if (!firebaseReady || !db) {
    return res.status(503).json({
      success: false,
      error: "Firebase Admin is not configured."
    });
  }

  next();
}

async function authenticateUser(req, res, next) {
  try {
    const authorization = req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Firebase login token is required."
      });
    }

    const idToken = authorization.slice(7).trim();

    const decodedToken =
      await admin.auth().verifyIdToken(idToken);

    req.user = { uid: decodedToken.uid };

    next();
  } catch (error) {
    console.error(
      "Authentication failed:",
      error.message
    );

    return res.status(401).json({
      success: false,
      error: "Login verification failed. Please log in again."
    });
  }
}

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "KK Live server is running.",
    firebaseReady
  });
});

app.get("/token", async (req, res) => {
  try {
    const room = String(req.query.room || "").trim();
    const identity = String(req.query.identity || "").trim();

    if (!room || !identity) {
      return res.status(400).json({
        error: "room and identity are required."
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

app.get(
  "/wallet",
  requireFirebase,
  authenticateUser,
  async (req, res) => {
    try {
      const userRef = db
        .collection("users")
        .doc(req.user.uid);

      const snapshot = await userRef.get();

      if (!snapshot.exists) {
        return res.status(404).json({
          success: false,
          error: "User profile not found."
        });
      }

      const coins = snapshot.data().coins ?? 0;

      if (
        typeof coins !== "number" ||
        !Number.isSafeInteger(coins) ||
        coins < 0
      ) {
        return res.status(500).json({
          success: false,
          error: "Invalid wallet balance."
        });
      }

      return res.json({
        success: true,
        coins
      });
    } catch (error) {
      console.error("Wallet loading failed:", error);

      return res.status(500).json({
        success: false,
        error: "Could not load wallet."
      });
    }
  }
);

app.post(
  "/gift",
  requireFirebase,
  authenticateUser,
  async (req, res) => {
    try {
      const senderUid = req.user.uid;
      const sessionId = String(
        req.body.sessionId || ""
      ).trim();

      const giftName = String(
        req.body.giftName || ""
      ).trim();

      const gift = GIFTS[giftName];

      if (
        !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) ||
        !gift
      ) {
        return res.status(400).json({
          success: false,
          error: "Invalid session ID or gift."
        });
      }

      const userRef = db
        .collection("users")
        .doc(senderUid);

      const sessionRef = db
        .collection("live_sessions")
        .doc(sessionId);

      const giftRef = sessionRef
        .collection("gifts")
        .doc();

      const result = await db.runTransaction(
        async (transaction) => {
          const userSnapshot =
            await transaction.get(userRef);

          const sessionSnapshot =
            await transaction.get(sessionRef);

          if (
            !userSnapshot.exists ||
            !sessionSnapshot.exists
          ) {
            throw new Error(
              "User profile or live session not found."
            );
          }

          const userData = userSnapshot.data();
          const sessionData = sessionSnapshot.data();

          const hostUid = String(
            sessionData.hostUid ||
            sessionData.userId ||
            ""
          ).trim();

          if (!hostUid || hostUid === senderUid) {
            throw new Error(
              "Invalid host or self-gifting is not allowed."
            );
          }

          const hostRef = db
            .collection("users")
            .doc(hostUid);

          const hostSnapshot =
            await transaction.get(hostRef);

          if (!hostSnapshot.exists) {
            throw new Error("Host profile not found.");
          }

          const balance = userData.coins;

          if (
            typeof balance !== "number" ||
            !Number.isSafeInteger(balance) ||
            balance < gift.price
          ) {
            throw new Error(
              "Not enough coins or invalid wallet balance."
            );
          }

          const oldDiamonds = Number(
            hostSnapshot.data().diamonds || 0
          );

          if (
            !Number.isSafeInteger(oldDiamonds) ||
            oldDiamonds < 0
          ) {
            throw new Error(
              "Invalid host diamond balance."
            );
          }

          const hostDiamonds = Math.floor(
            gift.price * 0.30
          );

          transaction.update(userRef, {
            coins: balance - gift.price
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
            createdAt:
              admin.firestore.FieldValue.serverTimestamp()
          });

          return {
            coins: balance - gift.price,
            hostDiamonds
          };
        }
      );

      return res.json({
        success: true,
        coins: result.coins,
        gift: giftName,
        emoji: gift.emoji,
        hostDiamonds: result.hostDiamonds
      });
    } catch (error) {
      console.error("Gift sending failed:", error);

      return res.status(400).json({
        success: false,
        error: error.message || "Could not send gift."
      });
    }
  }
);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `Route not found: ${req.method} ${req.path}`
  });
});

export default app;
