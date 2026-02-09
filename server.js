/**
 * HaloTasker Claude API – Edge-safe Production Server
 * Default model: Claude Opus 4.6
 * Supports: text, images, files, extended thinking, cost tracking
 */

import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import Anthropic from "@anthropic-ai/sdk";

const app = express();

/* -------------------------------------------------------------------------- */
/* TRUST PROXY (REQUIRED FOR RAILWAY + EDGE)                                   */
/* -------------------------------------------------------------------------- */
app.set("trust proxy", 1);

/* -------------------------------------------------------------------------- */
/* FILE UPLOAD CONFIG                                                          */
/* -------------------------------------------------------------------------- */
const upload = multer({
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

/* -------------------------------------------------------------------------- */
/* ENV                                                                         */
/* -------------------------------------------------------------------------- */
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.error("❌ Missing ANTHROPIC_API_KEY");
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: API_KEY });

/* -------------------------------------------------------------------------- */
/* MODELS + PRICING                                                            */
/* -------------------------------------------------------------------------- */
const MODELS = {
  OPUS: "claude-opus-4-6",
  SONNET: "claude-3-5-sonnet-20241022",
  HAIKU: "claude-3-haiku-20240307"
};

const DEFAULT_MODEL = MODELS.SONNET; // safest default

const PRICING = {
  [MODELS.OPUS]: { input: 5.0, output: 25.0 },
  [MODELS.SONNET]: { input: 3.0, output: 15.0 },
  [MODELS.HAIKU]: { input: 0.25, output: 1.25 }
};

/* -------------------------------------------------------------------------- */
/* MIDDLEWARE                                                                  */
/* -------------------------------------------------------------------------- */
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: "*", credentials: false }));
app.use(express.json({ limit: "2mb" }));

app.use(
  rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false
  })
);

/* -------------------------------------------------------------------------- */
/* HELPERS                                                                     */
/* -------------------------------------------------------------------------- */
function estimateCost(model, usage) {
  if (!usage || !PRICING[model]) return 0;

  const input =
    (usage.input_tokens || 0) / 1_000_000 * PRICING[model].input;
  const output =
    (usage.output_tokens || 0) / 1_000_000 * PRICING[model].output;

  return Number((input + output).toFixed(4));
}

function buildContent(message, files) {
  const content = [];

  if (message) {
    content.push({ type: "text", text: message });
  }

  if (files?.length) {
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
      } else {
        content.push({
          type: "text",
          text: `File: ${file.originalname}\n\n${file.buffer
            .toString("utf8")
            .slice(0, 12_000)}`
        });
      }
    }
  }

  return content;
}

/* -------------------------------------------------------------------------- */
/* ROUTES                                                                      */
/* -------------------------------------------------------------------------- */
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
      /* -------------------------------------------------------------------- */
      /* BE VERY TOLERANT OF FRONTEND PAYLOADS                                 */
      /* -------------------------------------------------------------------- */
      const message =
        req.body.message ||
        req.body.prompt ||
        req.body.input ||
        "";

      const history = Array.isArray(req.body.history)
        ? req.body.history
        : [];

      const model =
        Object.values(MODELS).includes(req.body.model)
          ? req.body.model
          : DEFAULT_MODEL;

      const extendedThinking = Boolean(req.body.extendedThinking);
      const sessionCost = Number(req.body.sessionCost || 0);
      const balance = Number(req.body.balance || 10);

      /* -------------------------------------------------------------------- */
      /* NEVER FAIL HARD – EDGE SAFE                                           */
      /* -------------------------------------------------------------------- */
      if (!message && !req.files?.length) {
        return res.json({
          reply: "Please enter a message or attach a file.",
          usage: null,
          costs: {
            last: 0,
            session: sessionCost,
            balance
          }
        });
      }

      const messages = [];

      for (const h of history) {
        if (h?.role && h?.content) {
          messages.push({
            role: h.role,
            content: [{ type: "text", text: String(h.content) }]
          });
        }
      }

      messages.push({
        role: "user",
        content: buildContent(message, req.files)
      });

      const response = await anthropic.messages.create({
        model,
        max_tokens: 4096,
        messages,
        thinking: extendedThinking ? { type: "extended" } : undefined
      });

      const reply =
        response.content?.find(c => c.type === "text")?.text ||
        "No response.";

      const lastCost = estimateCost(model, response.usage);
      const newSessionCost = Number(
        (sessionCost + lastCost).toFixed(4)
      );
      const newBalance = Number(
        Math.max(0, balance - lastCost).toFixed(4)
      );

      return res.json({
        reply,
        usage: response.usage || null,
        costs: {
          last: lastCost,
          session: newSessionCost,
          balance: newBalance
        }
      });
    } catch (err) {
      console.error("Claude API error:", err);

      /* -------------------------------------------------------------------- */
      /* EDGE FUNCTIONS MUST GET 200                                           */
      /* -------------------------------------------------------------------- */
      return res.json({
        reply:
          "The AI service is temporarily unavailable. Please try again.",
        usage: null,
        costs: {
          last: 0,
          session: Number(req.body?.sessionCost || 0),
          balance: Number(req.body?.balance || 10)
        }
      });
    }
  }
);

/* -------------------------------------------------------------------------- */
/* START                                                                       */
/* -------------------------------------------------------------------------- */
app.listen(PORT, () => {
  console.log(`🚀 HaloTasker Claude API running on port ${PORT}`);
});
