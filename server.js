/**
 * HaloTasker AI Backend
 * - File understanding (images + documents)
 * - Thinking modes (quick / balanced / deep)
 * - Usage tracking:
 *   - Last message cost
 *   - Session total cost
 *   - Remaining balance
 * - Lovable + Railway compatible
 */

import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import Anthropic from "@anthropic-ai/sdk";

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;

// Allowed frontend origins
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(o => o.trim())
  : [];

// Enable deep reasoning (Opus)
const ALLOW_DEEP = process.env.ALLOW_OPUS === "true";

// Monthly/session budget you control
const SESSION_BUDGET_GBP = 10.0;

// Pricing per 1,000,000 tokens (GBP – estimated)
const PRICING = {
  "claude-haiku-4-20250514": { input: 0.25, output: 1.25 },
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
  "claude-opus-4-20250514": { input: 15.0, output: 75.0 }
};

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is missing");
  process.exit(1);
}

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Thinking modes
const THINKING_MODES = {
  quick: {
    model: "claude-haiku-4-20250514",
    maxTokens: 512
  },
  balanced: {
    model: "claude-sonnet-4-20250514",
    maxTokens: 1024
  },
  deep: {
    model: "claude-opus-4-20250514",
    maxTokens: 2048,
    enabled: ALLOW_DEEP
  }
};

// -----------------------------------------------------------------------------
// App setup
// -----------------------------------------------------------------------------

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "6mb" }));

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true
  })
);

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 25
  })
);

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    modes: Object.keys(THINKING_MODES),
    deepEnabled: ALLOW_DEEP
  });
});

app.post("/api/chat", async (req, res) => {
  try {
    const {
      message,
      history = [],
      thinkingMode = "balanced",
      attachments = []
    } = req.body;

    if (!message || typeof message !== "string") {
      return res.json({ reply: "Please enter a valid message." });
    }

    const mode =
      THINKING_MODES[thinkingMode] &&
      (thinkingMode !== "deep" || ALLOW_DEEP)
        ? THINKING_MODES[thinkingMode]
        : THINKING_MODES.balanced;

    // Build multimodal content (text + images + documents)
    const content = [{ type: "text", text: message }];

    if (Array.isArray(attachments)) {
      attachments.forEach(file => {
        // Image vision
        if (
          file.type &&
          file.type.startsWith("image/") &&
          file.base64
        ) {
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: file.type,
              data: file.base64
            }
          });
        }

        // Text documents
        if (file.content && typeof file.content === "string") {
          content.push({
            type: "text",
            text: `\n\n--- ${file.name} ---\n${file.content.slice(0, 15000)}`
          });
        }
      });
    }

    const messages = [
      ...Array.isArray(history)
        ? history.filter(
            m =>
              m &&
              (m.role === "user" || m.role === "assistant") &&
              typeof m.content === "string"
          )
        : [],
      {
        role: "user",
        content
      }
    ];

    const response = await anthropic.messages.create({
      model: mode.model,
      max_tokens: mode.maxTokens,
      messages,
      system:
        "You are HaloTasker AI. Use uploaded files and images as authoritative context when provided. Be accurate, clear, and helpful."
    });

    const replyText =
      response?.content?.[0]?.text ||
      "Sorry, I couldn’t generate a response.";

    // -------------------------------------------------------------------------
    // Usage & cost calculation
    // -------------------------------------------------------------------------

    const usage = response.usage || { input_tokens: 0, output_tokens: 0 };
    const pricing = PRICING[mode.model] || { input: 0, output: 0 };

    const lastMessageCostGBP =
      (usage.input_tokens / 1_000_000) * pricing.input +
      (usage.output_tokens / 1_000_000) * pricing.output;

    // In-memory session tracking (Lovable-safe)
    req.sessionUsage = req.sessionUsage || { total: 0 };
    req.sessionUsage.total += lastMessageCostGBP;

    const remainingGBP = Math.max(
      0,
      SESSION_BUDGET_GBP - req.sessionUsage.total
    );

    return res.json({
      reply: replyText,
      thinkingMode,
      usage: {
        lastMessageGBP: Number(lastMessageCostGBP.toFixed(4)),
        sessionTotalGBP: Number(req.sessionUsage.total.toFixed(2)),
        remainingGBP: Number(remainingGBP.toFixed(2))
      }
    });
  } catch (err) {
    console.error("Claude error:", err);

    return res.json({
      reply: "Sorry, something went wrong. Please try again."
    });
  }
});

// -----------------------------------------------------------------------------
// Start server
// -----------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log("HaloTasker AI backend running");
});
