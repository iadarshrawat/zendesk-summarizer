import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { ChromaClient } from "chromadb";

dotenv.config();

/* ================= APP SETUP ================= */

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

/* ================= VALIDATION ================= */

if (!process.env.GEMINI_API_KEY) {
  console.error("❌ GEMINI_API_KEY missing");
  process.exit(1);
}

/* ================= GEMINI ================= */

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/* ================= CHROMA ================= */

const COLLECTION_NAME = "zendesk_kb";

const chroma = new ChromaClient({
  path: "http://localhost:8000",
});

let collectionCache = null;

async function initializeCollection() {
  try {
    // Try to delete existing collection to start fresh
    try {
      await chroma.deleteCollection({ name: COLLECTION_NAME });
      console.log("🗑️ Deleted old collection");
    } catch (e) {
      // Collection doesn't exist, that's fine
    }

    // Create new collection without any embedding function
    const collection = await chroma.createCollection({
      name: COLLECTION_NAME,
      metadata: { source: "zendesk_kb" },
    });

    console.log("✅ Created fresh collection:", COLLECTION_NAME);
    collectionCache = collection;
    return collection;
  } catch (err) {
    console.error("❌ Failed to initialize collection:", err);
    throw err;
  }
}

async function getCollection() {
  if (!collectionCache) {
    collectionCache = await initializeCollection();
  }
  return collectionCache;
}

/* ================= EMBEDDING ================= */

async function embedText(text) {
  const model = genAI.getGenerativeModel({ model: "text-embedding-004" });
  const result = await model.embedContent(text);
  return result.embedding.values;
}

/* ================= PROMPTS ================= */

function buildSummaryPrompt(ticket) {
  const customFieldsText =
    Object.keys(ticket.customFields || {}).length > 0
      ? Object.entries(ticket.customFields)
          .map(([id, value]) => `- ${id}: ${value}`)
          .join("\n")
      : "No custom fields used";

  return `
You are an AI support assistant.

Summarize the Zendesk ticket below.

------------------------
Ticket ID: ${ticket.ticketId}
Form: ${ticket.ticketFormName || "N/A"}

Subject:
${ticket.subject || "N/A"}

Description:
${ticket.description || "N/A"}

Custom Fields:
${customFieldsText}
------------------------

Provide:
1. Short summary (2–3 lines)
2. Main customer issue
3. Recommended next action
`;
}

function buildReplyPrompt(ticket, tone, kbChunks) {
  return `
You are a Zendesk support agent.

Use ONLY the information from the knowledge base below.
If the KB does not contain the answer, say:
"I will check this and get back to you."

Tone: ${tone}

====================
Knowledge Base:
${kbChunks}
====================

Ticket Subject:
${ticket.subject}

Customer Message:
${ticket.description}

Rules:
- No hallucinations
- No invented steps
- Clear and helpful
- Ready to send
`;
}

/* ================= TICKET SUMMARIZATION ================= */

app.post("/summarize", async (req, res) => {
  try {
    const ticket = req.body;

    if (!ticket.ticketId) {
      return res.status(400).json({ error: "Invalid ticket payload - ticketId required" });
    }

    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });

    let prompt = buildSummaryPrompt(ticket);

    if (ticket.language) {
      prompt += `\nPlease provide the summary in ${ticket.language} language.`;
    }

    console.log("📝 Generating summary for ticket:", ticket.ticketId);

    const result = await model.generateContent(prompt);
    const summary = result.response.text();

    res.json({
      summary,
      ticketId: ticket.ticketId,
    });
  } catch (error) {
    console.error("❌ Summarization failed:", error);
    res.status(500).json({
      error: "Failed to generate summary",
      details: error.message
    });
  }
});

/* ================= KB INGESTION ================= */

app.post("/ingest-kb", async (req, res) => {
  try {
    const { articles } = req.body;
    if (!Array.isArray(articles)) {
      return res.status(400).json({ error: "articles array required" });
    }

    const collection = await getCollection();

    for (const article of articles) {
      const cleanText = article.content.replace(/<[^>]+>/g, "").slice(0, 2000);
      const embedding = await embedText(cleanText);

      await collection.add({
        ids: [`article-${article.id}`],
        documents: [cleanText],
        metadatas: [{ title: article.title }],
        embeddings: [embedding],
      });
    }

    console.log(`✅ Ingested ${articles.length} articles into Chroma`);
    res.json({ status: "KB ingested successfully", count: articles.length });
  } catch (err) {
    console.error("❌ KB ingestion error:", err);
    res.status(500).json({ error: "KB ingestion failed", details: err.message });
  }
});

/* ================= RAG REPLY ================= */

app.post("/compose-reply", async (req, res) => {
  try {
    const ticket = req.body;

    if (!ticket.subject || !ticket.description) {
      return res.status(400).json({ error: "Invalid ticket payload - subject and description required" });
    }

    const collection = await getCollection();

    const queryEmbedding = await embedText(`${ticket.subject} ${ticket.description}`);

    const results = await collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: 3,
    });

    const kbChunks = (results.documents?.[0] || []).join("\n\n") || "No relevant knowledge base found.";

    const prompt = buildReplyPrompt(ticket, ticket.tone || "professional", kbChunks);

    console.log("🤖 Generating reply for ticket:", ticket.ticketId);

    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
    const response = await model.generateContent(prompt);

    res.json({
      ticketId: ticket.ticketId,
      reply: response.response.text(),
    });
  } catch (err) {
    console.error("❌ RAG reply error:", err);
    res.status(500).json({ error: "RAG reply failed", details: err.message });
  }
});

/* ================= DEBUG: TEST SEARCH ================= */

app.post("/debug-search", async (req, res) => {
  try {
    const { query } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: "query required" });
    }

    const collection = await getCollection();
    const queryEmbedding = await embedText(query);

    const results = await collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: 5,
    });

    res.json({
      query: query,
      results: {
        documents: results.documents?.[0] || [],
        metadatas: results.metadatas?.[0] || [],
        distances: results.distances?.[0] || [],
      }
    });
  } catch (err) {
    console.error("❌ Debug search error:", err);
    res.status(500).json({ error: "Debug search failed", details: err.message });
  }
});

/* ================= RESET KB ================= */

app.delete("/reset-kb", async (req, res) => {
  try {
    await chroma.deleteCollection({ name: COLLECTION_NAME });
    collectionCache = null;
    console.log("🗑️ Deleted collection:", COLLECTION_NAME);
    
    // Recreate
    await initializeCollection();
    
    res.json({ status: "KB reset successfully" });
  } catch (err) {
    console.error("❌ Reset error:", err);
    res.status(500).json({ error: "Reset failed", details: err.message });
  }
});

/* ================= HEALTH ================= */

app.get("/health", (_, res) => {
  res.json({ status: "ok" });
});

/* ================= START ================= */

async function startServer() {
  try {
    // Initialize collection on startup
    await initializeCollection();
    
    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log(`📚 Collection "${COLLECTION_NAME}" ready`);
      console.log(`\nAvailable endpoints:`);
      console.log(`  POST /summarize - Summarize a ticket`);
      console.log(`  POST /compose-reply - Generate RAG-based reply`);
      console.log(`  POST /ingest-kb - Ingest knowledge base articles`);
      console.log(`  POST /debug-search - Debug article search`);
      console.log(`  DELETE /reset-kb - Reset knowledge base`);
      console.log(`  GET /health - Health check`);
    });
  } catch (err) {
    console.error("❌ Failed to start server:", err);
    process.exit(1);
  }
}

startServer();