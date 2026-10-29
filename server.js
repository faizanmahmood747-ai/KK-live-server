import express from "express";

const app = express();

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "KK Live Express is working"
  });
});

export default app;

