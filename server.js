import express from "express";
import { AccessToken } from "livekit-server-sdk";
import admin from "firebase-admin";

const app = express();

app.use(express.json({ limit: "100kb" }));

const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const ADMIN_UID = process.env.ADMIN_UID;

const db = (() => {
  try {
    if (admin.apps.length > 0) {
      return admin.firestore();
    }

    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

    if (!raw) {
      console.error("FIREBASE_SERVICE_ACCOUNT_JSON is missing");
      return null;
    }

    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(raw))
    });

    return admin.firestore();
  } catch (error) {
    console.error("Firebase initialization error:", error.message);
    return null;
  }
})();

const firebaseReady = Boolean(db);

const GIFTS = {
  Rose: { price: 50, emoji: "🌹" },
  Heart: { price: 200, emoji: "❤️" },
  Diamond: { price: 500, emoji: "💎" },
  Crown: { price: 1000, emoji: "👑" },
  Rocket: { price: 5000, emoji: "🚀" },
  Lion: { price: 10000, emoji: "🦁" }
};

const RECHARGE_PACKAGES = {
  100: 4000,
  500: 20000,
  1000: 40000,
  2000: 80000,
  5000: 200000
};

const REQUIRED_GIFT_COINS = 200000;
const REQUIRED_DIAMONDS = 60000;
const WITHDRAWAL_AMOUNT = 1500;

// ---------------- MIDDLEWARE ----------------

function requireFirebase(req, res, next) {
  if (!db) {
    return res.status(503).json({
      success: false,
      error: "Firebase is not ready."
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

    const decoded = await admin.auth().verifyIdToken(
      header.slice(7).trim()
    );

    req.user = { uid: decoded.uid };
    next();
  } catch (error) {
    console.error("Authentication error:", error.message);

    return res.status(401).json({
      success: false,
      error: "Login verification failed."
    });
  }
}

function adminOnly(req, res, next) {
  if (!ADMIN_UID) {
    return res.status(503).json({
      success: false,
      error: "ADMIN_UID is missing."
    });
  }

  authenticateUser(req, res, (error) => {
    if (error) return next(error);

    if (req.user.uid !== ADMIN_UID) {
      return res.status(403).json({
        success: false,
        error: "Admin access denied."
      });
    }

    next();
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

function validText(value, max = 150) {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= max;
}

// ---------------- HEALTH CHECK ----------------

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "KK Live server is running.",
    firebaseReady,
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

    if (!room || !identity || room.length > 128 || identity.length > 128) {
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
      const snap = await db.collection("users")
        .doc(req.user.uid)
        .get();

      if (!snap.exists) {
        return res.status(404).json({
          success: false,
          error: "User profile not found."
        });
      }

      const data = snap.data();

      return res.json({
        success: true,
        coins: data.coins ?? 0,
        diamonds: data.diamonds ?? 0,
        giftCoinsReceived: data.giftCoinsReceived ?? 0,
        withdrawalReservedDiamonds:
          data.withdrawalReservedDiamonds ?? 0
      });
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

      const result = await db.runTransaction(async (tx) => {
        const userSnap = await tx.get(userRef);
        const sessionSnap = await tx.get(sessionRef);

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
        const hostSnap = await tx.get(hostRef);

        if (!hostSnap.exists) {
          throw new Error("Host profile not found.");
        }

        const coins = userData.coins ?? 0;
        const hostData = hostSnap.data();

        if (
          !Number.isSafeInteger(coins) ||
          coins < gift.price
        ) {
          throw new Error("Not enough coins.");
        }

        const oldDiamonds = hostData.diamonds ?? 0;
        const oldGiftCoins = hostData.giftCoinsReceived ?? 0;
        const earnedDiamonds = Math.floor(gift.price * 0.30);

        if (
          !Number.isSafeInteger(oldDiamonds) ||
          oldDiamonds < 0 ||
          !Number.isSafeInteger(oldGiftCoins) ||
          oldGiftCoins < 0 ||
          oldDiamonds + earnedDiamonds > Number.MAX_SAFE_INTEGER ||
          oldGiftCoins + gift.price > Number.MAX_SAFE_INTEGER
        ) {
          throw new Error("Invalid host wallet balance.");
        }

        tx.update(userRef, {
          coins: coins - gift.price
        });

        tx.update(hostRef, {
          diamonds: oldDiamonds + earnedDiamonds,
          giftCoinsReceived: oldGiftCoins + gift.price
        });

        tx.set(giftRef, {
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
          diamonds: oldDiamonds + earnedDiamonds,
          giftCoinsReceived: oldGiftCoins + gift.price
        };
      });

      return res.json({
        success: true,
        giftName,
        emoji: gift.emoji,
        coins: result.coins,
        hostDiamonds: result.diamonds,
        giftCoinsReceived: result.giftCoinsReceived
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

// ---------------- RECHARGE REQUEST ----------------
// POST /recharge/request
// amount, method, transactionReference, screenshotUrl

app.post(
  "/recharge/request",
  requireFirebase,
  authenticateUser,
  async (req, res) => {
    try {
      const amount = req.body?.amount;
      const method = String(req.body?.method || "").trim();
      const transactionReference =
        String(req.body?.transactionReference || "").trim();
      const screenshotUrl = String(req.body?.screenshotUrl || "").trim();

      const coins = RECHARGE_PACKAGES[amount];

      if (!coins) {
        return res.status(400).json({
          success: false,
          error: "Invalid recharge package."
        });
      }

      if (!["Easypaisa", "NBP"].includes(method)) {
        return res.status(400).json({
          success: false,
          error: "Choose Easypaisa or NBP."
        });
      }

      if (!validText(transactionReference, 100)) {
        return res.status(400).json({
          success: false,
          error: "Transaction reference is required."
        });
      }

      if (
        !validText(screenshotUrl, 2000) ||
        !screenshotUrl.startsWith("https://")
      ) {
        return res.status(400).json({
          success: false,
          error: "A valid payment screenshot URL is required."
        });
      }

      const userRef = db.collection("users").doc(req.user.uid);
      const userSnap = await userRef.get();

      if (!userSnap.exists) {
        return res.status(404).json({
          success: false,
          error: "User profile not found."
        });
      }

      const requestRef = db.collection("recharge_requests").doc();

      await requestRef.set({
        uid: req.user.uid,
        userName: userSnap.data().name || "Unknown",
        amount,
        coins,
        method,
        transactionReference,
        screenshotUrl,
        status: "pending",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return res.json({
        success: true,
        message: "Recharge request submitted. Waiting for admin approval.",
        requestId: requestRef.id,
        amount,
        coins
      });
    } catch (error) {
      console.error("Recharge request error:", error.message);

      return res.status(500).json({
        success: false,
        error: "Could not submit recharge request."
      });
    }
  }
);

// ---------------- USER RECHARGE HISTORY ----------------

app.get(
  "/recharge/my-requests",
  requireFirebase,
  authenticateUser,
  async (req, res) => {
    try {
      const snap = await db.collection("recharge_requests")
        .where("uid", "==", req.user.uid)
        .limit(100)
        .get();

      const requests = snap.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
        createdAt: dateValue(doc.data().createdAt)
      }));

      return res.json({ success: true, requests });
    } catch (error) {
      console.error("Recharge history error:", error.message);

      return res.status(500).json({
        success: false,
        error: "Could not load recharge history."
      });
    }
  }
);

// ---------------- WITHDRAWAL REQUEST ----------------
// POST /withdrawal/request
// method, accountTitle, accountNumber, bankName

app.post(
  "/withdrawal/request",
  requireFirebase,
  authenticateUser,
  async (req, res) => {
    try {
      const uid = req.user.uid;
      const method = String(req.body?.method || "").trim();
      const accountTitle = String(req.body?.accountTitle || "").trim();
      const accountNumber = String(req.body?.accountNumber || "").trim();
      const bankName = String(req.body?.bankName || "").trim();

      if (!["Easypaisa", "JazzCash", "Bank"].includes(method)) {
        return res.status(400).json({
          success: false,
          error: "Invalid withdrawal method."
        });
      }

      if (!validText(accountTitle, 100)) {
        return res.status(400).json({
          success: false,
          error: "Account title is required."
        });
      }

      if (!validText(accountNumber, 100)) {
        return res.status(400).json({
          success: false,
          error: "Account number or IBAN is required."
        });
      }

      if (method === "Bank" && !validText(bankName, 100)) {
        return res.status(400).json({
          success: false,
          error: "Bank name is required."
        });
      }

      const userRef = db.collection("users").doc(uid);
      const requestRef = db.collection("withdrawal_requests").doc();

      await db.runTransaction(async (tx) => {
        const userSnap = await tx.get(userRef);

        if (!userSnap.exists) {
          throw new Error("User profile not found.");
        }

        const data = userSnap.data();

        const giftCoinsReceived = data.giftCoinsReceived ?? 0;
        const diamonds = data.diamonds ?? 0;
        const reserved = data.withdrawalReservedDiamonds ?? 0;
        const withdrawn = data.withdrawnDiamonds ?? 0;

        if (
          !Number.isSafeInteger(giftCoinsReceived) ||
          !Number.isSafeInteger(diamonds) ||
          !Number.isSafeInteger(reserved) ||
          !Number.isSafeInteger(withdrawn)
        ) {
          throw new Error("Invalid wallet values.");
        }

        const earnedTranches = Math.floor(
          giftCoinsReceived / REQUIRED_GIFT_COINS
        );

        const eligibleDiamonds = earnedTranches * REQUIRED_DIAMONDS;
        const alreadyUsed = withdrawn + reserved;
        const availableEligible = eligibleDiamonds - alreadyUsed;

        if (availableEligible < REQUIRED_DIAMONDS) {
          throw new Error(
            "You need to receive gifts worth 200,000 Coins before withdrawal."
          );
        }

        if (diamonds - reserved < REQUIRED_DIAMONDS) {
          throw new Error("Insufficient available Diamonds.");
        }

        tx.update(userRef, {
          withdrawalReservedDiamonds: reserved + REQUIRED_DIAMONDS
        });

        tx.set(requestRef, {
          uid,
          userName: data.name || "Unknown",
          method,
          accountTitle,
          accountNumber,
          bankName: method === "Bank" ? bankName : "",
          diamonds: REQUIRED_DIAMONDS,
          amount: WITHDRAWAL_AMOUNT,
          status: "pending",
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });

      return res.json({
        success: true,
        message: "Withdrawal request submitted.",
        requestId: requestRef.id,
        diamonds: REQUIRED_DIAMONDS,
        amount: WITHDRAWAL_AMOUNT
      });
    } catch (error) {
      console.error("Withdrawal request error:", error.message);

      return res.status(400).json({
        success: false,
        error: error.message || "Could not submit withdrawal."
      });
    }
  }
);

// ---------------- USER WITHDRAWAL HISTORY ----------------

app.get(
  "/withdrawal/my-requests",
  requireFirebase,
  authenticateUser,
  async (req, res) => {
    try {
      const snap = await db.collection("withdrawal_requests")
        .where("uid", "==", req.user.uid)
        .limit(100)
        .get();

      const requests = snap.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
        createdAt: dateValue(doc.data().createdAt)
      }));

      return res.json({ success: true, requests });
    } catch (error) {
      console.error("Withdrawal history error:", error.message);

      return res.status(500).json({
        success: false,
        error: "Could not load withdrawal history."
      });
    }
  }
);

// ---------------- ADMIN SUMMARY ----------------

app.get("/admin/summary", requireFirebase, adminOnly, async (req, res) => {
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

app.get("/admin/users", requireFirebase, adminOnly, async (req, res) => {
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
        giftCoinsReceived: data.giftCoinsReceived ?? 0,
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

app.post(
  "/admin/users/:uid/coins",
  requireFirebase,
  adminOnly,
  async (req, res) => {
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

      const balance = await db.runTransaction(async (tx) => {
        const snap = await tx.get(userRef);

        if (!snap.exists) {
          throw new Error("User profile not found.");
        }

        const oldCoins = snap.data().coins ?? 0;

        if (!Number.isSafeInteger(oldCoins) || oldCoins < 0) {
          throw new Error("Invalid current coin balance.");
        }

        const newBalance = oldCoins + amount;

        tx.update(userRef, { coins: newBalance });

        const logRef = db.collection("admin_logs").doc();

        tx.set(logRef, {
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
        error: error.message
      });
    }
  }
);

// ---------------- ADMIN RECHARGE LIST ----------------

app.get(
  "/admin/recharges",
  requireFirebase,
  adminOnly,
  async (req, res) => {
    try {
      const snap = await db.collection("recharge_requests")
        .limit(200)
        .get();

      const requests = snap.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
        createdAt: dateValue(doc.data().createdAt)
      }));

      return res.json({ success: true, requests });
    } catch (error) {
      console.error("Admin recharge list error:", error.message);

      return res.status(500).json({
        success: false,
        error: "Could not load recharge requests."
      });
    }
  }
);

// ---------------- ADMIN RECHARGE DECISION ----------------
// POST /admin/recharges/REQUEST_ID/decision
// Body: { "decision": "approve" } OR { "decision": "reject" }

app.post(
  "/admin/recharges/:id/decision",
  requireFirebase,
  adminOnly,
  async (req, res) => {
    try {
      const decision = String(req.body?.decision || "").toLowerCase();

      if (!["approve", "reject"].includes(decision)) {
        return res.status(400).json({
          success: false,
          error: "Decision must be approve or reject."
        });
      }

      const requestRef = db.collection("recharge_requests")
        .doc(req.params.id);

      await db.runTransaction(async (tx) => {
        const requestSnap = await tx.get(requestRef);

        if (!requestSnap.exists) {
          throw new Error("Recharge request not found.");
        }

        const request = requestSnap.data();

        if (request.status !== "pending") {
          throw new Error("This request has already been processed.");
        }

        const userRef = db.collection("users").doc(request.uid);
        const userSnap = await tx.get(userRef);

        if (!userSnap.exists) {
          throw new Error("User profile not found.");
        }

        if (decision === "approve") {
          const oldCoins = userSnap.data().coins ?? 0;

          if (
            !Number.isSafeInteger(oldCoins) ||
            oldCoins < 0 ||
            oldCoins + request.coins > Number.MAX_SAFE_INTEGER
          ) {
            throw new Error("Invalid user coin balance.");
          }

          tx.update(userRef, {
            coins: oldCoins + request.coins
          });
        }

        tx.update(requestRef, {
          status: decision === "approve" ? "approved" : "rejected",
          processedBy: req.user.uid,
          processedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        const logRef = db.collection("admin_logs").doc();

        tx.set(logRef, {
          action: `recharge_${decision}`,
          adminUid: req.user.uid,
          requestId: req.params.id,
          targetUid: request.uid,
          amount: request.amount,
          coins: request.coins,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });

      return res.json({
        success: true,
        message: `Recharge ${decision}d successfully.`
      });
    } catch (error) {
      console.error("Recharge decision error:", error.message);

      return res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }
);

// ---------------- ADMIN WITHDRAWAL LIST ----------------

app.get(
  "/admin/withdrawals",
  requireFirebase,
  adminOnly,
  async (req, res) => {
    try {
      const snap = await db.collection("withdrawal_requests")
        .limit(200)
        .get();

      const requests = snap.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
        createdAt: dateValue(doc.data().createdAt)
      }));

      return res.json({ success: true, requests });
    } catch (error) {
      console.error("Admin withdrawal list error:", error.message);

      return res.status(500).json({
        success: false,
        error: "Could not load withdrawal requests."
      });
    }
  }
);

// ---------------- ADMIN WITHDRAWAL DECISION ----------------
// POST /admin/withdrawals/REQUEST_ID/decision
// Body: { "decision": "approve" } OR { "decision": "reject" }

app.post(
  "/admin/withdrawals/:id/decision",
  requireFirebase,
  adminOnly,
  async (req, res) => {
    try {
      const decision = String(req.body?.decision || "").toLowerCase();

      if (!["approve", "reject"].includes(decision)) {
        return res.status(400).json({
          success: false,
          error: "Decision must be approve or reject."
        });
      }

      const requestRef = db.collection("withdrawal_requests")
        .doc(req.params.id);

      await db.runTransaction(async (tx) => {
        const requestSnap = await tx.get(requestRef);

        if (!requestSnap.exists) {
          throw new Error("Withdrawal request not found.");
        }

        const request = requestSnap.data();

        if (request.status !== "pending") {
          throw new Error("This request has already been processed.");
        }

        const userRef = db.collection("users").doc(request.uid);
        const userSnap = await tx.get(userRef);

        if (!userSnap.exists) {
          throw new Error("User profile not found.");
        }

        const data = userSnap.data();
        const diamonds = data.diamonds ?? 0;
        const reserved = data.withdrawalReservedDiamonds ?? 0;
        const withdrawn = data.withdrawnDiamonds ?? 0;

        if (
          !Number.isSafeInteger(diamonds) ||
          !Number.isSafeInteger(reserved) ||
          !Number.isSafeInteger(withdrawn) ||
          reserved < request.diamonds ||
          diamonds < request.diamonds
        ) {
          throw new Error("Invalid withdrawal wallet balance.");
        }

        if (decision === "approve") {
          tx.update(userRef, {
            diamonds: diamonds - request.diamonds,
            withdrawalReservedDiamonds: reserved - request.diamonds,
            withdrawnDiamonds: withdrawn + request.diamonds
          });
        } else {
          tx.update(userRef, {
            withdrawalReservedDiamonds: reserved - request.diamonds
          });
        }

        tx.update(requestRef, {
          status: decision === "approve" ? "approved" : "rejected",
          processedBy: req.user.uid,
          processedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        const logRef = db.collection("admin_logs").doc();

        tx.set(logRef, {
          action: `withdrawal_${decision}`,
          adminUid: req.user.uid,
          requestId: req.params.id,
          targetUid: request.uid,
          amount: request.amount,
          diamonds: request.diamonds,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });

      return res.json({
        success: true,
        message: `Withdrawal ${decision}d successfully.`
      });
    } catch (error) {
      console.error("Withdrawal decision error:", error.message);

      return res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }
);

// ---------------- ADMIN LIVE SESSIONS ----------------

app.get(
  "/admin/live-sessions",
  requireFirebase,
  adminOnly,
  async (req, res) => {
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
  }
);

// ---------------- ADMIN GIFT HISTORY ----------------

app.get(
  "/admin/gifts",
  requireFirebase,
  adminOnly,
  async (req, res) => {
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
  }
);

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
