/**
 * HaloTasker Claude API – Stable Production Server
 * Supports:
 * - Text + image uploads
 * - Claude Opus 4.6 / Sonnet / Haiku
 * - Lovable multipart requests
 * - Cost tracking
 */

import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
app.set("trust proxy", 1);

// --------------------------------------------------
// CONFIG
// --------------------------------------------------

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.error("❌ Missing ANTHROPIC_API_KEY");
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: API_KEY });

// Claude models
const MODELS = {
  OPUS: "claude-opus-4-6",
  SONNET: "claude-3-5-sonnet-20241022",
  HAIKU: "claude-3-haiku-20240307"
};

const DEFAULT_MODEL = MODELS.SONNET;

// Pricing per 1M tokens (USD)
const PRICING = {
  [MODELS.OPUS]: { input: 5.0, output: 25.0 },
  [MODELS.SONNET]: { input: 3.0, output: 15.0 },
  [MODELS.HAIKU]: { input: 0.25, output: 1.25 }
};

// --------------------------------------------------
// MIDDLEWARE
// --------------------------------------------------

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.use(
  rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false
  })
);

// Multer for Lovable file uploads
const upload = multer({
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function estimateCost(model, usage) {
  if (!usage || !PRICING[model]) return 0;

  const input =
    (usage.input_tokens / 1_000_000) * PRICING[model].input;
  const output =
    (usage.output_tokens / 1_000_000) * PRICING[model].output;

  return Number((input + output).toFixed(4));
}

function buildUserContent({ message, files }) {
  const content = [];

  if (message?.trim()) {
    content.push({ type: "text", text: message });
  }

  if (files?.length) {
    for (const file of files) {
      if (file.mimetype.startsWith("image/")) {
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: file.mimetype,
            data: file.buffer.toString("base64")
          }
        });
      } else {
        content.push({
          type: "text",
          text: `Attached file (${file.originalname}):\n${file.buffer
            .toString("utf8")
            .slice(0, 12_000)}`
        });
      }
    }
  }

  return content;
}

// --------------------------------------------------
// ROUTES
// --------------------------------------------------

app.get("/", (_, res) => {
  res.json({
    status: "ok",
    defaultModel: DEFAULT_MODEL,
    availableModels: Object.values(MODELS)
  });
});

app.post(
  "/api/chat",
  upload.array("files"),
  async (req, res) => {
    try {
      // IMPORTANT: Lovable sends different keys when files exist
      const message =
        req.body.message ||
        req.body.prompt ||
        req.body.input ||
        req.body.content ||
        req.body.text ||
        "";

      const history = req.body.history
        ? JSON.parse(req.body.history)
        : [];

      const model = req.body.model || DEFAULT_MODEL;
      const extendedThinking = req.body.extendedThinking === "true";

      if (!message && !req.files?.length) {
        return res.status(400).json({
          error: "Message or file required"
        });
      }

      const messages = [];

      for (const h of history) {
        messages.push({
          role: h.role,
          content: [{ type: "text", text: h.content }]
        });
      }

      messages.push({
        role: "user",
        content: buildUserContent({
          message,
          files: req.files
        })
      });

      const response = await anthropic.messages.create({
        model,
        max_tokens: 4096,
        messages,
        thinking: extendedThinking ? { type: "extended" } : undefined
      });

      const reply =
        response.content?.find(c => c.type === "text")?.text || "";

      const lastCost = estimateCost(model, response.usage);

      res.json({
        reply,
        usage: response.usage,
        cost: lastCost
      });
    } catch (err) {
      console.error("❌ Claude error:", err);
      res.status(500).json({
        error: "Claude request failed"
      });
    }
  }
);

// --------------------------------------------------
// START
// --------------------------------------------------

app.listen(PORT, () => {
  console.log(`🚀 HaloTasker Claude API running on ${PORT}`);
});
