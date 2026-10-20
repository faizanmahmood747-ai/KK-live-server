import express from "express";
import { AccessToken } from "livekit-server-sdk";

const app = express();
app.use(express.json());

// LiveKit environment variables
const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

// Home route
app.get("/", (req, res) => {
  res.send("KK Live token server is running");
});

// Generate LiveKit token
app.get("/token", async (req, res) => {
  try {
    const room = String(req.query.room || "").trim();
    const identity = String(req.query.identity || "").trim();

    // Validate parameters
    if (!room || !identity) {
      return res.status(400).json({
        error: "room and identity are required"
      });
    }

    // Validate environment variables
    if (
      !LIVEKIT_URL ||
      !LIVEKIT_API_KEY ||
      !LIVEKIT_API_SECRET
    ) {
      console.error(
        "LiveKit environment variables are missing"
      );

      return res.status(500).json({
        error: "LiveKit server configuration is missing"
      });
    }

    // Create access token
    const accessToken = new AccessToken(
      LIVEKIT_API_KEY,
      LIVEKIT_API_SECRET,
      {
        identity: identity,
        ttl: "1h"
      }
    );

    // Set room permissions
    accessToken.addGrant({
      roomJoin: true,
      room: room,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true
    });

    // Generate JWT
    const jwt = await accessToken.toJwt();

    // Debug logs — never log the token or secret
    console.log("Token generated successfully");
    console.log("Room:", room);
    console.log("Identity:", identity);
    console.log("LiveKit URL:", LIVEKIT_URL);

    // Send response
    return res.status(200).json({
      token: jwt,
      url: LIVEKIT_URL,
      room: room,
      identity: identity
    });

  } catch (error) {
    console.error(
      "Token generation failed:",
      error.message
    );

    return res.status(500).json({
      error: "Could not generate token"
    });
  }
});

// Start server
const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `KK Live server listening on port ${PORT}`
  );
});
