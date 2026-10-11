
const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGIN = "https://vctr-edu.github.io";
const REDIRECT_URI =
  "https://broken-reflection-api.onrender.com/tiktok/callback";

app.use((req, res, next) => {
  if (req.headers.origin === ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Vary", "Origin");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, OPTIONS"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization"
    );
  }

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    name: "Broken Reflection Content Pipeline API",
    status: "running"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Backend is working"
  });
});

app.get("/tiktok/authorize", (req, res) => {
  if (process.env.TIKTOK_ENV !== "sandbox") {
    return res.status(500).send(
      "TikTok environment is not configured for sandbox."
    );
  }

  const clientKey = process.env.TIKTOK_CLIENT_KEY_SANDBOX;

  if (!clientKey || !process.env.TIKTOK_CLIENT_SECRET_SANDBOX) {
    return res.status(500).send(
      "TikTok sandbox credentials are missing."
    );
  }

  const state = crypto.randomBytes(32).toString("hex");

  res.setHeader(
    "Set-Cookie",
    `tiktok_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`
  );

  const params = new URLSearchParams({
    client_key: clientKey,
    response_type: "code",
    scope: "user.info.basic,video.publish,video.upload",
    redirect_uri: REDIRECT_URI,
    state
  });

  res.redirect(
    `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`
  );
});

app.get("/tiktok/callback", (req, res) => {
  const cookies = Object.fromEntries(
    (req.headers.cookie || "")
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const index = item.indexOf("=");
        return index < 0
          ? [item, ""]
          : [
              item.slice(0, index),
              decodeURIComponent(item.slice(index + 1))
            ];
      })
  );

  const expectedState = cookies.tiktok_oauth_state;
  const receivedState = req.query.state;

  res.setHeader(
    "Set-Cookie",
    "tiktok_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"
  );

  if (req.query.error) {
    return res.status(400).send(
      "TikTok authorization was cancelled or rejected. You can return to the app and try again."
    );
  }

  if (
    typeof expectedState !== "string" ||
    typeof receivedState !== "string" ||
    expectedState.length !== receivedState.length ||
    !crypto.timingSafeEqual(
      Buffer.from(expectedState),
      Buffer.from(receivedState)
    )
  ) {
    return res.status(400).send(
      "Authorization state validation failed. Return to the app and try again."
    );
  }

  if (typeof req.query.code !== "string" || !req.query.code) {
    return res.status(400).send(
      "TikTok did not return an authorization code."
    );
  }

  res.send(`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Broken Reflection — TikTok</title>
      </head>
      <body style="font-family:Arial,sans-serif;max-width:640px;margin:60px auto;padding:24px;line-height:1.6">
        <h1>Authorization callback validated</h1>
        <p>TikTok returned an authorization code and the security state was validated.</p>
        <p>This is only the first OAuth stage. Token exchange and secure token storage are not implemented yet, so the account is not ready to publish videos.</p>
        <a href="https://vctr-edu.github.io/tiktok-pipeline/">Return to Broken Reflection</a>
      </body>
    </html>
  `);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`API running on port ${PORT}`);
});
