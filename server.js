```javascript
import express from "express";
import { AccessToken } from "livekit-server-sdk";
import admin from "firebase-admin";

const app = express();

app.use(express.json({ limit: "100kb" }));

const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const ADMIN_UID = process.env.ADMIN_UID;

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

// Only the UID configured in Vercel can use admin APIs.
function requireAdmin(req, res, next) {
  if (!ADMIN_UID) {
    return res.status(503).json({
      success: false,
      error: "ADMIN_UID is not configured in Vercel."
    });
  }

  if (!req.user || req.user.uid !== ADMIN_UID) {
    return res.status(403).json({
      success: false,
      error: "Admin access denied."
    });
  }

  next();
}

function adminOnly(req, res, next) {
  requireFirebase(req, res, (error) => {
    if (error) return next(error);

    authenticateUser(req, res, (authError) => {
      if (authError) return next(authError);

      requireAdmin(req, res, next);
    });
  });
}

function safeDate(value) {
  if (!value) return null;

  if (typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return value;
}

function safeUser(doc) {
  const data = doc.data();

  return {
    uid: doc.id,
    name: data.name || data.displayName || "Unknown",
    email: data.email || "",
    country: data.country || "",
    coins: Number.isSafeInteger(data.coins) ? data.coins : 0,
    diamonds: Number.isSafeInteger(data.diamonds)
      ? data.diamonds
      : 0,
    createdAt: safeDate(data.createdAt)
  };
}

function validUid(uid) {
  return (
    typeof uid === "string" &&
    uid.length > 0 &&
    uid.length <= 128 &&
    !uid.includes("/")
  );
}

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

    if (
      !room ||
      !identity ||
      room.length > 128 ||
      identity.length > 128
    ) {
      return res.status(400).json({
        error: "Valid room and identity are required."
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

// --------------------------------------------------
// USER WALLET
// --------------------------------------------------

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

// --------------------------------------------------
// SEND GIFT
// --------------------------------------------------

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

          if (sessionData.status !== "live") {
            throw new Error(
              "This live session is not active."
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

// --------------------------------------------------
// ADMIN: DASHBOARD SUMMARY
// GET /admin/summary
// --------------------------------------------------

app.get(
  "/admin/summary",
  adminOnly,
  async (req, res) => {
    try {
      const usersSnapshot = await db
        .collection("users")
        .get();

      const sessionsSnapshot = await db
        .collection("live_sessions")
        .get();

      let totalCoins = 0;
      let totalDiamonds = 0;

      usersSnapshot.forEach((doc) => {
        const data = doc.data();

        if (
          typeof data.coins === "number" &&
          Number.isSafeInteger(data.coins) &&
          data.coins >= 0
        ) {
          totalCoins += data.coins;
        }

        if (
          typeof data.diamonds === "number" &&
          Number.isSafeInteger(data.diamonds) &&
          data.diamonds >= 0
        ) {
          totalDiamonds += data.diamonds;
        }
      });

      let activeSessions = 0;

      sessionsSnapshot.forEach((doc) => {
        if (doc.data().status === "live") {
          activeSessions++;
        }
      });

      return res.json({
        success: true,
        totalUsers: usersSnapshot.size,
        totalCoins,
        totalDiamonds,
        totalLiveSessions: activeSessions
      });
    } catch (error) {
      console.error("Admin summary failed:", error);

      return res.status(500).json({
        success: false,
        error: "Could not load dashboard summary."
      });
    }
  }
);

// --------------------------------------------------
// ADMIN: USERS LIST
// GET /admin/users
// --------------------------------------------------

app.get(
  "/admin/users",
  adminOnly,
  async (req, res) => {
    try {
      const snapshot = await db
        .collection("users")
        .limit(200)
        .get();

      const users = snapshot.docs.map(safeUser);

      return res.json({
        success: true,
        count: users.length,
        users
      });
    } catch (error) {
      console.error("Admin users list failed:", error);

      return res.status(500).json({
        success: false,
        error: "Could not load users."
      });
    }
  }
);

// --------------------------------------------------
// ADMIN: ADD COINS TO A USER
// POST /admin/users/:uid/coins
// JSON body: { "amount": 1000 }
// --------------------------------------------------

app.post(
  "/admin/users/:uid/coins",
  adminOnly,
  async (req, res) => {
    try {
      const uid = req.params.uid;
      const amount = req.body.amount;

      if (!validUid(uid)) {
        return res.status(400).json({
          success: false,
          error: "Invalid user UID."
        });
      }

      if (
        typeof amount !== "number" ||
        !Number.isSafeInteger(amount) ||
        amount < 1 ||
        amount > 1000000
      ) {
        return res.status(400).json({
          success: false,
          error: "Amount must be an integer from 1 to 1000000."
        });
      }

      const userRef = db
        .collection("users")
        .doc(uid);

      const result = await db.runTransaction(
        async (transaction) => {
          const snapshot = await transaction.get(userRef);

          if (!snapshot.exists) {
            throw new Error("User profile not found.");
          }

          const oldCoins = snapshot.data().coins ?? 0;

          if (
            typeof oldCoins !== "number" ||
            !Number.isSafeInteger(oldCoins) ||
            oldCoins < 0 ||
            oldCoins + amount > Number.MAX_SAFE_INTEGER
          ) {
            throw new Error("Invalid current coin balance.");
          }

          const newCoins = oldCoins + amount;

          transaction.update(userRef, {
            coins: newCoins
          });

          const logRef = db
            .collection("admin_logs")
            .doc();

          transaction.set(logRef, {
            action: "add_coins",
            adminUid: req.user.uid,
            targetUid: uid,
            amount,
            balanceAfter: newCoins,
            createdAt:
              admin.firestore.FieldValue.serverTimestamp()
          });

          return newCoins;
        }
      );

      return res.json({
        success: true,
        message: "Coins added successfully.",
        uid,
        addedCoins: amount,
        newBalance: result
      });
    } catch (error) {
      console.error("Admin add coins failed:", error);

      const status =
        error.message === "User profile not found."
          ? 404
          : 400;

      return res.status(status).json({
        success: false,
        error: error.message || "Could not add coins."
      });
    }
  }
);

// --------------------------------------------------
// ADMIN: LIVE SESSIONS
// GET /admin/live-sessions
// --------------------------------------------------

app.get(
  "/admin/live-sessions",
  adminOnly,
  async (req, res) => {
    try {
      const snapshot = await db
        .collection("live_sessions")
        .limit(200)
        .get();

      const sessions = snapshot.docs.map((doc) => {
        const data = doc.data();

        return {
          sessionId: doc.id,
          hostUid: data.hostUid || data.userId || "",
          hostName: data.hostName || "Unknown",
          roomName: data.roomName || "",
          status: data.status || "unknown",
          startedAt: safeDate(data.startedAt)
        };
      });

      return res.json({
        success: true,
        count: sessions.length,
        sessions
      });
    } catch (error) {
      console.error("Admin sessions failed:", error);

      return res.status(500).json({
        success: false,
        error: "Could not load live sessions."
      });
    }
  }
);

// --------------------------------------------------
// ADMIN: GIFT HISTORY
// GET /admin/gifts
// --------------------------------------------------

app.get(
  "/admin/gifts",
  adminOnly,
  async (req, res) => {
    try {
      const snapshot = await db
        .collectionGroup("gifts")
        .limit(200)
        .get();

      const gifts = snapshot.docs.map((doc) => {
        const data = doc.data();

        return {
          id: doc.id,
          sessionId: doc.ref.parent.parent
            ? doc.ref.parent.parent.id
            : data.sessionId || "",
          senderUid: data.senderUid || "",
          hostUid: data.hostUid || "",
          giftName: data.giftName || "",
          emoji: data.emoji || "",
          price: data.price || 0,
          hostDiamonds: data.hostDiamonds || 0,
          createdAt: safeDate(data.createdAt)
        };
      });

      gifts.sort((a, b) => {
        return String(b.createdAt || "").localeCompare(
          String(a.createdAt || "")
        );
      });

      return res.json({
        success: true,
        count: gifts.length,
        gifts
      });
    } catch (error) {
      console.error("Admin gifts failed:", error);

      return res.status(500).json({
        success: false,
        error: "Could not load gift history."
      });
    }
  }
);

// --------------------------------------------------
// NOT FOUND
// --------------------------------------------------

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `Route not found: ${req.method} ${req.path}`
  });
});

export default app;
```
