/**
 * HaloTasker Claude Chat - Backend API
 * Deploy this to Railway, then connect from your Lovable frontend
 */

import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';

// ==========================================================================
// Configuration
// ==========================================================================

const CONFIG = {
    port: process.env.PORT || 3000,
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
    maxTokens: parseInt(process.env.MAX_TOKENS, 10) || 4096,
    maxInputTokens: parseInt(process.env.MAX_INPUT_TOKENS, 10) || 100000,
    rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60000,
    rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 20,
    maxMessageLength: 32000,
    maxHistoryMessages: 50,
    allowedOrigins: process.env.ALLOWED_ORIGINS 
        ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
        : ['http://localhost:3000', 'http://localhost:5173'],
    isDev: process.env.NODE_ENV !== 'production'
};

// Validate API key
if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌ ANTHROPIC_API_KEY environment variable is required');
    process.exit(1);
}

// Initialize Anthropic
const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
});

// ==========================================================================
// Express Setup
// ==========================================================================

const app = express();

// Security
app.use(helmet({ contentSecurityPolicy: false }));

// CORS - Allow your Lovable frontend
app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (CONFIG.allowedOrigins.includes(origin) || CONFIG.isDev) {
            callback(null, true);
        } else {
            console.log(`CORS blocked: ${origin}`);
            callback(new Error('CORS not allowed'));
        }
    },
    credentials: true
}));

// Body parsing
app.use(express.json({ limit: '1mb' }));

// Request logging
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
});

// Rate limiting
const limiter = rateLimit({
    windowMs: CONFIG.rateLimitWindowMs,
    max: CONFIG.rateLimitMaxRequests,
    message: { error: 'Too many requests. Please wait.' },
    standardHeaders: true,
    legacyHeaders: false
});

app.use('/api/', limiter);

// ==========================================================================
// API Routes
// ==========================================================================

// Health check
app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'HaloTasker Claude API' });
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        model: CONFIG.model
    });
});

// Chat endpoint with streaming
app.post('/api/chat', async (req, res) => {
    try {
        const { message, history = [] } = req.body;
        
        // Validate message
        if (!message || typeof message !== 'string') {
            return res.status(400).json({ error: 'Message is required' });
        }
        
        if (message.length > CONFIG.maxMessageLength) {
            return res.status(400).json({ error: 'Message too long' });
        }
        
        if (!message.trim()) {
            return res.status(400).json({ error: 'Message cannot be empty' });
        }
        
        // Sanitize history
        const sanitizedHistory = Array.isArray(history) 
            ? history
                .slice(-CONFIG.maxHistoryMessages)
                .filter(msg => 
                    msg && 
                    ['user', 'assistant'].includes(msg.role) &&
                    typeof msg.content === 'string' &&
                    msg.content.length <= CONFIG.maxMessageLength
                )
                .map(msg => ({
                    role: msg.role,
                    content: msg.content.trim()
                }))
            : [];
        
        // Build messages
        const messages = [
            ...sanitizedHistory,
            { role: 'user', content: message.trim() }
        ];
        
        // Set SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        
        // Stream from Claude
        const stream = anthropic.messages.stream({
            model: CONFIG.model,
            max_tokens: CONFIG.maxTokens,
            messages: messages,
            system: `You are a helpful AI assistant for HaloTasker. Be helpful, professional, and concise. Use markdown formatting when appropriate.`
        });
        
        stream.on('text', (text) => {
            res.write(`data: ${JSON.stringify({ type: 'content', text })}\n\n`);
        });
        
        stream.on('error', (error) => {
            console.error('Stream error:', error);
            res.write(`data: ${JSON.stringify({ type: 'error', message: 'An error occurred' })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        });
        
        stream.on('end', () => {
            res.write('data: [DONE]\n\n');
            res.end();
        });
        
        req.on('close', () => {
            stream.abort();
        });
        
        await stream.finalMessage();
        
    } catch (error) {
        console.error('Chat error:', error);
        
        if (!res.headersSent) {
            res.status(500).json({ error: 'An error occurred' });
        } else {
            res.write(`data: ${JSON.stringify({ type: 'error', message: 'An error occurred' })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        }
    }
});

// ==========================================================================
// Start Server
// ==========================================================================

app.listen(CONFIG.port, () => {
    console.log(`
🚀 HaloTasker Claude API running on port ${CONFIG.port}
📡 Allowed origins: ${CONFIG.allowedOrigins.join(', ')}
🤖 Model: ${CONFIG.model}
    `);
});
