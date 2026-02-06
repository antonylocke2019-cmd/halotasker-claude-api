import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
app.set("trust proxy", 1);

/**
 * HaloTasker Claude API – Stable Production Server
 * Supports: Opus 4.6 (when available), Sonnet fallback, history, cost tracking
 */

// -----------------------------------------------------------------------------
// CONFIG
// -----------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.error("ANTHROPIC_API_KEY missing");
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: API_KEY });

// ✅ REAL API MODELS
const MODELS = {
  OPUS: "claude-opus-4-6",
  SONNET: "claude-3-5-sonnet-20241022",
  HAIKU: "claude-3-haiku-20240307"
};

// Pricing per 1M tokens (USD)
const PRICING = {
  [MODELS.OPUS]: { input: 5.0, output: 25.0 },
  [MODELS.SONNET]: { input: 3.0, output: 15.0 },
  [MODELS.HAIKU]: { input: 0.25, output: 1.25 }
};

const DEFAULT_MODEL = MODELS.SONNET;

// -----------------------------------------------------------------------------
// MIDDLEWARE
// -----------------------------------------------------------------------------

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "1mb" }));

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

  const input =
    (usage.input_tokens / 1_000_000) * PRICING[model].input;
  const output =
    (usage.output_tokens / 1_000_000) * PRICING[model].output;

  return Number((input + output).toFixed(4));
}

function sanitizeHistory(history = []) {
  if (!Array.isArray(history)) return [];

  return history
    .filter(
      h =>
        h &&
        (h.role === "user" || h.role === "assistant") &&
        typeof h.content === "string" &&
        h.content.trim().length
    )
    .map(h => ({
      role: h.role,
      content: [{ type: "text", text: h.content }]
    }));
}

// -----------------------------------------------------------------------------
// ROUTES
// -----------------------------------------------------------------------------

app.get("/", (_, res) => {
  res.json({
    status: "ok",
    defaultModel: DEFAULT_MODEL,
    availableModels: Object.values(MODELS)
  });
});

app.post("/api/chat", async (req, res) => {
  try {
    const {
      message,
      history = [],
      model = DEFAULT_MODEL,
      sessionCost = 0,
      balance = 10
    } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message is required" });
    }

    const messages = [
      ...sanitizeHistory(history),
      {
        role: "user",
        content: [{ type: "text", text: message }]
      }
    ];

    let selectedModel = PRICING[model] ? model : DEFAULT_MODEL;
    let response;

    try {
      response = await anthropic.messages.create({
        model: selectedModel,
        max_tokens: 1024,
        messages
      });
    } catch (err) {
      // 🔁 Fallback if Opus not enabled
      if (
        selectedModel === MODELS.OPUS &&
        err?.status === 404
      ) {
        response = await anthropic.messages.create({
          model: DEFAULT_MODEL,
          max_tokens: 1024,
          messages
        });
        selectedModel = DEFAULT_MODEL;
      } else {
        throw err;
      }
    }

    const reply =
      response.content?.find(c => c.type === "text")?.text || "";

    const lastCost = estimateCost(selectedModel, response.usage);
    const newSessionCost = Number(
      (Number(sessionCost) + lastCost).toFixed(4)
    );
    const newBalance = Number(
      Math.max(0, Number(balance) - lastCost).toFixed(4)
    );

    res.json({
      reply,
      modelUsed: selectedModel,
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
});

// -----------------------------------------------------------------------------
// START
// -----------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`🚀 HaloTasker Claude API running on port ${PORT}`);
});
