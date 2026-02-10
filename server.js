/**
 * HaloTasker Claude API – Stable Production Server
 * FIXES:
 * - Prevents long replies being cut off
 * - Detects truncated responses
 * - Supports images + files
 * - Works with Lovable multipart requests
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

// IMPORTANT: allow long outputs
const MAX_OUTPUT_TOKENS = 8192;

// --------------------------------------------------
// MIDDLEWARE
// --------------------------------------------------

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: "4mb" }));

app.use(
  rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false
  })
);

// Multer for images/files
const upload = multer({
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

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
            .slice(0, 12000)}`
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

app.post("/api/chat", upload.array("files"), async (req, res) => {
  try {
    // Lovable sends different keys depending on context
    const message =
      req.body.message ||
      req.body.prompt ||
      req.body.input ||
      req.body.text ||
      "";

    const history = req.body.history
      ? JSON.parse(req.body.history)
      : [];

    const model = req.body.model || DEFAULT_MODEL;

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
      max_tokens: MAX_OUTPUT_TOKENS,
      messages
    });

    const reply =
      response.content?.find(c => c.type === "text")?.text || "";

    const truncated = response.stop_reason === "max_tokens";

    res.json({
      reply,
      truncated,
      usage: response.usage
    });
  } catch (err) {
    console.error("❌ Claude API error:", err);
    res.status(500).json({
      error: "Claude request failed"
    });
  }
});

// --------------------------------------------------
// START
// --------------------------------------------------

app.listen(PORT, () => {
  console.log(`🚀 HaloTasker Claude API running on port ${PORT}`);
});
