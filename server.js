const app = express();
app.set("trust proxy", 1);
/**
 * HaloTasker Claude API – Production Server
 * Default model: Opus 4.6
 * Supports: extended thinking, files, images, cost tracking
 */

import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB

// -----------------------------------------------------------------------------
// ENV + CONFIG
// -----------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.error("ANTHROPIC_API_KEY is missing");
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: API_KEY });

// Pricing (approx USD per 1M tokens – conservative)
const PRICING = {
  "opus-4.6": { input: 15.0, output: 75.0 },
  "sonnet-4.5": { input: 3.0, output: 15.0 },
  "haiku-4.5": { input: 0.25, output: 1.25 }
};

const DEFAULT_MODEL = "opus-4.6";

// -----------------------------------------------------------------------------
// MIDDLEWARE
// -----------------------------------------------------------------------------

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.use(
  rateLimit({
    windowMs: 60_000,
    max: 30
  })
);

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function estimateCost(model, usage) {
  if (!usage || !PRICING[model]) return 0;

  const inputCost =
    (usage.input_tokens / 1_000_000) * PRICING[model].input;
  const outputCost =
    (usage.output_tokens / 1_000_000) * PRICING[model].output;

  return Number((inputCost + outputCost).toFixed(4));
}

function buildClaudeContent({ message, files }) {
  const content = [];

  if (message) {
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

// -----------------------------------------------------------------------------
// ROUTES
// -----------------------------------------------------------------------------

app.get("/", (_, res) => {
  res.json({ status: "ok", model: DEFAULT_MODEL });
});

app.post(
  "/api/chat",
  upload.array("files"),
  async (req, res) => {
    try {
      const {
        message,
        history = [],
        model = DEFAULT_MODEL,
        extendedThinking = false,
        sessionCost = 0,
        balance = 10
      } = req.body;

      if (!message && !req.files?.length) {
        return res.status(400).json({ error: "Message or file required" });
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
        content: buildClaudeContent({
          message,
          files: req.files
        })
      });

      const response = await anthropic.messages.create({
        model,
        max_tokens: 4096,
        thinking: extendedThinking ? { type: "extended" } : undefined,
        messages
      });

      const reply =
        response.content?.find(c => c.type === "text")?.text ||
        "";

      const lastCost = estimateCost(model, response.usage);
      const newSessionCost = Number(
        (Number(sessionCost) + lastCost).toFixed(4)
      );
      const newBalance = Number(
        Math.max(0, Number(balance) - lastCost).toFixed(4)
      );

      res.json({
        reply,
        usage: response.usage,
        costs: {
          last: lastCost,
          session: newSessionCost,
          balance: newBalance
        }
      });
    } catch (err) {
      console.error("Claude API error:", err);
      res.status(500).json({
        error: "Claude request failed"
      });
    }
  }
);

// -----------------------------------------------------------------------------
// START
// -----------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`🚀 HaloTasker Claude API running on port ${PORT}`);
});
