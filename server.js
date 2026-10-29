import express from "express";
import { AccessToken } from "livekit-server-sdk";

const app = express();

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "KK Live LiveKit import is working",
    livekitLoaded: typeof AccessToken === "function"
  });
});

export default app;
