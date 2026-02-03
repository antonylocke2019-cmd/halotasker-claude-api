/**
 * HaloTasker AI Backend
 * - Lovable Edge compatible
 * - File understanding (docs + images)
 * - Balanced / Quick / Deep modes
 * - Always returns HTTP 200
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

const ALLOW_DEEP = process.env.ALLOW_OPUS === "true";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY");
  process.exit(1);
}

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Thinking modes
const THINKING_MODES = {
  quick: {
    model: "claude-haiku-4-20250514",
    maxTokens: 512,
    description: "Fast, short answers"
  },
  balanced: {
    model: "claude-sonnet-4-20250514",
    maxTokens: 1024,
    description: "Balanced reasoning"
  },
  deep: {
    model: "claude-opus-4-20250514",
    maxTokens: 2048,
    description: "Deep reasoning",
    enabled: ALLOW_DEEP
  }
};

// -----------------------------------------------------------------------------
// App setup
// -----------------------------------------------------------------------------

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "4mb" }));

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

    // Build Claude content blocks (text + images + documents)
    const content = [{ type: "text", text: message }];

    if (Array.isArray(attachments)) {
      attachments.forEach(file => {
        // Vision (images)
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
        "You are HaloTasker AI. Use uploaded files and images as authoritative context when provided. Be clear, accurate, and helpful."
    });

    const text =
      response?.content?.[0]?.text ||
      "Sorry, I couldn’t generate a response.";

    return res.json({
      reply: text,
      thinkingMode
    });
  } catch (err) {
    console.error("Claude error:", err);

    return res.json({
      reply: "Sorry, something went wrong. Please try again."
    });
  }
});

// -----------------------------------------------------------------------------
// Start
// -----------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log("HaloTasker AI backend running");
});
