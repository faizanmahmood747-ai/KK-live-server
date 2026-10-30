```javascript
import express from "express";
import { AccessToken } from "livekit-server-sdk";
import admin from "firebase-admin";

const app = express();

app.use(express.json({ limit: "8mb" }));

const PORT = process.env.PORT || 3000;

const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

const ADMIN_UID = process.env.ADMIN_UID;

const IMAGEKIT_PRIVATE_KEY = process.env.IMAGEKIT_PRIVATE_KEY;
const IMAGEKIT_PUBLIC_KEY = process.env.IMAGEKIT_PUBLIC_KEY;
const IMAGEKIT_URL_ENDPOINT = process.env.IMAGEKIT_URL_ENDPOINT;

let firebaseReady = false;

if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
        const serviceAccount = JSON.parse(
            process.env.FIREBASE_SERVICE_ACCOUNT_JSON
        );

        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        }

        firebaseReady = true;
        console.log("Firebase connected");
    } catch (error) {
        console.error("Firebase initialization failed:", error.message);
    }
}

const db = () => admin.firestore();

const GIFTS = [
    { id: "rose", name: "Rose", emoji: "🌹", coins: 50 },
    { id: "heart", name: "Heart", emoji: "❤️", coins: 200 },
    { id: "diamond", name: "Diamond", emoji: "💎", coins: 500 },
    { id: "crown", name: "Crown", emoji: "👑", coins: 1000 },
    { id: "rocket", name: "Rocket", emoji: "🚀", coins: 5000 },
    { id: "lion", name: "Lion", emoji: "🦁", coins: 10000 }
];

const RECHARGE_PACKAGES = {
    100: 4000,
    500: 20000,
    1000: 40000,
    2000: 80000,
    5000: 200000
};

const WITHDRAWAL_GIFT_COINS = 200000;
const WITHDRAWAL_DIAMONDS = 60000;
const WITHDRAWAL_AMOUNT = 1500;

function validText(value, max = 200) {
    return typeof value === "string" &&
        value.trim().length > 0 &&
        value.trim().length <= max;
}

function validUid(uid) {
    return typeof uid === "string" &&
        uid.length >= 10 &&
        uid.length <= 150;
}

async function requireFirebase(req, res, next) {
    try {
        if (!firebaseReady) {
            return res.status(503).json({
                success: false,
                message: "Firebase is not configured."
            });
        }

        const authorization = req.headers.authorization || "";

        if (!authorization.startsWith("Bearer ")) {
            return res.status(401).json({
                success: false,
                message: "Authentication required."
            });
        }

        const token = authorization.substring(7);

        const decoded = await admin.auth().verifyIdToken(token);

        req.user = decoded;

        next();

    } catch (error) {
        return res.status(401).json({
            success: false,
            message: "Invalid authentication."
        });
    }
}

function adminOnly(req, res, next) {
    if (!ADMIN_UID || req.user.uid !== ADMIN_UID) {
        return res.status(403).json({
            success: false,
            message: "Admin access denied."
        });
    }

    next();
}

app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "KK Live server is running.",
        firebaseReady,
        livekitConfigured: Boolean(
            LIVEKIT_URL &&
            LIVEKIT_API_KEY &&
            LIVEKIT_API_SECRET
        ),
        imagekitConfigured: Boolean(
            IMAGEKIT_PRIVATE_KEY &&
            IMAGEKIT_PUBLIC_KEY &&
            IMAGEKIT_URL_ENDPOINT
        )
    });
});

/* GIFTS */

app.get("/gifts", (req, res) => {
    res.json({
        success: true,
        gifts: GIFTS
    });
});

/* LIVEKIT TOKEN */

app.get("/token", async (req, res) => {
    try {
        const { room, identity } = req.query;

        if (!validText(room, 100) || !validText(identity, 100)) {
            return res.status(400).json({
                success: false,
                message: "room and identity are required"
            });
        }

        if (
            !LIVEKIT_URL ||
            !LIVEKIT_API_KEY ||
            !LIVEKIT_API_SECRET
        ) {
            return res.status(500).json({
                success: false,
                message: "LiveKit is not configured."
            });
        }

        const token = new AccessToken(
            LIVEKIT_API_KEY,
            LIVEKIT_API_SECRET,
            {
                identity: identity.trim(),
                ttl: "2h"
            }
        );

        token.addGrant({
            roomJoin: true,
            room: room.trim(),
            canPublish: true,
            canSubscribe: true
        });

        const jwt = await token.toJwt();

        res.json({
            success: true,
            token: jwt,
            url: LIVEKIT_URL,
            room: room.trim(),
            identity: identity.trim()
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Token generation failed."
        });
    }
});

/* IMAGEKIT SCREENSHOT UPLOAD */

app.post(
    "/upload/recharge-screenshot",
    requireFirebase,
    async (req, res) => {
        try {
            if (
                !IMAGEKIT_PRIVATE_KEY ||
                !IMAGEKIT_PUBLIC_KEY ||
                !IMAGEKIT_URL_ENDPOINT
            ) {
                return res.status(500).json({
                    success: false,
                    message: "ImageKit is not configured."
                });
            }

            const { file, fileName, mimeType } = req.body;

            if (
                typeof file !== "string" ||
                !validText(fileName, 150) ||
                typeof mimeType !== "string" ||
                !mimeType.startsWith("image/")
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid image data."
                });
            }

            const imageBuffer = Buffer.from(file, "base64");

            if (
                imageBuffer.length === 0 ||
                imageBuffer.length > 5 * 1024 * 1024
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Image must be under 5 MB."
                });
            }

            const allowedTypes = [
                "image/jpeg",
                "image/png",
                "image/webp"
            ];

            if (!allowedTypes.includes(mimeType)) {
                return res.status(400).json({
                    success: false,
                    message: "Only JPG, PNG and WEBP images are allowed."
                });
            }

            const form = new FormData();

            const blob = new Blob(
                [imageBuffer],
                { type: mimeType }
            );

            form.append("file", blob, fileName);
            form.append("fileName", fileName);
            form.append(
                "folder",
                `/kk-live/recharge-screenshots/${req.user.uid}`
            );

            const authorization = Buffer
                .from(`${IMAGEKIT_PRIVATE_KEY}:`)
                .toString("base64");

            const uploadResponse = await fetch(
                "https://upload.imagekit.io/api/v1/files/upload",
                {
                    method: "POST",
                    headers: {
                        Authorization: `Basic ${authorization}`
                    },
                    body: form
                }
            );

            const uploadResult = await uploadResponse.json();

            if (!uploadResponse.ok || !uploadResult.url) {
                console.error(
                    "ImageKit error:",
                    uploadResult.message || uploadResponse.status
                );

                return res.status(502).json({
                    success: false,
                    message: "ImageKit upload failed."
                });
            }

            return res.json({
                success: true,
                url: uploadResult.url,
                fileId: uploadResult.fileId
            });

        } catch (error) {
            console.error("Image upload error:", error.message);

            return res.status(500).json({
                success: false,
                message: "Screenshot upload failed."
            });
        }
    }
);

/* WALLET */

app.get("/wallet", requireFirebase, async (req, res) => {
    try {
        const snapshot = await db()
            .collection("users")
            .doc(req.user.uid)
            .get();

        const data = snapshot.data() || {};

        res.json({
            success: true,
            coins: data.coins || 0,
            diamonds: data.diamonds || 0,
            giftCoinsReceived: data.giftCoinsReceived || 0
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Wallet load failed."
        });
    }
});

/* SEND GIFT */

app.post("/gift", requireFirebase, async (req, res) => {
    try {
        const { hostUid, sessionId, giftId, quantity = 1 } = req.body;

        if (
            !validUid(hostUid) ||
            !validText(sessionId, 150) ||
            !Number.isInteger(quantity) ||
            quantity < 1 ||
            quantity > 100
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid gift request."
            });
        }

        const gift = GIFTS.find(item => item.id === giftId);

        if (!gift) {
            return res.status(400).json({
                success: false,
                message: "Gift not found."
            });
        }

        const senderUid = req.user.uid;

        if (senderUid === hostUid) {
            return res.status(400).json({
                success: false,
                message: "You cannot send gifts to yourself."
            });
        }

        const totalCoins = gift.coins * quantity;
        const earnedDiamonds = Math.floor(totalCoins * 0.30);

        await db().runTransaction(async transaction => {
            const senderRef = db().collection("users").doc(senderUid);
            const hostRef = db().collection("users").doc(hostUid);
            const sessionRef = db()
                .collection("live_sessions")
                .doc(sessionId);

            const senderSnap = await transaction.get(senderRef);
            const hostSnap = await transaction.get(hostRef);
            const sessionSnap = await transaction.get(sessionRef);

            if (!senderSnap.exists || !hostSnap.exists || !sessionSnap.exists) {
                throw new Error("User or live session not found.");
            }

            const senderCoins = senderSnap.get("coins") || 0;

            if (senderCoins < totalCoins) {
                throw new Error("Insufficient coins.");
            }

            transaction.update(senderRef, {
                coins: admin.firestore.FieldValue.increment(-totalCoins)
            });

            transaction.update(hostRef, {
                diamonds: admin.firestore.FieldValue.increment(earnedDiamonds),
                giftCoinsReceived: admin.firestore.FieldValue.increment(totalCoins)
            });

            const giftRef = sessionRef.collection("gifts").doc();

            transaction.set(giftRef, {
                senderUid,
                hostUid,
                giftId,
                giftName: gift.name,
                emoji: gift.emoji,
                quantity,
                coins: totalCoins,
                diamonds: earnedDiamonds,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        res.json({
            success: true,
            message: "Gift sent successfully.",
            coinsSpent: totalCoins,
            diamondsEarned: earnedDiamonds
        });

    } catch (error) {
        res.status(400).json({
            success: false,
            message: error.message || "Gift failed."
        });
    }
});

/* RECHARGE REQUEST */

app.post("/recharge/request", requireFirebase, async (req, res) => {
    try {
        const {
            amount,
            method,
            transactionReference,
            screenshotUrl
        } = req.body;

        const coins = RECHARGE_PACKAGES[Number(amount)];

        if (!coins) {
            return res.status(400).json({
                success: false,
                message: "Invalid recharge package."
            });
        }

        if (!["Easypaisa", "NBP"].includes(method)) {
            return res.status(400).json({
                success: false,
                message: "Invalid payment method."
            });
        }

        if (!validText(transactionReference, 150)) {
            return res.status(400).json({
                success: false,
                message: "Transaction reference is required."
            });
        }

        if (
            typeof screenshotUrl !== "string" ||
            !screenshotUrl.startsWith("https://") ||
            !screenshotUrl.startsWith(IMAGEKIT_URL_ENDPOINT)
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid screenshot URL."
            });
        }

        const userRef = db().collection("users").doc(req.user.uid);
        const userSnap = await userRef.get();

        if (!userSnap.exists) {
            return res.status(404).json({
                success: false,
                message: "User profile not found."
            });
        }

        const requestRef = db().collection("recharge_requests").doc();

        await requestRef.set({
            uid: req.user.uid,
            userName: userSnap.get("name") || "User",
            amount: Number(amount),
            coins,
            method,
            transactionReference: transactionReference.trim(),
            screenshotUrl,
            status: "pending",
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({
            success: true,
            message: "Recharge request submitted successfully.",
            requestId: requestRef.id
        });

    } catch (error) {
        console.error("Recharge request error:", error.message);

        res.status(500).json({
            success: false,
            message: "Recharge request failed."
        });
    }
});

app.get("/recharge/my-requests", requireFirebase, async (req, res) => {
    try {
        const snapshot = await db()
            .collection("recharge_requests")
            .where("uid", "==", req.user.uid)
            .limit(50)
            .get();

        res.json({
            success: true,
            requests: snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }))
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Could not load recharge requests."
        });
    }
});

/* WITHDRAWAL REQUEST */

app.post("/withdrawal/request", requireFirebase, async (req, res) => {
    try {
        const {
            method,
            accountTitle,
            accountNumber,
            bankName
        } = req.body;

        if (!["Easypaisa", "JazzCash", "Bank"].includes(method)) {
            return res.status(400).json({
                success: false,
                message: "Invalid withdrawal method."
            });
        }

        if (
            !validText(accountTitle, 150) ||
            !validText(accountNumber, 100)
        ) {
            return res.status(400).json({
                success: false,
                message: "Account details are required."
            });
        }

        if (method === "Bank" && !validText(bankName, 100)) {
            return res.status(400).json({
                success: false,
                message: "Bank name is required."
            });
        }

        const uid = req.user.uid;

        await db().runTransaction(async transaction => {
            const userRef = db().collection("users").doc(uid);
            const userSnap = await transaction.get(userRef);

            if (!userSnap.exists) {
                throw new Error("User not found.");
            }

            const giftCoins = userSnap.get("giftCoinsReceived") || 0;
            const diamonds = userSnap.get("diamonds") || 0;

            if (giftCoins < WITHDRAWAL_GIFT_COINS) {
                throw new Error("You need 200,000 gift coins to unlock withdrawal.");
            }

            if (diamonds < WITHDRAWAL_DIAMONDS) {
                throw new Error("You need 60,000 diamonds.");
            }

            transaction.update(userRef, {
                diamonds: admin.firestore.FieldValue.increment(-WITHDRAWAL_DIAMONDS),
                reservedDiamonds: admin.firestore.FieldValue.increment(WITHDRAWAL_DIAMONDS)
            });

            const requestRef = db().collection("withdrawal_requests").doc();

            transaction.set(requestRef, {
                uid,
                userName: userSnap.get("name") || "User",
                method,
                accountTitle: accountTitle.trim(),
                accountNumber: accountNumber.trim(),
                bankName: method === "Bank" ? bankName.trim() : "",
                diamonds: WITHDRAWAL_DIAMONDS,
                amount: WITHDRAWAL_AMOUNT,
                status: "pending",
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        res.json({
            success: true,
            message: "Withdrawal request submitted."
        });

    } catch (error) {
        res.status(400).json({
            success: false,
            message: error.message || "Withdrawal failed."
        });
    }
});

app.get("/withdrawal/my-requests", requireFirebase, async (req, res) => {
    try {
        const snapshot = await db()
            .collection("withdrawal_requests")
            .where("uid", "==", req.user.uid)
            .limit(50)
            .get();

        res.json({
            success: true,
            requests: snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }))
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Could not load withdrawal requests."
        });
    }
});

/* ADMIN SUMMARY */

app.get("/admin/summary", requireFirebase, adminOnly, async (req, res) => {
    try {
        const [users, recharges, withdrawals, sessions] = await Promise.all([
            db().collection("users").count().get(),
            db().collection("recharge_requests").where("status", "==", "pending").count().get(),
            db().collection("withdrawal_requests").where("status", "==", "pending").count().get(),
            db().collection("live_sessions").count().get()
        ]);

        res.json({
            success: true,
            users: users.data().count,
            pendingRecharges: recharges.data().count,
            pendingWithdrawals: withdrawals.data().count,
            liveSessions: sessions.data().count
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Admin summary failed."
        });
    }
});

/* ADMIN USERS */

app.get("/admin/users", requireFirebase, adminOnly, async (req, res) => {
    try {
        const snapshot = await db()
            .collection("users")
            .limit(200)
            .get();

        res.json({
            success: true,
            users: snapshot.docs.map(doc => ({
                uid: doc.id,
                ...doc.data()
            }))
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Could not load users."
        });
    }
});

app.post("/admin/users/:uid/coins", requireFirebase, adminOnly, async (req, res) => {
    try {
        const { coins } = req.body;
        const amount = Number(coins);

        if (
            !validUid(req.params.uid) ||
            !Number.isSafeInteger(amount) ||
            amount < 0 ||
            amount > 100000000
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid coin amount."
            });
        }

        await db().collection("users")
            .doc(req.params.uid)
            .set({
                coins: amount
            }, { merge: true });

        res.json({
            success: true,
            message: "User coins updated."
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Coin update failed."
        });
    }
});

/* ADMIN RECHARGES */

app.get("/admin/recharges", requireFirebase, adminOnly, async (req, res) => {
    try {
        const snapshot = await db()
            .collection("recharge_requests")
            .orderBy("createdAt", "desc")
            .limit(200)
            .get();

        res.json({
            success: true,
            requests: snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }))
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Could not load recharge requests."
        });
    }
});

app.post("/admin/recharges/:id/decision", requireFirebase, adminOnly, async (req, res) => {
    try {
        const { decision } = req.body;

        if (!["approve", "reject"].includes(decision)) {
            return res.status(400).json({
                success: false,
                message: "Invalid decision."
            });
        }

        await db().runTransaction(async transaction => {
            const requestRef = db()
                .collection("recharge_requests")
                .doc(req.params.id);

            const requestSnap = await transaction.get(requestRef);

            if (!requestSnap.exists) {
                throw new Error("Recharge request not found.");
            }

            if (requestSnap.get("status") !== "pending") {
                throw new Error("Request already processed.");
            }

            const data = requestSnap.data();

            if (decision === "approve") {
                const userRef = db().collection("users").doc(data.uid);

                transaction.set(userRef, {
                    coins: admin.firestore.FieldValue.increment(data.coins)
                }, { merge: true });
            }

            transaction.update(requestRef, {
                status: decision === "approve" ? "approved" : "rejected",
                reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
                reviewedBy: req.user.uid
            });

            const logRef = db().collection("admin_logs").doc();

            transaction.set(logRef, {
                adminUid: req.user.uid,
                action: `recharge_${decision}`,
                requestId: req.params.id,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        res.json({
            success: true,
            message: `Recharge ${decision}d successfully.`
        });

    } catch (error) {
        res.status(400).json({
            success: false,
            message: error.message
        });
    }
});

/* ADMIN WITHDRAWALS */

app.get("/admin/withdrawals", requireFirebase, adminOnly, async (req, res) => {
    try {
        const snapshot = await db()
            .collection("withdrawal_requests")
            .orderBy("createdAt", "desc")
            .limit(200)
            .get();

        res.json({
            success: true,
            requests: snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }))
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Could not load withdrawals."
        });
    }
});

app.post("/admin/withdrawals/:id/decision", requireFirebase, adminOnly, async (req, res) => {
    try {
        const { decision } = req.body;

        if (!["approve", "reject"].includes(decision)) {
            return res.status(400).json({
                success: false,
                message: "Invalid decision."
            });
        }

        await db().runTransaction(async transaction => {
            const requestRef = db()
                .collection("withdrawal_requests")
                .doc(req.params.id);

            const requestSnap = await transaction.get(requestRef);

            if (!requestSnap.exists) {
                throw new Error("Withdrawal request not found.");
            }

            if (requestSnap.get("status") !== "pending") {
                throw new Error("Request already processed.");
            }

            const data = requestSnap.data();

            const userRef = db().collection("users").doc(data.uid);

            if (decision === "reject") {
                transaction.set(userRef, {
                    diamonds: admin.firestore.FieldValue.increment(data.diamonds),
                    reservedDiamonds: admin.firestore.FieldValue.increment(-data.diamonds)
                }, { merge: true });
            } else {
                transaction.set(userRef, {
                    reservedDiamonds: admin.firestore.FieldValue.increment(-data.diamonds),
                    withdrawnDiamonds: admin.firestore.FieldValue.increment(data.diamonds)
                }, { merge: true });
            }

            transaction.update(requestRef, {
                status: decision === "approve" ? "approved" : "rejected",
                reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
                reviewedBy: req.user.uid
            });

            const logRef = db().collection("admin_logs").doc();

            transaction.set(logRef, {
                adminUid: req.user.uid,
                action: `withdrawal_${decision}`,
                requestId: req.params.id,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        res.json({
            success: true,
            message: `Withdrawal ${decision}d successfully.`
        });

    } catch (error) {
        res.status(400).json({
            success: false,
            message: error.message
        });
    }
});

/* ADMIN LIVE SESSIONS */

app.get("/admin/live-sessions", requireFirebase, adminOnly, async (req, res) => {
    try {
        const snapshot = await db()
            .collection("live_sessions")
            .limit(200)
            .get();

        res.json({
            success: true,
            sessions: snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }))
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Could not load live sessions."
        });
    }
});

/* ADMIN GIFTS */

app.get("/admin/gifts", requireFirebase, adminOnly, async (req, res) => {
    try {
        const sessions = await db()
            .collection("live_sessions")
            .limit(100)
            .get();

        const gifts = [];

        for (const session of sessions.docs) {
            const snapshot = await session.ref
                .collection("gifts")
                .limit(100)
                .get();

            snapshot.docs.forEach(doc => {
                gifts.push({
                    id: doc.id,
                    sessionId: session.id,
                    ...doc.data()
                });
            });
        }

        res.json({
            success: true,
            gifts
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Could not load gifts."
        });
    }
});

/* UNKNOWN ROUTE */

app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: "Route not found."
    });
});

/* ERROR HANDLER */

app.use((error, req, res, next) => {
    console.error("Server error:", error.message);

    res.status(500).json({
        success: false,
        message: "Internal server error."
    });
});

export default app;
```
