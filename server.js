import express from "express";
import admin from "firebase-admin";

const app = express();

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "KK Live Firebase import is working",
    firebaseLoaded: typeof admin.initializeApp === "function",
    firebaseInitialized: admin.apps.length > 0
  });
});

export default app;
