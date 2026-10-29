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

app.get("/token", async (req, res) => {
  try {
    const room = String(req.query.room || "").trim();
    const identity = String(req.query.identity || "").trim();

    if (!room || !identity) {
      return res.status(400).json({
        success: false,
        error: "room and identity are required"
      });
    }

    const LIVEKIT_URL = process.env.LIVEKIT_URL;
    const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
    const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

    if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      return res.status(503).json({
        success: false,
        error: "LiveKit environment variables are missing"
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

    return res.status(200).json({
      success: true,
      token: await token.toJwt(),
      url: LIVEKIT_URL,
      room,
      identity
    });
  } catch (error) {
    console.error("LiveKit token error:", error);

    return res.status(500).json({
      success: false,
      error: "Could not generate LiveKit token"
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Route not found"
  });
});

export default app;

