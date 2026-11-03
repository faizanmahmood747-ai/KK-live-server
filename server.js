import express from "express";
import { AccessToken } from "livekit-server-sdk";
import admin from "firebase-admin";

const app = express();
app.use((req, res, next) => {
    res.setHeader("X-KK-Server", "KK-LIVE-RECHARGE-CHECK-1");
    console.log("KK LIVE REQUEST:", req.method, req.originalUrl);
    next();
});
app.use(express.json({ limit: "8mb" }));

// =====================================
// ENVIRONMENT VARIABLES
// =====================================

const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

const ADMIN_UID = process.env.ADMIN_UID;

const IMAGEKIT_PUBLIC_KEY = process.env.IMAGEKIT_PUBLIC_KEY;
const IMAGEKIT_PRIVATE_KEY = process.env.IMAGEKIT_PRIVATE_KEY?.trim();
const IMAGEKIT_URL_ENDPOINT = process.env.IMAGEKIT_URL_ENDPOINT;

// =====================================
// FIREBASE INITIALIZATION
// =====================================

let firebaseReady = false;

try {
    if (!admin.apps.length) {
        const serviceAccount = JSON.parse(
            process.env.FIREBASE_SERVICE_ACCOUNT_JSON
        );

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    }

    firebaseReady = true;
    console.log("Firebase initialized successfully.");
} catch (error) {
    console.error("Firebase initialization error:", error.message);
}

const db = firebaseReady ? admin.firestore() : null;

// =====================================
// GIFTS
// =====================================

const GIFTS = [
    { id: "rose", name: "Rose", price: 50, emoji: "🌹" },
    { id: "heart", name: "Heart", price: 200, emoji: "❤️" },
    { id: "diamond", name: "Diamond", price: 500, emoji: "💎" },
    { id: "crown", name: "Crown", price: 1000, emoji: "👑" },
    { id: "rocket", name: "Rocket", price: 5000, emoji: "🚀" },
    { id: "lion", name: "Lion", price: 10000, emoji: "🦁" }
];

// =====================================
// RECHARGE PACKAGES
// =====================================

const RECHARGE_PACKAGES = {
    100: 4000,
    500: 20000,
    1000: 40000,
    2000: 80000,
    5000: 200000
};

// =====================================
// VIP PLANS
// =====================================

const VIP_PLANS = {
    1: { level: 1, name: "VIP 1", price: 10000 },
    2: { level: 2, name: "VIP 2", price: 40000 },
    3: { level: 3, name: "VIP 3", price: 100000 },
    4: { level: 4, name: "VIP 4", price: 160000 },
    5: { level: 5, name: "VIP 5", price: 230000 },
    6: { level: 6, name: "VIP 6", price: 310000 },
    7: { level: 7, name: "VIP 7", price: 400000 },
    8: { level: 8, name: "VIP 8", price: 500000 },
    9: { level: 9, name: "VIP 9", price: 610000 },
    10: { level: 10, name: "VIP 10", price: 730000 },
    11: { level: 11, name: "VIP 11", price: 860000 },
    12: { level: 12, name: "VIP 12", price: 1000000 }
};

// =====================================
// WITHDRAWAL SETTINGS
// =====================================

const WITHDRAWAL_GIFT_COINS = 200000;
const WITHDRAWAL_DIAMONDS = 60000;
const WITHDRAWAL_AMOUNT = 1500;

// =====================================
// HELPERS
// =====================================

function validText(value, maxLength = 200) {
    return typeof value === "string" &&
        value.trim().length > 0 &&
        value.trim().length <= maxLength;
}

function validUid(value) {
    return typeof value === "string" &&
        value.length >= 5 &&
        value.length <= 150;
}

function dateValue() {
    return admin.firestore.FieldValue.serverTimestamp();
}

function sendError(res, status, message) {
    return res.status(status).json({
        success: false,
        message
    });
}

// =====================================
// AUTHENTICATION
// =====================================

async function authenticateUser(req, res, next) {
    try {
        if (!firebaseReady) {
            return sendError(res, 500, "Firebase is not configured.");
        }

        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return sendError(res, 401, "Authentication token required.");
        }

        const token = authHeader.substring(7);
        req.user = await admin.auth().verifyIdToken(token);

        next();
    } catch (error) {
        console.error("Authentication error:", error.message);
        return sendError(res, 401, "Invalid or expired login token.");
    }
}

function requireFirebase(req, res, next) {
    if (!firebaseReady) {
        return sendError(res, 500, "Firebase is not configured.");
    }

    next();
}

function adminOnly(req, res, next) {
    if (!ADMIN_UID || req.user.uid !== ADMIN_UID) {
        return sendError(res, 403, "Admin access denied.");
    }

    next();
}

// =====================================
// IMAGEKIT SCREENSHOT UPLOAD
// =====================================

app.post(
    "/upload/recharge-screenshot",
    authenticateUser,
    async (req, res) => {
        try {
            if (
                !IMAGEKIT_PUBLIC_KEY ||
                !IMAGEKIT_PRIVATE_KEY ||
                !IMAGEKIT_URL_ENDPOINT
            ) {
                return sendError(res, 500, "ImageKit environment variables are missing.");
            }

            const { file, fileName, mimeType } = req.body || {};

            if (!file || !fileName || !mimeType) {
                return sendError(res, 400, "Image file, file name and image type are required.");
            }

            if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType)) {
                return sendError(res, 400, "Only JPG, PNG and WEBP images are allowed.");
            }

            const base64Data = file.replace(
                /^data:image\/[a-zA-Z0-9.+-]+;base64,/,
                ""
            );

            const imageBuffer = Buffer.from(base64Data, "base64");

            if (
                imageBuffer.length === 0 ||
                imageBuffer.length > 3 * 1024 * 1024
            ) {
                return sendError(res, 400, "Image must be smaller than 3 MB.");
            }

            const formData = new FormData();

            formData.append(
                "file",
                new Blob([imageBuffer], { type: mimeType }),
                fileName
            );

            formData.append("fileName", `KKLive_${Date.now()}_${fileName}`);
            formData.append("folder", "/KKLive/RechargeScreenshots");

            const credentials = Buffer.from(
                `${IMAGEKIT_PRIVATE_KEY}:`
            ).toString("base64");

            const response = await fetch(
                "https://upload.imagekit.io/api/v1/files/upload",
                {
                    method: "POST",
                    headers: {
                        Authorization: `Basic ${credentials}`
                    },
                    body: formData
                }
            );

            const responseText = await response.text();
            let data;

            try {
                data = JSON.parse(responseText);
            } catch {
                return sendError(res, 502, "ImageKit returned an invalid response.");
            }

            if (!response.ok) {
                return sendError(
                    res,
                    502,
                    data.message || data.help || "ImageKit upload failed."
                );
            }

            if (!data.url) {
                return sendError(res, 502, "Image URL was not returned.");
            }

            return res.json({
                success: true,
                message: "Screenshot uploaded successfully.",
                url: data.url,
                fileId: data.fileId || null
            });
        } catch (error) {
            console.error("Screenshot upload error:", error);
            return sendError(res, 500, "Screenshot upload failed.");
        }
    }
);

// =====================================
// SERVER HEALTH CHECK
// =====================================

app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "KK Live server is running.",
        firebaseReady,
        livekitConfigured: Boolean(
            LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET
        ),
        imagekitConfigured: Boolean(
            IMAGEKIT_PUBLIC_KEY &&
            IMAGEKIT_PRIVATE_KEY &&
            IMAGEKIT_URL_ENDPOINT
        )
    });
});

// =====================================
// GET GIFTS
// =====================================

app.get("/gifts", (req, res) => {
    res.json({ success: true, gifts: GIFTS });
});

// =====================================
// LIVEKIT TOKEN
// =====================================

app.get("/token", async (req, res) => {
    try {
        if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
            return sendError(res, 500, "LiveKit is not configured.");
        }

        const { room, identity } = req.query;

        if (!validText(room, 100) || !validText(identity, 150)) {
            return sendError(res, 400, "room and identity are required.");
        }

        const token = new AccessToken(
            LIVEKIT_API_KEY,
            LIVEKIT_API_SECRET,
            {
                identity: identity.trim(),
                ttl: "6h"
            }
        );

        token.addGrant({
            roomJoin: true,
            room: room.trim(),
            canPublish: true,
            canSubscribe: true,
            canPublishData: true
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
        console.error("LiveKit token error:", error);
        return sendError(res, 500, "Unable to create LiveKit token.");
    }
});

// =====================================
// VIP PLANS
// =====================================

app.get(
    "/vip/plans",
    authenticateUser,
    requireFirebase,
    async (req, res) => {
        try {
            const uid = req.user.uid;

            const [userDoc, walletDoc] = await Promise.all([
                db.collection("users").doc(uid).get(),
                db.collection("wallets").doc(uid).get()
            ]);

            const userData = userDoc.exists ? userDoc.data() : {};
            const walletData = walletDoc.exists ? walletDoc.data() : {};

            res.json({
                success: true,
                plans: Object.values(VIP_PLANS),
                vipLevel: Math.max(
                    Number(userData.vipLevel || 0),
                    Number(walletData.vipLevel || 0)
                ),
                vipLifetime: Boolean(
                    userData.vipLifetime || walletData.vipLifetime
                ),
                coins: Number(walletData.coins ?? userData.coins ?? 0)
            });
        } catch (error) {
            console.error("VIP plans error:", error);
            return sendError(res, 500, "Unable to load VIP plans.");
        }
    }
);

// =====================================
// VIP PURCHASE
// =====================================

app.post(
    "/vip/purchase",
    authenticateUser,
    requireFirebase,
    async (req, res) => {
        try {
            const uid = req.user.uid;
            const level = Number(req.body?.level);

            if (!Number.isInteger(level) || !VIP_PLANS[level]) {
                return sendError(res, 400, "Invalid VIP level.");
            }

            const plan = VIP_PLANS[level];
            const userRef = db.collection("users").doc(uid);
            const walletRef = db.collection("wallets").doc(uid);
            const logRef = db.collection("admin_logs").doc();

            let updatedCoins = 0;

            await db.runTransaction(async transaction => {
                const [userDoc, walletDoc] = await Promise.all([
                    transaction.get(userRef),
                    transaction.get(walletRef)
                ]);

                const user = userDoc.exists ? userDoc.data() : {};
                const wallet = walletDoc.exists ? walletDoc.data() : {};

                const currentVip = Math.max(
                    Number(user.vipLevel || 0),
                    Number(wallet.vipLevel || 0)
                );

                if (level <= currentVip) {
                    throw new Error("VIP_ALREADY_OWNED");
                }

                const coins = Number(wallet.coins ?? user.coins ?? 0);

                if (!Number.isSafeInteger(coins) || coins < 0) {
                    throw new Error("INVALID_WALLET_BALANCE");
                }

                if (coins < plan.price) {
                    throw new Error("INSUFFICIENT_COINS");
                }

                updatedCoins = coins - plan.price;

                const vipData = {
                    vipLevel: plan.level,
                    vipName: plan.name,
                    vipLifetime: true,
                    vipPurchasePrice: plan.price,
                    vipPurchasedAt: dateValue(),
                    updatedAt: dateValue()
                };

                transaction.set(
                    walletRef,
                    { coins: updatedCoins, ...vipData },
                    { merge: true }
                );

                transaction.set(
                    userRef,
                    { coins: updatedCoins, ...vipData },
                    { merge: true }
                );

                transaction.set(logRef, {
                    type: "vip_purchase",
                    uid,
                    vipLevel: plan.level,
                    vipName: plan.name,
                    coinsSpent: plan.price,
                    createdAt: dateValue()
                });
            });

            return res.json({
                success: true,
                message: `${plan.name} purchased successfully.`,
                vipLevel: plan.level,
                vipName: plan.name,
                vipLifetime: true,
                coinsSpent: plan.price,
                coins: updatedCoins
            });
        } catch (error) {
            console.error("VIP purchase error:", error);

            if (error.message === "VIP_ALREADY_OWNED") {
                return sendError(res, 400, "You already own this VIP level or a higher level.");
            }

            if (error.message === "INSUFFICIENT_COINS") {
                return sendError(res, 400, "Not enough coins.");
            }

            if (error.message === "INVALID_WALLET_BALANCE") {
                return sendError(res, 400, "Your wallet balance is invalid.");
            }

            return sendError(res, 500, "Unable to purchase VIP.");
        }
    }
);

// =====================================
// GET WALLET
// =====================================

app.get(
    "/wallet",
    authenticateUser,
    requireFirebase,
    async (req, res) => {
        try {
            const uid = req.user.uid;

            const [userDoc, walletDoc] = await Promise.all([
                db.collection("users").doc(uid).get(),
                db.collection("wallets").doc(uid).get()
            ]);

            const user = userDoc.exists ? userDoc.data() : {};
            const wallet = walletDoc.exists ? walletDoc.data() : {};

            res.json({
                success: true,
                coins: Number(wallet.coins ?? user.coins ?? 0),
                diamonds: Number(wallet.diamonds ?? user.diamonds ?? 0),
                giftCoinsReceived: Number(
                    wallet.giftCoinsReceived ?? user.giftCoinsReceived ?? 0
                ),
                vipLevel: Math.max(
                    Number(user.vipLevel || 0),
                    Number(wallet.vipLevel || 0)
                )
            });
        } catch (error) {
            console.error("Wallet error:", error);
            return sendError(res, 500, "Unable to load wallet.");
        }
    }
);

// =====================================
// SEND GIFT
// =====================================

app.post(
    "/gift",
    authenticateUser,
    requireFirebase,
    async (req, res) => {
        try {
            const senderUid = req.user.uid;
            const { hostUid, sessionId, giftId, quantity = 1 } = req.body || {};

            if (
                !validUid(hostUid) ||
                !validText(giftId, 50) ||
                !Number.isInteger(quantity) ||
                quantity < 1 ||
                quantity > 100
            ) {
                return sendError(res, 400, "Invalid gift details.");
            }

            const gift = GIFTS.find(item => item.id === giftId);

            if (!gift) {
                return sendError(res, 404, "Gift not found.");
            }

            if (senderUid === hostUid) {
                return sendError(res, 400, "You cannot send gifts to yourself.");
            }

            const totalCoins = gift.price * quantity;

            const senderWallet = db.collection("wallets").doc(senderUid);
            const hostWallet = db.collection("wallets").doc(hostUid);
            const giftLog = db.collection("admin_logs").doc();

            await db.runTransaction(async transaction => {
                const [senderDoc, hostDoc] = await Promise.all([
                    transaction.get(senderWallet),
                    transaction.get(hostWallet)
                ]);

                const sender = senderDoc.exists ? senderDoc.data() : {};
                const host = hostDoc.exists ? hostDoc.data() : {};

                const currentCoins = Number(sender.coins || 0);

                if (currentCoins < totalCoins) {
                    throw new Error("INSUFFICIENT_COINS");
                }

                const earnedDiamonds = Math.floor(totalCoins * 0.30);

                transaction.set(
                    senderWallet,
                    {
                        coins: currentCoins - totalCoins,
                        updatedAt: dateValue()
                    },
                    { merge: true }
                );

                transaction.set(
                    hostWallet,
                    {
                        giftCoinsReceived:
                            Number(host.giftCoinsReceived || 0) + totalCoins,
                        diamonds:
                            Number(host.diamonds || 0) + earnedDiamonds,
                        updatedAt: dateValue()
                    },
                    { merge: true }
                );

                transaction.set(giftLog, {
                    type: "gift",
                    senderUid,
                    hostUid,
                    giftId,
                    giftName: gift.name,
                    giftEmoji: gift.emoji,
                    quantity,
                    coins: totalCoins,
                    diamonds: earnedDiamonds,
                    sessionId: sessionId || null,
                    createdAt: dateValue()
                });
            });

            res.json({
                success: true,
                message: "Gift sent successfully.",
                coinsSpent: totalCoins,
                diamondsEarned: Math.floor(totalCoins * 0.30)
            });
        } catch (error) {
            console.error("Gift error:", error);

            if (error.message === "INSUFFICIENT_COINS") {
                return sendError(res, 400, "Insufficient coins.");
            }

            return sendError(res, 500, "Unable to send gift.");
        }
    }
);

// =====================================
// RECHARGE REQUEST
// =====================================

app.post(
    "/recharge/request",
    authenticateUser,
    requireFirebase,
    async (req, res) => {
        try {
            const uid = req.user.uid;

            const {
                amount,
                paymentMethod,
                transactionReference,
                screenshotUrl
            } = req.body || {};

            const coins = RECHARGE_PACKAGES[Number(amount)];

            if (!coins) {
                return sendError(res, 400, "Invalid recharge package.");
            }

            if (!validText(paymentMethod, 50)) {
                return sendError(res, 400, "Payment method is required.");
            }

            if (!validText(transactionReference, 150)) {
                return sendError(res, 400, "Transaction reference is required.");
            }

            if (
                !validText(screenshotUrl, 1000) ||
                !screenshotUrl.startsWith(
                    IMAGEKIT_URL_ENDPOINT || "https://ik.imagekit.io/"
                )
            ) {
                return sendError(res, 400, "Valid ImageKit screenshot URL is required.");
            }

            const requestRef = await db.collection("recharge_requests").add({
                uid,
                amount: Number(amount),
                coins,
                paymentMethod: paymentMethod.trim(),
                transactionReference: transactionReference.trim(),
                screenshotUrl,
                status: "pending",
                createdAt: dateValue()
            });

            res.json({
                success: true,
                message: "Recharge request submitted. Waiting for admin approval.",
                requestId: requestRef.id,
                coins
            });
        } catch (error) {
            console.error("Recharge request error:", error);
            return sendError(res, 500, "Unable to submit recharge request.");
        }
    }
);

// =====================================
// MY RECHARGE REQUESTS
// =====================================

app.get(
    "/recharge/my-requests",
    authenticateUser,
    requireFirebase,
    async (req, res) => {
        try {
            const snapshot = await db
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
            console.error("My recharge requests error:", error);
            return sendError(res, 500, "Unable to load recharge requests.");
        }
    }
);

// =====================================
// WITHDRAWAL REQUEST
// =====================================

app.post(
    "/withdrawal/request",
    authenticateUser,
    requireFirebase,
    async (req, res) => {
        try {
            const uid = req.user.uid;

            const {
                withdrawalMethod,
                accountTitle,
                accountNumber,
                bankName
            } = req.body || {};

            if (
                !validText(withdrawalMethod, 50) ||
                !validText(accountTitle, 100) ||
                !validText(accountNumber, 100)
            ) {
                return sendError(res, 400, "Complete withdrawal details are required.");
            }

            const walletRef = db.collection("wallets").doc(uid);
            const walletDoc = await walletRef.get();
            const wallet = walletDoc.exists ? walletDoc.data() : {};

            if (Number(wallet.giftCoinsReceived || 0) < WITHDRAWAL_GIFT_COINS) {
                return sendError(
                    res,
                    400,
                    "You need 200,000 gift coins to unlock withdrawal."
                );
            }

            if (Number(wallet.diamonds || 0) < WITHDRAWAL_DIAMONDS) {
                return sendError(
                    res,
                    400,
                    "You need at least 60,000 diamonds to withdraw."
                );
            }

            const requestRef = await db.collection("withdrawal_requests").add({
                uid,
                withdrawalMethod: withdrawalMethod.trim(),
                accountTitle: accountTitle.trim(),
                accountNumber: accountNumber.trim(),
                bankName: typeof bankName === "string" ? bankName.trim() : "",
                diamonds: WITHDRAWAL_DIAMONDS,
                amount: WITHDRAWAL_AMOUNT,
                status: "pending",
                createdAt: dateValue()
            });

            res.json({
                success: true,
                message: "Withdrawal request submitted.",
                requestId: requestRef.id
            });
        } catch (error) {
            console.error("Withdrawal request error:", error);
            return sendError(res, 500, "Unable to submit withdrawal request.");
        }
    }
);

// =====================================
// MY WITHDRAWAL REQUESTS
// =====================================

app.get(
    "/withdrawal/my-requests",
    authenticateUser,
    requireFirebase,
    async (req, res) => {
        try {
            const snapshot = await db
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
            console.error("My withdrawal requests error:", error);
            return sendError(res, 500, "Unable to load withdrawal requests.");
        }
    }
);

// // =====================================
// ADMIN SUMMARY
// =====================================

app.get(
    "/admin/summary",
    authenticateUser,
    requireFirebase,
    adminOnly,
    async (req, res) => {
        try {
            const [
                usersSnapshot,
                walletsSnapshot,
                rechargeSnapshot,
                withdrawalSnapshot,
                sessionsSnapshot
            ] = await Promise.all([
                db.collection("users").get(),
                db.collection("wallets").get(),
                db.collection("recharge_requests").get(),
                db.collection("withdrawal_requests").get(),
                db.collection("live_sessions").get()
            ]);

            let totalCoins = 0;
            let totalDiamonds = 0;
            let totalGiftCoinsReceived = 0;

            walletsSnapshot.docs.forEach(doc => {
                const wallet = doc.data();

                totalCoins += Number(wallet.coins || 0);
                totalDiamonds += Number(wallet.diamonds || 0);
                totalGiftCoinsReceived += Number(
                    wallet.giftCoinsReceived || 0
                );
            });

            res.json({
                success: true,
                totalUsers: usersSnapshot.size,
                totalCoins,
                totalDiamonds,
                totalGiftCoinsReceived,
                totalRechargeRequests: rechargeSnapshot.size,
                totalWithdrawalRequests: withdrawalSnapshot.size,
                totalLiveSessions: sessionsSnapshot.size
            });

        } catch (error) {
            console.error("Admin summary error:", error);
            return sendError(res, 500, "Unable to load admin summary.");
        }
    }
);

// =====================================
// ADMIN USERS
// =====================================

app.get(
    "/admin/users",
    authenticateUser,
    requireFirebase,
    adminOnly,
    async (req, res) => {
        try {
            const usersSnapshot = await db
                .collection("users")
                .limit(200)
                .get();

            const users = await Promise.all(
                usersSnapshot.docs.map(async doc => {
                    const walletDoc = await db
                        .collection("wallets")
                        .doc(doc.id)
                        .get();

                    const user = doc.data();
                    const wallet = walletDoc.exists
                        ? walletDoc.data()
                        : {};

                    return {
                        uid: doc.id,
                        ...user,
                        coins: Number(
                            wallet.coins ?? user.coins ?? 0
                        ),
                        diamonds: Number(
                            wallet.diamonds ?? user.diamonds ?? 0
                        ),
                        giftCoinsReceived: Number(
                            wallet.giftCoinsReceived ??
                            user.giftCoinsReceived ??
                            0
                        )
                    };
                })
            );

            res.json({
                success: true,
                users
            });

        } catch (error) {
            console.error("Admin users error:", error);
            return sendError(res, 500, "Unable to load users.");
        }
    }
);

// =====================================
// ADMIN ADD COINS
// =====================================

app.post(
    "/admin/users/:uid/coins",
    authenticateUser,
    requireFirebase,
    adminOnly,
    async (req, res) => {
        try {
            const uid = req.params.uid;

            // Supports both "coins" and "amount"
            const coinsToAdd = Number(
                req.body?.coins ?? req.body?.amount
            );

            if (
                !validUid(uid) ||
                !Number.isSafeInteger(coinsToAdd) ||
                coinsToAdd <= 0
            ) {
                return sendError(
                    res,
                    400,
                    "Invalid user or coin amount."
                );
            }

            const userRef = db.collection("users").doc(uid);
            const walletRef = db.collection("wallets").doc(uid);

            let updatedCoins = 0;

            await db.runTransaction(async transaction => {
                const [userDoc, walletDoc] = await Promise.all([
                    transaction.get(userRef),
                    transaction.get(walletRef)
                ]);

                const user = userDoc.exists ? userDoc.data() : {};
                const wallet = walletDoc.exists ? walletDoc.data() : {};

                const currentCoins = Number(
                    wallet.coins ?? user.coins ?? 0
                );

                if (
                    !Number.isSafeInteger(currentCoins) ||
                    currentCoins < 0 ||
                    currentCoins + coinsToAdd > Number.MAX_SAFE_INTEGER
                ) {
                    throw new Error("INVALID_WALLET_BALANCE");
                }

                updatedCoins = currentCoins + coinsToAdd;

                transaction.set(
                    walletRef,
                    {
                        coins: updatedCoins,
                        updatedAt: dateValue()
                    },
                    { merge: true }
                );

                transaction.set(
                    userRef,
                    {
                        coins: updatedCoins,
                        updatedAt: dateValue()
                    },
                    { merge: true }
                );

                transaction.set(
                    db.collection("admin_logs").doc(),
                    {
                        type: "admin_add_coins",
                        uid,
                        coinsAdded: coinsToAdd,
                        adminUid: req.user.uid,
                        createdAt: dateValue()
                    }
                );
            });

            res.json({
                success: true,
                message: "Coins added successfully.",
                coinsAdded: coinsToAdd,
                totalCoins: updatedCoins
            });

        } catch (error) {
            console.error("Admin add coins error:", error);

            if (error.message === "INVALID_WALLET_BALANCE") {
                return sendError(res, 400, "Invalid wallet balance.");
            }

            return sendError(res, 500, "Unable to add coins.");
        }
    }
);

// =====================================
// ADMIN RECHARGES
// =====================================

app.get(
    "/admin/recharges",
    authenticateUser,
    requireFirebase,
    adminOnly,
    async (req, res) => {
        try {
            const snapshot = await db
                .collection("recharge_requests")
                .limit(200)
                .get();

            const requests = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));

            res.json({
                success: true,
                requests
            });

        } catch (error) {
            console.error("Admin recharges error:", error);
            return sendError(res, 500, "Unable to load recharge requests.");
        }
    }
);

// =====================================
// ADMIN RECHARGE DECISION
// =====================================

app.post(
    "/admin/recharges/:id/decision",
    authenticateUser,
    requireFirebase,
    adminOnly,
    async (req, res) => {
        try {
            const requestId = req.params.id;
            const decision = req.body?.decision;

            if (!["approve", "reject"].includes(decision)) {
                return sendError(
                    res,
                    400,
                    "Decision must be approve or reject."
                );
            }

            const requestRef = db
                .collection("recharge_requests")
                .doc(requestId);

            await db.runTransaction(async transaction => {
                const requestDoc = await transaction.get(requestRef);

                if (!requestDoc.exists) {
                    throw new Error("REQUEST_NOT_FOUND");
                }

                const request = requestDoc.data();

                if (request.status !== "pending") {
                    throw new Error("REQUEST_ALREADY_PROCESSED");
                }

                let walletRef;
                let userRef;
                let wallet = {};
                let user = {};

                if (decision === "approve") {
                    if (!validUid(request.uid)) {
                        throw new Error("INVALID_REQUEST_UID");
                    }

                    walletRef = db.collection("wallets").doc(request.uid);
                    userRef = db.collection("users").doc(request.uid);

                    const [walletDoc, userDoc] = await Promise.all([
                        transaction.get(walletRef),
                        transaction.get(userRef)
                    ]);

                    wallet = walletDoc.exists ? walletDoc.data() : {};
                    user = userDoc.exists ? userDoc.data() : {};

                    const currentCoins = Number(
                        wallet.coins ?? user.coins ?? 0
                    );

                    const coins = Number(request.coins);

                    if (
                        !Number.isSafeInteger(currentCoins) ||
                        currentCoins < 0 ||
                        !Number.isSafeInteger(coins) ||
                        coins <= 0 ||
                        currentCoins + coins > Number.MAX_SAFE_INTEGER
                    ) {
                        throw new Error("INVALID_RECHARGE_AMOUNT");
                    }

                    const newBalance = currentCoins + coins;

                    transaction.set(
                        walletRef,
                        {
                            coins: newBalance,
                            updatedAt: dateValue()
                        },
                        { merge: true }
                    );

                    transaction.set(
                        userRef,
                        {
                            coins: newBalance,
                            updatedAt: dateValue()
                        },
                        { merge: true }
                    );
                }

                transaction.update(requestRef, {
                    status: decision === "approve" ? "approved" : "rejected",
                    reviewedAt: dateValue(),
                    reviewedBy: req.user.uid
                });
            });

            res.json({
                success: true,
                message: `Recharge ${decision}d successfully.`
            });

        } catch (error) {
            console.error("Recharge decision error:", error);

            if (error.message === "REQUEST_NOT_FOUND") {
                return sendError(res, 404, "Recharge request not found.");
            }

            if (error.message === "REQUEST_ALREADY_PROCESSED") {
                return sendError(res, 400, "This request has already been processed.");
            }

            if (error.message === "INVALID_REQUEST_UID") {
                return sendError(res, 400, "Invalid recharge user.");
            }

            if (error.message === "INVALID_RECHARGE_AMOUNT") {
                return sendError(res, 400, "Invalid recharge amount or wallet balance.");
            }

            return sendError(res, 500, "Unable to process recharge request.");
        }
    }
);

// =====================================
// ADMIN WITHDRAWALS
// =====================================

app.get(
    "/admin/withdrawals",
    authenticateUser,
    requireFirebase,
    adminOnly,
    async (req, res) => {
        try {
            const snapshot = await db
                .collection("withdrawal_requests")
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
            console.error("Admin withdrawals error:", error);
            return sendError(res, 500, "Unable to load withdrawal requests.");
        }
    }
);

// =====================================
// ADMIN WITHDRAWAL DECISION
// =====================================

app.post(
    "/admin/withdrawals/:id/decision",
    authenticateUser,
    requireFirebase,
    adminOnly,
    async (req, res) => {
        try {
            const requestId = req.params.id;
            const decision = req.body?.decision;

            if (!["approve", "reject"].includes(decision)) {
                return sendError(
                    res,
                    400,
                    "Decision must be approve or reject."
                );
            }

            const requestRef = db
                .collection("withdrawal_requests")
                .doc(requestId);

            await db.runTransaction(async transaction => {
                const requestDoc = await transaction.get(requestRef);

                if (!requestDoc.exists) {
                    throw new Error("REQUEST_NOT_FOUND");
                }

                const request = requestDoc.data();

                if (request.status !== "pending") {
                    throw new Error("REQUEST_ALREADY_PROCESSED");
                }

                if (!validUid(request.uid)) {
                    throw new Error("INVALID_REQUEST_UID");
                }

                if (decision === "approve") {
                    const walletRef = db
                        .collection("wallets")
                        .doc(request.uid);

                    const userRef = db
                        .collection("users")
                        .doc(request.uid);

                    const [walletDoc, userDoc] = await Promise.all([
                        transaction.get(walletRef),
                        transaction.get(userRef)
                    ]);

                    const wallet = walletDoc.exists
                        ? walletDoc.data()
                        : {};

                    const user = userDoc.exists
                        ? userDoc.data()
                        : {};

                    const currentDiamonds = Number(
                        wallet.diamonds ?? user.diamonds ?? 0
                    );

                    const diamondsToDeduct = Number(
                        request.diamonds || WITHDRAWAL_DIAMONDS
                    );

                    if (
                        !Number.isSafeInteger(currentDiamonds) ||
                        !Number.isSafeInteger(diamondsToDeduct) ||
                        diamondsToDeduct !== WITHDRAWAL_DIAMONDS ||
                        currentDiamonds < diamondsToDeduct
                    ) {
                        throw new Error("INSUFFICIENT_DIAMONDS");
                    }

                    const newDiamonds =
                        currentDiamonds - diamondsToDeduct;

                    transaction.set(
                        walletRef,
                        {
                            diamonds: newDiamonds,
                            updatedAt: dateValue()
                        },
                        { merge: true }
                    );

                    transaction.set(
                        userRef,
                        {
                            diamonds: newDiamonds,
                            updatedAt: dateValue()
                        },
                        { merge: true }
                    );
                }

                // Rejection does not deduct diamonds.
                transaction.update(requestRef, {
                    status: decision === "approve" ? "approved" : "rejected",
                    reviewedAt: dateValue(),
                    reviewedBy: req.user.uid,
                    diamondsDeducted:
                        decision === "approve" ? WITHDRAWAL_DIAMONDS : 0
                });

                transaction.set(
                    db.collection("admin_logs").doc(),
                    {
                        type: "withdrawal_decision",
                        requestId,
                        uid: request.uid,
                        decision,
                        diamondsDeducted:
                            decision === "approve" ? WITHDRAWAL_DIAMONDS : 0,
                        adminUid: req.user.uid,
                        createdAt: dateValue()
                    }
                );
            });

            res.json({
                success: true,
                message: decision === "approve"
                    ? "Withdrawal approved. 60,000 diamonds deducted."
                    : "Withdrawal rejected. No diamonds deducted.",
                diamondsDeducted:
                    decision === "approve" ? WITHDRAWAL_DIAMONDS : 0
            });

        } catch (error) {
            console.error("Withdrawal decision error:", error);

            if (error.message === "REQUEST_NOT_FOUND") {
                return sendError(res, 404, "Withdrawal request not found.");
            }

            if (error.message === "REQUEST_ALREADY_PROCESSED") {
                return sendError(res, 400, "This request has already been processed.");
            }

            if (error.message === "INVALID_REQUEST_UID") {
                return sendError(res, 400, "Invalid withdrawal user.");
            }

            if (error.message === "INSUFFICIENT_DIAMONDS") {
                return sendError(
                    res,
                    400,
                    "User does not have enough diamonds for this withdrawal."
                );
            }

            return sendError(res, 500, "Unable to process withdrawal request.");
        }
    }
);

// =====================================
// ADMIN LIVE SESSIONS
// =====================================

app.get(
    "/admin/live-sessions",
    authenticateUser,
    requireFirebase,
    adminOnly,
    async (req, res) => {
        try {
            const snapshot = await db
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
            console.error("Admin live sessions error:", error);
            return sendError(res, 500, "Unable to load live sessions.");
        }
    }
);

// =====================================
// ADMIN GIFT HISTORY
// =====================================

app.get(
    "/admin/gifts",
    authenticateUser,
    requireFirebase,
    adminOnly,
    async (req, res) => {
        try {
            const snapshot = await db
                .collection("admin_logs")
                .where("type", "==", "gift")
                .limit(200)
                .get();

            const gifts = snapshot.docs.map(doc => {
                const data = doc.data();

                const giftInfo = GIFTS.find(
                    gift => gift.id === data.giftId
                ) || {};

                return {
                    id: doc.id,
                    giftId: data.giftId || "",
                    giftName: data.giftName || giftInfo.name || "Gift",
                    giftEmoji: data.giftEmoji || giftInfo.emoji || "🎁",
                    senderUid: data.senderUid || "",
                    hostUid: data.hostUid || "",
                    receiverUid: data.hostUid || "",
                    quantity: Number(data.quantity || 1),
                    coins: Number(data.coins || 0),
                    diamonds: Number(data.diamonds || 0),
                    sessionId: data.sessionId || "",
                    createdAt: data.createdAt || null
                };
            });

            res.json({
                success: true,
                gifts
            });

        } catch (error) {
            console.error("Admin gift history error:", error);
            return sendError(res, 500, "Unable to load gift history.");
        }
    }
);

// =====================================
// RELATIONSHIP CARDS
// =====================================

const RELATIONSHIP_CARDS = [
    {
        id: "cp",
        name: "CP Card",
        emoji: "💑",
        price: 8000,
        frame: "CP_FRAME"
    },
    {
        id: "best_friend",
        name: "Best Friend Card",
        emoji: "👫",
        price: 8000,
        frame: "BEST_FRIEND_FRAME"
    },
    {
        id: "good_friend",
        name: "Good Friend Card",
        emoji: "🤝",
        price: 8000,
        frame: "GOOD_FRIEND_FRAME"
    },
    {
        id: "game_friend",
        name: "Game Friend Card",
        emoji: "🎮",
        price: 8000,
        frame: "GAME_FRIEND_FRAME"
    }
];

// =====================================
// GET RELATIONSHIP CARDS
// =====================================

app.get(
    "/relationship/cards",
    authenticateUser,
    requireFirebase,
    (req, res) => {
        res.json({
            success: true,
            cards: RELATIONSHIP_CARDS
        });
    }
);

// =====================================
// SEND RELATIONSHIP REQUEST
// =====================================

app.post(
    "/relationship/send",
    authenticateUser,
    requireFirebase,
    async (req, res) => {
        try {
            const senderUid = req.user.uid;
            const { receiverUid, cardId } = req.body || {};

            const card = RELATIONSHIP_CARDS.find(
                item => item.id === cardId
            );

            if (!validUid(receiverUid) || !card) {
                return sendError(res, 400, "Invalid relationship details.");
            }

            if (senderUid === receiverUid) {
                return sendError(res, 400, "You cannot send a card to yourself.");
            }

            const senderRef = db.collection("users").doc(senderUid);
            const receiverRef = db.collection("users").doc(receiverUid);
            const walletRef = db.collection("wallets").doc(senderUid);
            const requestRef = db.collection("relationship_requests").doc();

            await db.runTransaction(async transaction => {
                const [
                    senderDoc,
                    receiverDoc,
                    walletDoc
                ] = await Promise.all([
                    transaction.get(senderRef),
                    transaction.get(receiverRef),
                    transaction.get(walletRef)
                ]);

                if (!receiverDoc.exists) {
                    throw new Error("RECEIVER_NOT_FOUND");
                }

                const sender = senderDoc.exists ? senderDoc.data() : {};
                const receiver = receiverDoc.data();
                const wallet = walletDoc.exists ? walletDoc.data() : {};

                if (
                    sender.relationshipStatus === "active" ||
                    receiver.relationshipStatus === "active"
                ) {
                    throw new Error("ALREADY_IN_RELATIONSHIP");
                }

                const coins = Number(
                    wallet.coins ?? sender.coins ?? 0
                );

                if (
                    !Number.isSafeInteger(coins) ||
                    coins < card.price
                ) {
                    throw new Error("INSUFFICIENT_COINS");
                }

                const newBalance = coins - card.price;

                transaction.set(
                    walletRef,
                    {
                        coins: newBalance,
                        updatedAt: dateValue()
                    },
                    { merge: true }
                );

                transaction.set(
                    senderRef,
                    {
                        coins: newBalance,
                        updatedAt: dateValue()
                    },
                    { merge: true }
                );

                transaction.set(requestRef, {
                    senderUid,
                    senderName: sender.name || sender.username || "User",
                    receiverUid,
                    receiverName: receiver.name || receiver.username || "User",
                    cardId: card.id,
                    cardName: card.name,
                    cardEmoji: card.emoji,
                    cardFrame: card.frame,
                    price: card.price,
                    status: "pending",
                    createdAt: dateValue()
                });
            });

            res.json({
                success: true,
                message: "Relationship request sent.",
                requestId: requestRef.id,
                coinsDeducted: 8000
            });

        } catch (error) {
            console.error("Relationship send error:", error);

            if (error.message === "RECEIVER_NOT_FOUND") {
                return sendError(res, 404, "Receiver not found.");
            }

            if (error.message === "ALREADY_IN_RELATIONSHIP") {
                return sendError(
                    res,
                    400,
                    "One user already has an active relationship."
                );
            }

            if (error.message === "INSUFFICIENT_COINS") {
                return sendError(res, 400, "You need 8,000 coins.");
            }

            return sendError(
                res,
                500,
                "Unable to send relationship request."
            );
        }
    }
);

// =====================================
// GET INCOMING AND OUTGOING REQUESTS
// =====================================

app.get(
    "/relationship/requests",
    authenticateUser,
    requireFirebase,
    async (req, res) => {
        try {
            const uid = req.user.uid;

            const [
                incomingSnapshot,
                outgoingSnapshot
            ] = await Promise.all([
                db.collection("relationship_requests")
                    .where("receiverUid", "==", uid)
                    .limit(100)
                    .get(),

                db.collection("relationship_requests")
                    .where("senderUid", "==", uid)
                    .limit(100)
                    .get()
            ]);

            res.json({
                success: true,

                incoming: incomingSnapshot.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data()
                })),

                outgoing: outgoingSnapshot.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data()
                }))
            });

        } catch (error) {
            console.error("Relationship requests error:", error);
            return sendError(res, 500, "Unable to load relationship requests.");
        }
    }
);

// =====================================
// ACCEPT OR REJECT RELATIONSHIP REQUEST
// =====================================

app.post(
    "/relationship/:requestId/decision",
    authenticateUser,
    requireFirebase,
    async (req, res) => {
        try {
            const uid = req.user.uid;
            const requestId = req.params.requestId;
            const decision = req.body?.decision;

            if (!["accept", "reject"].includes(decision)) {
                return sendError(
                    res,
                    400,
                    "Decision must be accept or reject."
                );
            }

            const requestRef = db
                .collection("relationship_requests")
                .doc(requestId);

            await db.runTransaction(async transaction => {
                const requestDoc = await transaction.get(requestRef);

                if (!requestDoc.exists) {
                    throw new Error("REQUEST_NOT_FOUND");
                }

                const request = requestDoc.data();

                if (request.receiverUid !== uid) {
                    throw new Error("NOT_RECEIVER");
                }

                if (request.status !== "pending") {
                    throw new Error("ALREADY_PROCESSED");
                }

                const senderRef = db.collection("users").doc(request.senderUid);
                const receiverRef = db.collection("users").doc(uid);

                const senderWalletRef = db.collection("wallets").doc(request.senderUid);
                const receiverWalletRef = db.collection("wallets").doc(uid);

                const [
                    senderDoc,
                    receiverDoc,
                    senderWalletDoc,
                    receiverWalletDoc
                ] = await Promise.all([
                    transaction.get(senderRef),
                    transaction.get(receiverRef),
                    transaction.get(senderWalletRef),
                    transaction.get(receiverWalletRef)
                ]);

                if (!senderDoc.exists || !receiverDoc.exists) {
                    throw new Error("USER_NOT_FOUND");
                }

                const sender = senderDoc.data();
                const receiver = receiverDoc.data();

                const senderWallet = senderWalletDoc.exists
                    ? senderWalletDoc.data()
                    : {};

                const receiverWallet = receiverWalletDoc.exists
                    ? receiverWalletDoc.data()
                    : {};

                if (decision === "accept") {
                    if (
                        sender.relationshipStatus === "active" ||
                        receiver.relationshipStatus === "active"
                    ) {
                        throw new Error("ALREADY_IN_RELATIONSHIP");
                    }

                    const relationshipRef = db
                        .collection("relationships")
                        .doc();

                    const relationshipSince =
                        admin.firestore.Timestamp.now();

                    const receiverCoins = Number(
                        receiverWallet.coins ?? receiver.coins ?? 0
                    );

                    if (
                        !Number.isSafeInteger(receiverCoins) ||
                        receiverCoins < 0 ||
                        receiverCoins + 4000 > Number.MAX_SAFE_INTEGER
                    ) {
                        throw new Error("INVALID_RECEIVER_BALANCE");
                    }

                    const newReceiverCoins = receiverCoins + 4000;

                    transaction.set(relationshipRef, {
                        senderUid: request.senderUid,
                        senderName: request.senderName,
                        receiverUid: uid,
                        receiverName: request.receiverName,
                        cardId: request.cardId,
                        cardName: request.cardName,
                        cardFrame: request.cardFrame,
                        status: "active",
                        createdAt: dateValue()
                    });

                    // Sender profile frame
                    transaction.set(
                        senderRef,
                        {
                            relationshipId: relationshipRef.id,
                            relationshipType: request.cardId,
                            relationshipFrame: request.cardFrame,
                            relationshipPartnerUid: uid,
                            relationshipPartnerName:
                                receiver.name || receiver.username || "User",
                            relationshipStatus: "active",
                            relationshipSince,
                            updatedAt: dateValue()
                        },
                        { merge: true }
                    );

                    // Receiver profile frame and 4,000 coins
                    transaction.set(
                        receiverRef,
                        {
                            relationshipId: relationshipRef.id,
                            relationshipType: request.cardId,
                            relationshipFrame: request.cardFrame,
                            relationshipPartnerUid: request.senderUid,
                            relationshipPartnerName:
                                sender.name || sender.username || "User",
                            relationshipStatus: "active",
                            relationshipSince,
                            coins: newReceiverCoins,
                            updatedAt: dateValue()
                        },
                        { merge: true }
                    );

                    transaction.set(
                        receiverWalletRef,
                        {
                            coins: newReceiverCoins,
                            updatedAt: dateValue()
                        },
                        { merge: true }
                    );

                    transaction.update(requestRef, {
                        status: "accepted",
                        relationshipId: relationshipRef.id,
                        decidedAt: dateValue()
                    });

                } else {
                    // Rejection: sender gets only 4,000 coins back.
                    const senderCoins = Number(
                        senderWallet.coins ?? sender.coins ?? 0
                    );

                    if (
                        !Number.isSafeInteger(senderCoins) ||
                        senderCoins < 0 ||
                        senderCoins + 4000 > Number.MAX_SAFE_INTEGER
                    ) {
                        throw new Error("INVALID_SENDER_BALANCE");
                    }

                    const refundBalance = senderCoins + 4000;

                    transaction.set(
                        senderWalletRef,
                        {
                            coins: refundBalance,
                            updatedAt: dateValue()
                        },
                        { merge: true }
                    );

                    transaction.set(
                        senderRef,
                        {
                            coins: refundBalance,
                            updatedAt: dateValue()
                        },
                        { merge: true }
                    );

                    transaction.update(requestRef, {
                        status: "rejected",
                        decidedAt: dateValue(),
                        senderRefund: 4000
                    });
                }
            });

            res.json({
                success: true,
                message: decision === "accept"
                    ? "Relationship accepted. Receiver received 4,000 coins."
                    : "Request rejected. Sender received 4,000 coins refund."
            });

        } catch (error) {
            console.error("Relationship decision error:", error);

            if (error.message === "REQUEST_NOT_FOUND") {
                return sendError(res, 404, "Request not found.");
            }

            if (error.message === "NOT_RECEIVER") {
                return sendError(res, 403, "Only receiver can decide.");
            }

            if (error.message === "ALREADY_PROCESSED") {
                return sendError(res, 400, "Request already processed.");
            }

            if (error.message === "USER_NOT_FOUND") {
                return sendError(res, 404, "User not found.");
            }

            if (error.message === "ALREADY_IN_RELATIONSHIP") {
                return sendError(
                    res,
                    400,
                    "User already has an active relationship."
                );
            }

            if (
                error.message === "INVALID_RECEIVER_BALANCE" ||
                error.message === "INVALID_SENDER_BALANCE"
            ) {
                return sendError(res, 400, "Invalid wallet balance.");
            }

            return sendError(
                res,
                500,
                "Unable to process relationship request."
            );
        }
    }
);

// =====================================
// GET MY ACTIVE RELATIONSHIP
// =====================================

app.get(
    "/relationship/my",
    authenticateUser,
    requireFirebase,
    async (req, res) => {
        try {
            const userDoc = await db
                .collection("users")
                .doc(req.user.uid)
                .get();

            const user = userDoc.exists ? userDoc.data() : {};

            res.json({
                success: true,

                relationship:
                    user.relationshipStatus === "active"
                        ? {
                            relationshipId: user.relationshipId || null,
                            relationshipType: user.relationshipType || null,
                            relationshipFrame: user.relationshipFrame || null,
                            relationshipPartnerUid:
                                user.relationshipPartnerUid || null,
                            relationshipPartnerName:
                                user.relationshipPartnerName || null,
                            relationshipSince:
                                user.relationshipSince || null,
                            relationshipStatus: "active"
                        }
                        : null
            });

        } catch (error) {
            console.error("My relationship error:", error);
            return sendError(res, 500, "Unable to load relationship.");
        }
    }
);

// =====================================
// UNKNOWN ROUTE
// =====================================

app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: "Route not found."
    });
});

// =====================================
// ERROR HANDLER
// =====================================

app.use((error, req, res, next) => {
    console.error("Server error:", error);

    if (res.headersSent) {
        return next(error);
    }

    res.status(error.status || 500).json({
        success: false,
        message: error.message || "Internal server error."
    });
});

// =====================================
// EXPORT APP FOR VERCEL
// =====================================

export default app;
