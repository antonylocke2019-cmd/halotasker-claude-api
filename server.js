/**
 * HaloTasker Claude API – Hardened Production Server
 * Fixes Claude request failed errors
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

const MODELS = {
  OPUS: "claude-opus-4-6",
  SONNET: "claude-3-5-sonnet-20241022",
  HAIKU: "claude-3-haiku-20240307"
};

const DEFAULT_MODEL = MODELS.SONNET;

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

const upload = multer({
  limits: { fileSize: 10 * 1024 * 1024 }
});

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function safeText(text) {
  return typeof text === "string" && text.trim()
    ? text.trim()
    : null;
}

function normaliseHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .filter(h => h && h.role && h.content)
    .map(h => ({
      role: h.role === "assistant" ? "assistant" : "user",
      content: [{ type: "text", text: String(h.content) }]
    }));
}

function buildUserContent(message, files) {
  const content = [];

  const text = safeText(message);
  if (text) {
    content.push({ type: "text", text });
  }

  if (Array.isArray(files)) {
    for (const file of files) {
      if (file.mimetype?.startsWith("image/")) {
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: file.mimetype,
            data: file.buffer.toString("base64")
          }
        });
      }
    }
  }

  if (!content.length) {
    content.push({ type: "text", text: " " });
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
    const message =
      req.body.message ||
      req.body.prompt ||
      req.body.text ||
      "";

    const history = req.body.history
      ? JSON.parse(req.body.history)
      : [];

    const model = Object.values(MODELS).includes(req.body.model)
      ? req.body.model
      : DEFAULT_MODEL;

    const messages = [
      ...normaliseHistory(history),
      {
        role: "user",
        content: buildUserContent(message, req.files)
      }
    ];

    const response = await anthropic.messages.create({
      model,
      max_tokens: 4096,
      messages
    });

    const reply =
      response.content?.find(c => c.type === "text")?.text || "";

    res.json({
      reply,
      usage: response.usage
    });

  } catch (err) {
    console.error("❌ Claude failure:", err);
    res.status(500).json({
      error: "Claude request failed"
    });
  }
});

// --------------------------------------------------
// START
// --------------------------------------------------

app.listen(PORT, () => {
  console.log(`🚀 HaloTasker Claude API running on ${PORT}`);
});
