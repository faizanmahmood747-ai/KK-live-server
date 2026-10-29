import express from "express";
import { AccessToken } from "livekit-server-sdk";
import admin from "firebase-admin";

const app = express();

app.use(express.json({ limit: "100kb" }));

const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const ADMIN_UID = process.env.ADMIN_UID;

let db = null;
let firebaseReady = false;
let firebaseError = null;

// ---------------- FIREBASE INITIALIZATION ----------------

try {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (admin.apps.length > 0) {
    db = admin.firestore();
    firebaseReady = true;
  } else if (raw) {
    const serviceAccount = JSON.parse(raw);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });

    db = admin.firestore();
    firebaseReady = true;
  } else {
    firebaseError = "FIREBASE_SERVICE_ACCOUNT_JSON is missing";
    console.error(firebaseError);
  }
} catch (error) {
  firebaseReady = false;
  firebaseError = error.message;
  db = null;
  console.error("Firebase initialization error:", error.message);
}

const GIFTS = {
  Rose: { price: 50, emoji: "🌹" },
  Heart: { price: 200, emoji: "❤️" },
  Diamond: { price: 500, emoji: "💎" },
  Crown: { price: 1000, emoji: "👑" },
  Rocket: { price: 5000, emoji: "🚀" },
  Lion: { price: 10000, emoji: "🦁" }
};

// ---------------- MIDDLEWARE ----------------

function requireFirebase(req, res, next) {
  if (!firebaseReady || !db) {
    return res.status(503).json({
      success: false,
      error: "Firebase is not ready. Check Vercel environment variables."
    });
  }

  next();
}

async function authenticateUser(req, res, next) {
  try {
    const header = req.headers.authorization || "";

    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Firebase login token is required."
      });
    }

    const idToken = header.slice(7).trim();
    const decoded = await admin.auth().verifyIdToken(idToken);

    req.user = { uid: decoded.uid };
    next();
  } catch (error) {
    console.error("Authentication error:", error.message);

    return res.status(401).json({
      success: false,
      error: "Login verification failed. Please sign in again."
    });
  }
}

function adminOnly(req, res, next) {
  requireFirebase(req, res, (error) => {
    if (error) return next(error);

    authenticateUser(req, res, (authError) => {
      if (authError) return next(authError);

      if (!ADMIN_UID) {
        return res.status(503).json({
          success: false,
          error: "ADMIN_UID is missing in Vercel."
        });
      }

      if (req.user.uid !== ADMIN_UID) {
        return res.status(403).json({
          success: false,
          error: "Admin access denied."
        });
      }

      next();
    });
  });
}

function validUid(uid) {
  return typeof uid === "string" &&
    uid.length > 0 &&
    uid.length <= 128 &&
    !uid.includes("/");
}

function dateValue(value) {
  if (!value) return null;

  if (typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return value;
}

// ---------------- HEALTH CHECK ----------------

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "KK Live server is running.",
    firebaseReady,
    firebaseError: firebaseReady ? null : firebaseError,
    livekitConfigured: Boolean(
      LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET
    )
  });
});

// ---------------- GIFTS LIST ----------------

app.get("/gifts", (req, res) => {
  const gifts = Object.entries(GIFTS).map(([name, gift]) => ({
    name,
    price: gift.price,
    emoji: gift.emoji
  }));

  res.json({ success: true, gifts });
});

// ---------------- LIVEKIT TOKEN ----------------

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
        success: false,
        error: "Valid room and identity are required."
      });
    }

    if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      return res.status(503).json({
        success: false,
        error: "LiveKit environment variables are missing."
      });
    }

    const token = new AccessToken(
      LIVEKIT_API_KEY,
      LIVEKIT_API_SECRET,
      { identity, ttl: "1h" }
    );

    token.addGrant({
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true
    });

    return res.json({
      success: true,
      token: await token.toJwt(),
      url: LIVEKIT_URL,
      room,
      identity
    });
  } catch (error) {
    console.error("LiveKit token error:", error.message);

    return res.status(500).json({
      success: false,
      error: "Could not generate LiveKit token."
    });
  }
});

// ---------------- WALLET ----------------

app.get(
  "/wallet",
  requireFirebase,
  authenticateUser,
  async (req, res) => {
    try {
      const snapshot = await db.collection("users")
        .doc(req.user.uid)
        .get();

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

      return res.json({ success: true, coins });
    } catch (error) {
      console.error("Wallet error:", error.message);

      return res.status(500).json({
        success: false,
        error: "Could not load wallet."
      });
    }
  }
);

// ---------------- SEND GIFT ----------------
// POST /gift
// Body: { "sessionId": "SESSION_ID", "giftName": "Rose" }

app.post(
  "/gift",
  requireFirebase,
  authenticateUser,
  async (req, res) => {
    try {
      const senderUid = req.user.uid;
      const sessionId = String(req.body?.sessionId || "").trim();
      const giftName = String(req.body?.giftName || "").trim();
      const gift = GIFTS[giftName];

      if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) || !gift) {
        return res.status(400).json({
          success: false,
          error: "Invalid session ID or gift."
        });
      }

      const userRef = db.collection("users").doc(senderUid);
      const sessionRef = db.collection("live_sessions").doc(sessionId);
      const giftRef = sessionRef.collection("gifts").doc();

      const result = await db.runTransaction(async (transaction) => {
        const userSnap = await transaction.get(userRef);
        const sessionSnap = await transaction.get(sessionRef);

        if (!userSnap.exists || !sessionSnap.exists) {
          throw new Error("User or live session not found.");
        }

        const userData = userSnap.data();
        const sessionData = sessionSnap.data();

        const hostUid = String(
          sessionData.hostUid || sessionData.userId || ""
        ).trim();

        if (!validUid(hostUid) || hostUid === senderUid) {
          throw new Error("Invalid host or self-gifting is not allowed.");
        }

        if (sessionData.status !== "live") {
          throw new Error("This live session is not active.");
        }

        const hostRef = db.collection("users").doc(hostUid);
        const hostSnap = await transaction.get(hostRef);

        if (!hostSnap.exists) {
          throw new Error("Host profile not found.");
        }

        const coins = userData.coins;

        if (
          typeof coins !== "number" ||
          !Number.isSafeInteger(coins) ||
          coins < gift.price
        ) {
          throw new Error("Not enough coins.");
        }

        const oldDiamonds = hostSnap.data().diamonds ?? 0;
        const earnedDiamonds = Math.floor(gift.price * 0.30);

        if (
          typeof oldDiamonds !== "number" ||
          !Number.isSafeInteger(oldDiamonds) ||
          oldDiamonds < 0 ||
          oldDiamonds + earnedDiamonds > Number.MAX_SAFE_INTEGER
        ) {
          throw new Error("Invalid host diamond balance.");
        }

        transaction.update(userRef, {
          coins: coins - gift.price
        });

        transaction.update(hostRef, {
          diamonds: oldDiamonds + earnedDiamonds
        });

        transaction.set(giftRef, {
          senderUid,
          hostUid,
          sessionId,
          giftName,
          emoji: gift.emoji,
          price: gift.price,
          hostDiamonds: earnedDiamonds,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return {
          coins: coins - gift.price,
          hostDiamonds: oldDiamonds + earnedDiamonds
        };
      });

      return res.json({
        success: true,
        giftName,
        emoji: gift.emoji,
        coins: result.coins,
        hostDiamonds: result.hostDiamonds
      });
    } catch (error) {
      console.error("Gift error:", error.message);

      return res.status(400).json({
        success: false,
        error: error.message || "Could not send gift."
      });
    }
  }
);

// ---------------- ADMIN SUMMARY ----------------

app.get("/admin/summary", adminOnly, async (req, res) => {
  try {
    const [usersSnap, sessionsSnap] = await Promise.all([
      db.collection("users").get(),
      db.collection("live_sessions").get()
    ]);

    let totalCoins = 0;
    let totalDiamonds = 0;
    let liveSessions = 0;

    usersSnap.forEach((doc) => {
      const data = doc.data();

      if (Number.isSafeInteger(data.coins) && data.coins >= 0) {
        totalCoins += data.coins;
      }

      if (Number.isSafeInteger(data.diamonds) && data.diamonds >= 0) {
        totalDiamonds += data.diamonds;
      }
    });

    sessionsSnap.forEach((doc) => {
      if (doc.data().status === "live") liveSessions++;
    });

    return res.json({
      success: true,
      totalUsers: usersSnap.size,
      totalCoins,
      totalDiamonds,
      totalLiveSessions: liveSessions
    });
  } catch (error) {
    console.error("Admin summary error:", error.message);

    return res.status(500).json({
      success: false,
      error: "Could not load admin summary."
    });
  }
});

// ---------------- ADMIN USERS ----------------

app.get("/admin/users", adminOnly, async (req, res) => {
  try {
    const snap = await db.collection("users").limit(200).get();

    const users = snap.docs.map((doc) => {
      const data = doc.data();

      return {
        uid: doc.id,
        name: data.name || data.displayName || "Unknown",
        email: data.email || "",
        country: data.country || "",
        coins: data.coins ?? 0,
        diamonds: data.diamonds ?? 0,
        createdAt: dateValue(data.createdAt)
      };
    });

    return res.json({ success: true, count: users.length, users });
  } catch (error) {
    console.error("Admin users error:", error.message);

    return res.status(500).json({
      success: false,
      error: "Could not load users."
    });
  }
});

// ---------------- ADMIN ADD COINS ----------------
// POST /admin/users/UID/coins
// Body: { "amount": 1000 }

app.post("/admin/users/:uid/coins", adminOnly, async (req, res) => {
  try {
    const uid = req.params.uid;
    const amount = req.body?.amount;

    if (!validUid(uid)) {
      return res.status(400).json({
        success: false,
        error: "Invalid UID."
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
        error: "Amount must be from 1 to 1000000."
      });
    }

    const userRef = db.collection("users").doc(uid);

    const balance = await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(userRef);

      if (!snap.exists) {
        throw new Error("User profile not found.");
      }

      const oldCoins = snap.data().coins ?? 0;

      if (
        typeof oldCoins !== "number" ||
        !Number.isSafeInteger(oldCoins) ||
        oldCoins < 0 ||
        oldCoins + amount > Number.MAX_SAFE_INTEGER
      ) {
        throw new Error("Invalid current coin balance.");
      }

      const newBalance = oldCoins + amount;

      transaction.update(userRef, { coins: newBalance });

      const logRef = db.collection("admin_logs").doc();

      transaction.set(logRef, {
        action: "add_coins",
        adminUid: req.user.uid,
        targetUid: uid,
        amount,
        balanceAfter: newBalance,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return newBalance;
    });

    return res.json({
      success: true,
      uid,
      addedCoins: amount,
      newBalance: balance
    });
  } catch (error) {
    console.error("Add coins error:", error.message);

    return res.status(400).json({
      success: false,
      error: error.message || "Could not add coins."
    });
  }
});

// ---------------- ADMIN LIVE SESSIONS ----------------

app.get("/admin/live-sessions", adminOnly, async (req, res) => {
  try {
    const snap = await db.collection("live_sessions").limit(200).get();

    const sessions = snap.docs.map((doc) => {
      const data = doc.data();

      return {
        sessionId: doc.id,
        hostUid: data.hostUid || data.userId || "",
        hostName: data.hostName || "Unknown",
        roomName: data.roomName || "",
        status: data.status || "unknown",
        startedAt: dateValue(data.startedAt)
      };
    });

    return res.json({
      success: true,
      count: sessions.length,
      sessions
    });
  } catch (error) {
    console.error("Admin sessions error:", error.message);

    return res.status(500).json({
      success: false,
      error: "Could not load live sessions."
    });
  }
});

// ---------------- ADMIN GIFT HISTORY ----------------

app.get("/admin/gifts", adminOnly, async (req, res) => {
  try {
    const snap = await db.collectionGroup("gifts").limit(200).get();

    const gifts = snap.docs.map((doc) => {
      const data = doc.data();

      return {
        id: doc.id,
        sessionId: doc.ref.parent.parent?.id || data.sessionId || "",
        senderUid: data.senderUid || "",
        hostUid: data.hostUid || "",
        giftName: data.giftName || "",
        emoji: data.emoji || "",
        price: data.price || 0,
        hostDiamonds: data.hostDiamonds || 0,
        createdAt: dateValue(data.createdAt)
      };
    });

    gifts.sort((a, b) =>
      String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
    );

    return res.json({
      success: true,
      count: gifts.length,
      gifts
    });
  } catch (error) {
    console.error("Admin gifts error:", error.message);

    return res.status(500).json({
      success: false,
      error: "Could not load gift history."
    });
  }
});

// ---------------- UNKNOWN ROUTE ----------------

app.use((req, res) => {
  return res.status(404).json({
    success: false,
    error: "Route not found."
  });
});

// ---------------- FINAL ERROR HANDLER ----------------

app.use((error, req, res, next) => {
  console.error("Unhandled error:", error?.stack || error);

  if (res.headersSent) return next(error);

  return res.status(500).json({
    success: false,
    error: "Internal server error."
  });
});

export default app;
