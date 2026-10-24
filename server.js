import express from "express";
import { AccessToken } from "livekit-server-sdk";

const app = express();
app.use(express.json());

const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

app.get("/", (req, res) => {
  res.send("KK Live token server is running");
});

app.get("/token", async (req, res) => {
  try {
    const room = String(req.query.room || "").trim();
    const identity = String(req.query.identity || "").trim();

    if (!room || !identity) {
      return res.status(400).json({
        error: "room and identity are required"
      });
    }

    if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      return res.status(500).json({
        error: "LiveKit server configuration is missing"
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

    const jwt = await token.toJwt();

    return res.json({
      token: jwt,
      url: LIVEKIT_URL,
      room,
      identity
    });
  } catch (error) {
    console.error("Token generation failed:", error);

    return res.status(500).json({
      error: "Could not generate token"
    });
  }
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`KK Live server listening on port ${PORT}`);
});
