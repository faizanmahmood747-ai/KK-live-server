// FIREBASE ADMIN CONFIGURATION
// ========================================

let firebaseReady = false;
let db = null;
let firebaseAuth = null;
let firebaseReady = false;

try {
 const serviceAccountJson =
   process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (serviceAccountJson) {
  if (!serviceAccountJson) {
    console.error(
      "FIREBASE_SERVICE_ACCOUNT_JSON is missing"
    );
  } else {
   const serviceAccount = JSON.parse(serviceAccountJson);

    if (!admin.apps.length) {
    if (admin.apps.length === 0) {
     admin.initializeApp({
       credential: admin.credential.cert(serviceAccount)
     });
@@ -41,10 +45,6 @@ try {
   firebaseReady = true;

   console.log("Firebase Admin initialized");
  } else {
    console.error(
      "FIREBASE_SERVICE_ACCOUNT_JSON is missing"
    );
 }
} catch (error) {
 console.error(
@@ -55,7 +55,6 @@ try {

// ========================================
// GIFT CATALOGUE
// Prices are controlled by the server.
// ========================================

const GIFTS = {
@@ -64,31 +63,27 @@ const GIFTS = {
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

// New wallets receive 300 coins.
const STARTING_COINS = 300;

// ========================================
// FIREBASE AUTHENTICATION
// VERIFY FIREBASE LOGIN
// ========================================

async function verifyFirebaseUser(req, res) {
@@ -121,10 +116,7 @@ async function verifyFirebaseUser(req, res) {
 }

 try {
    const decodedToken =
      await firebaseAuth.verifyIdToken(idToken);

    return decodedToken;
    return await firebaseAuth.verifyIdToken(idToken);
 } catch (error) {
   console.error(
     "Firebase token verification failed:",
@@ -147,16 +139,12 @@ app.get("/", (req, res) => {
 res.status(200).json({
   success: true,
   message: "K.K Live server is running",
    features: [
      "LiveKit",
      "Wallet",
      "Gifts"
    ]
    features: ["LiveKit", "Wallet", "Gifts"]
 });
});

// ========================================
// LIVEKIT TOKEN ROUTE
// LIVEKIT TOKEN
// ========================================

app.get("/token", async (req, res) => {
@@ -180,9 +168,7 @@ app.get("/token", async (req, res) => {
     !LIVEKIT_API_KEY ||
     !LIVEKIT_API_SECRET
   ) {
      console.error(
        "LiveKit environment variables are missing"
      );
      console.error("LiveKit environment variables are missing");

     return res.status(500).json({
       error: "LiveKit server configuration is missing"
@@ -215,10 +201,7 @@ app.get("/token", async (req, res) => {
     identity
   });
 } catch (error) {
    console.error(
      "Token generation failed:",
      error.message
    );
    console.error("Token generation failed:", error);

   return res.status(500).json({
     error: "Could not generate LiveKit token"
@@ -228,63 +211,49 @@ app.get("/token", async (req, res) => {

// ========================================
// GET WALLET
// Creates a wallet with 300 coins if one
// does not already exist.
// New users receive 300 coins.
// Existing balances are preserved.
// ========================================

app.get("/wallet", async (req, res) => {
 try {
   const user = await verifyFirebaseUser(req, res);

    if (!user) {
      return;
    }
    if (!user) return;

   const walletRef = db
     .collection("wallets")
     .doc(user.uid);

    const balance = await db.runTransaction(
      async (transaction) => {
        const walletSnapshot =
          await transaction.get(walletRef);
    const balance = await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(walletRef);

        if (walletSnapshot.exists) {
          const walletData = walletSnapshot.data();
          const currentCoins = walletData.coins;
      if (snapshot.exists) {
        const coins = snapshot.data().coins;

          if (
            !Number.isSafeInteger(currentCoins) ||
            currentCoins < 0
          ) {
            throw new Error("WALLET_DATA_INVALID");
          }

          return currentCoins;
        if (!Number.isSafeInteger(coins) || coins < 0) {
          throw new Error("WALLET_DATA_INVALID");
       }

        transaction.create(walletRef, {
          uid: user.uid,
          coins: STARTING_COINS,
          createdAt:
            admin.firestore.FieldValue.serverTimestamp(),
          updatedAt:
            admin.firestore.FieldValue.serverTimestamp()
        });

        return STARTING_COINS;
        return coins;
     }
    );

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
    console.error(
      "Wallet request failed:",
      error.message
    );
    console.error("Wallet request failed:", error);

   if (error.message === "WALLET_DATA_INVALID") {
     return res.status(500).json({
@@ -300,17 +269,13 @@ app.get("/wallet", async (req, res) => {

// ========================================
// SEND GIFT
// Deducts coins and records the gift in
// one Firestore transaction.
// ========================================

app.post("/gift", async (req, res) => {
 try {
   const user = await verifyFirebaseUser(req, res);

    if (!user) {
      return;
    }
    if (!user) return;

   const sessionId = String(
     req.body?.sessionId || ""
@@ -354,140 +319,119 @@ app.post("/gift", async (req, res) => {
     .collection("gifts")
     .doc();

    const result = await db.runTransaction(
      async (transaction) => {
        // Read all documents before writing.
        const sessionSnapshot =
          await transaction.get(sessionRef);

        const walletSnapshot =
          await transaction.get(walletRef);

        const senderSnapshot =
          await transaction.get(senderRef);
    const result = await db.runTransaction(async (tx) => {
      const sessionSnapshot = await tx.get(sessionRef);
      const walletSnapshot = await tx.get(walletRef);
      const senderSnapshot = await tx.get(senderRef);

        if (!sessionSnapshot.exists) {
          throw new Error("LIVE_SESSION_NOT_FOUND");
        }
      if (!sessionSnapshot.exists) {
        throw new Error("LIVE_SESSION_NOT_FOUND");
      }

        const sessionData = sessionSnapshot.data();
      const session = sessionSnapshot.data();

        if (sessionData.status !== "live") {
          throw new Error("LIVE_SESSION_NOT_ACTIVE");
        }
      if (session.status !== "live") {
        throw new Error("LIVE_SESSION_NOT_ACTIVE");
      }

        // Prevent sending gifts to your own live session.
        if (sessionData.hostUid === user.uid) {
          throw new Error("CANNOT_GIFT_SELF");
        }
      if (session.hostUid === user.uid) {
        throw new Error("CANNOT_GIFT_SELF");
      }

        if (!walletSnapshot.exists) {
          throw new Error("WALLET_NOT_INITIALIZED");
        }
      if (!walletSnapshot.exists) {
        throw new Error("WALLET_NOT_INITIALIZED");
      }

        const walletData = walletSnapshot.data();
        const currentCoins = walletData.coins;
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
      if (
        !Number.isSafeInteger(currentCoins) ||
        currentCoins < 0
      ) {
        throw new Error("WALLET_DATA_INVALID");
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
        )
          .trim()
          .slice(0, 80);

        const remainingCoins =
          currentCoins - gift.price;

        // Deduct the sender's coins.
        transaction.update(walletRef, {
          coins: remainingCoins,
          updatedAt:
            admin.firestore.FieldValue.serverTimestamp()
        });

        // Save the gift under the live session.
        transaction.create(giftRef, {
          senderUid: user.uid,
          senderName,
          giftName: gift.name,
          emoji: gift.emoji,
          price: gift.price,
          sentAt:
            admin.firestore.FieldValue.serverTimestamp()
        });

        return {
          coins: remainingCoins,
          gift: gift.name,
          price: gift.price,
          emoji: gift.emoji,
          senderName
        };
      if (currentCoins < gift.price) {
        throw new Error("INSUFFICIENT_COINS");
     }
    );

    return res.status(200).json({
      success: true,
      message: "Gift sent successfully",
      ...result
    });
  } catch (error) {
    console.error(
      "Gift request failed:",
      error.message
    );
      const senderData = senderSnapshot.exists
        ? senderSnapshot.data()
        : {};

    if (error.message === "LIVE_SESSION_NOT_FOUND") {
      return res.status(404).json({
        error: "Live session not found"
      });
    }
      const senderName = String(
        senderData.name ||
        senderData.displayName ||
        user.name ||
        user.email ||
        "Viewer"
      ).trim().slice(0, 80);

    if (error.message === "LIVE_SESSION_NOT_ACTIVE") {
      return res.status(400).json({
        error: "This live session is not active"
      });
    }
      const remainingCoins = currentCoins - gift.price;

    if (error.message === "CANNOT_GIFT_SELF") {
      return res.status(400).json({
        error: "You cannot send a gift to your own live"
      tx.update(walletRef, {
        coins: remainingCoins,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
     });
    }

    if (error.message === "WALLET_NOT_INITIALIZED") {
      return res.status(400).json({
        error: "Load your wallet before sending gifts"
      tx.create(giftRef, {
        senderUid: user.uid,
        senderName,
        giftName: gift.name,
        emoji: gift.emoji,
        price: gift.price,
        sentAt: admin.firestore.FieldValue.serverTimestamp()
     });
    }

    if (error.message === "WALLET_DATA_INVALID") {
      return res.status(500).json({
        error: "Wallet data needs administrator review"
      });
    }
      return {
        coins: remainingCoins,
        gift: gift.name,
        price: gift.price,
        emoji: gift.emoji,
        senderName
      };
    });

    if (error.message === "INSUFFICIENT_COINS") {
      return res.status(400).json({
        error: "Not enough coins"
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

@@ -498,20 +442,34 @@ app.post("/gift", async (req, res) => {
});

// ========================================
// SERVER START
// Vercel handles server startup automatically.
// Other hosts can use app.listen().
// ERROR HANDLER
// ========================================

const PORT = process.env.PORT || 10000;
app.use((error, req, res, next) => {
  console.error("Express error:", error);

if (!process.env.VERCEL) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(
      `K.K Live server listening on port ${PORT}`
    );
  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).json({
    error: "Internal server error"
 });
}
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
