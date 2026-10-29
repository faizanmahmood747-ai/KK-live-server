```javascript
import express from "express";
import { AccessToken } from "livekit-server-sdk";
import admin from "firebase-admin";

const app = express();

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "KK Live imports are working",
    expressLoaded: true,
    livekitLoaded: typeof AccessToken === "function",
    firebaseLoaded: typeof admin.initializeApp === "function"
  });
});

export default app;
```
