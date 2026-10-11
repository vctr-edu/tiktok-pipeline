
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGIN = "https://vctr-edu.github.io";

// Allow requests from the GitHub Pages frontend.
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin === ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Vary", "Origin");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, PATCH, DELETE, OPTIONS"
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`API running on port ${PORT}`);
});
