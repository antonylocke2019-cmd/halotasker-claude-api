/**
 * HaloTasker Claude Chat API
 * Railway + Lovable compatible
 * - Non-streaming
 * - Always returns 200
 * - Supports model selection (Opus / Sonnet / Haiku)
 */

import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import Anthropic from "@anthropic-ai/sdk";

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(o => o.trim())
  : [];

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is missing");
  process.exit(1);
}

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Claude model mapping (friendly → real)
const MODEL_MAP = {
  opus: "claude-opus-4-20250514",
  sonnet: "claude-sonnet-4-20250514",
  haiku: "claude-haiku-4-20250514"
};

// -----------------------------------------------------------------------------
// App setup
// -----------------------------------------------------------------------------

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: true
  })
);

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false
});

app.use("/api/", limiter);

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "HaloTasker Claude API" });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    models: ["opus", "sonnet", "haiku"],
    default_model: "sonnet"
  });
});

app.post("/api/chat", async (req, res) => {
  try {
    const { message, history = [], model } = req.body;

    if (!message || typeof message !== "string") {
      return res.json({
        reply: "Please enter a valid message."
      });
    }

    const selectedModel = MODEL_MAP[model] || MODEL_MAP.sonnet;

    const messages = [
      ...Array.isArray(history)
        ? history.filter(
            m =>
              m &&
              (m.role === "user" || m.role === "assistant") &&
              typeof m.content === "string"
          )
        : [],
      { role: "user", content: message.trim() }
    ];

    const response = await anthropic.messages.create({
      model: selectedModel,
      max_tokens: 1024,
      messages,
      system:
        "You are a helpful, professional AI assistant for HaloTasker. Be clear, concise, and friendly."
    });

    const text =
      response?.content?.[0]?.text ||
      "Sorry, I didn’t get a response. Please try again.";

    return res.json({ reply: text });
  } catch (error) {
    console.error("Claude API error:", error);

    // IMPORTANT: Lovable requires HTTP 200 even on failure
    return res.json({
      reply: "Sorry, something went wrong. Please try again."
    });
  }
});

// -----------------------------------------------------------------------------
// Start server
// -----------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`HaloTasker Claude API running on port ${PORT}`);
});
