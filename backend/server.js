import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Pinecone } from "@pinecone-database/pinecone";

dotenv.config();

/* ================= APP SETUP ================= */

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

/* ================= VALIDATION ================= */

if (!process.env.GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY missing");
  process.exit(1);
}

if (!process.env.PINECONE_API_KEY) {
  console.error("PINECONE_API_KEY missing");
  console.error("Sign up at https://www.pinecone.io to get your free API key");
  process.exit(1);
}

/* ================= GEMINI ================= */

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/* ================= PINECONE ================= */

const INDEX_NAME = "zendesk-kb";

const pc = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY,
});

let indexCache = null;

async function initializeIndex() {
  try {
    // List existing indexes
    const indexList = await pc.listIndexes();
    const indexExists = indexList.indexes?.some(idx => idx.name === INDEX_NAME);

    if (!indexExists) {
      console.log(`📦 Creating new index: ${INDEX_NAME}`);
      console.log(`⏳ This may take 30-60 seconds...`);
      
      await pc.createIndex({
        name: INDEX_NAME,
        dimension: 768, // text-embedding-004 dimension
        metric: "cosine",
        spec: {
          serverless: {
            cloud: "aws",
            region: "us-east-1", // Free tier region
          },
        },
      });
      
      // Wait for index to be ready
      console.log("⏳ Waiting for index to be ready...");
      let ready = false;
      let attempts = 0;
      
      while (!ready && attempts < 30) {
        try {
          const indexDesc = await pc.describeIndex(INDEX_NAME);
          if (indexDesc.status?.ready) {
            ready = true;
          } else {
            await new Promise(resolve => setTimeout(resolve, 2000));
            attempts++;
          }
        } catch (e) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          attempts++;
        }
      }
      
      if (!ready) {
        throw new Error("Index creation timeout. Please try again.");
      }
    } else {
      console.log(`Index already exists: ${INDEX_NAME}`);
    }

    const index = pc.index(INDEX_NAME);
    indexCache = index;
    console.log("Index ready:", INDEX_NAME);
    return index;
  } catch (err) {
    console.error("❌ Failed to initialize index:", err);
    console.error("💡 Make sure your PINECONE_API_KEY is correct");
    throw err;
  }
}

async function getIndex() {
  if (!indexCache) {
    indexCache = await initializeIndex();
  }
  return indexCache;
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

Summarize the Zendesk ticket below in ${ticket.language || "English"}.

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

    if (articles.length === 0) {
      return res.status(400).json({ error: "articles array is empty" });
    }

    const index = await getIndex();

    console.log(`📚 Processing ${articles.length} articles...`);

    // Process in batches to avoid rate limits
    const batchSize = 10;
    let totalIngested = 0;

    for (let i = 0; i < articles.length; i += batchSize) {
      const batch = articles.slice(i, i + batchSize);
      const vectors = [];

      for (const article of batch) {
        const cleanText = article.content.replace(/<[^>]+>/g, "").slice(0, 2000);
        const embedding = await embedText(cleanText);

        vectors.push({
          id: `article-${article.id}`,
          values: embedding,
          metadata: {
            title: article.title,
            content: cleanText,
          },
        });
      }

      await index.upsert(vectors);
      totalIngested += vectors.length;
      console.log(`✅ Ingested ${totalIngested}/${articles.length} articles`);
    }

    console.log(`✅ Successfully ingested all ${articles.length} articles into Pinecone`);
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

    const index = await getIndex();

    const queryEmbedding = await embedText(`${ticket.subject} ${ticket.description}`);

    const results = await index.query({
      vector: queryEmbedding,
      topK: 3,
      includeMetadata: true,
    });

    const kbChunks = results.matches
      .map(match => match.metadata?.content || "")
      .filter(Boolean)
      .join("\n\n") || "No relevant knowledge base found.";

    const prompt = buildReplyPrompt(ticket, ticket.tone || "professional", kbChunks);

    console.log("🤖 Generating reply for ticket:", ticket.ticketId);

    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
    const response = await model.generateContent(prompt);

    res.json({
      ticketId: ticket.ticketId,
      reply: response.response.text(),
      sources: results.matches.map(m => m.metadata?.title).filter(Boolean),
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

    const index = await getIndex();
    const queryEmbedding = await embedText(query);

    const results = await index.query({
      vector: queryEmbedding,
      topK: 5,
      includeMetadata: true,
    });

    res.json({
      query: query,
      results: results.matches.map(match => ({
        id: match.id,
        score: match.score,
        title: match.metadata?.title,
        content: match.metadata?.content?.slice(0, 200) + "...",
      })),
    });
  } catch (err) {
    console.error("❌ Debug search error:", err);
    res.status(500).json({ error: "Debug search failed", details: err.message });
  }
});

/* ================= GET INDEX STATS ================= */

app.get("/index-stats", async (req, res) => {
  try {
    const index = await getIndex();
    const stats = await index.describeIndexStats();
    
    res.json({
      indexName: INDEX_NAME,
      stats: stats,
    });
  } catch (err) {
    console.error("❌ Stats error:", err);
    res.status(500).json({ error: "Failed to get stats", details: err.message });
  }
});

/* ================= RESET KB ================= */

app.delete("/reset-kb", async (req, res) => {
  try {
    const index = await getIndex();
    
    // Delete all vectors
    await index.deleteAll();
    
    console.log("🗑️ Deleted all vectors from index:", INDEX_NAME);
    
    res.json({ status: "KB reset successfully" });
  } catch (err) {
    console.error("❌ Reset error:", err);
    res.status(500).json({ error: "Reset failed", details: err.message });
  }
});

/* ================= HEALTH ================= */

app.get("/health", (_, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

/* ================= START ================= */

async function startServer() {
  try {
    console.log("🚀 Starting server...");
    console.log("🔧 Initializing Pinecone...");
    
    // Initialize index on startup
    await initializeIndex();
    
    app.listen(PORT, () => {
      console.log(`\n✅ Server running successfully!`);
      console.log(`🌐 URL: http://localhost:${PORT}`);
      console.log(`📚 Index: "${INDEX_NAME}" ready`);
      console.log(`🌲 Using Pinecone (Serverless)`);
      console.log(`\n📍 Available endpoints:`);
      console.log(`  POST   /summarize       - Summarize a ticket`);
      console.log(`  POST   /compose-reply   - Generate RAG-based reply`);
      console.log(`  POST   /ingest-kb       - Ingest knowledge base articles`);
      console.log(`  POST   /debug-search    - Debug article search`);
      console.log(`  GET    /index-stats     - Get index statistics`);
      console.log(`  DELETE /reset-kb        - Reset knowledge base`);
      console.log(`  GET    /health          - Health check`);
      console.log(`\n💡 Tip: Test with: curl http://localhost:${PORT}/health\n`);
    });
  } catch (err) {
    console.error("❌ Failed to start server:", err);
    console.error("\n💡 Troubleshooting:");
    console.error("  1. Check your PINECONE_API_KEY in .env");
    console.error("  2. Make sure you have signed up at https://www.pinecone.io");
    console.error("  3. Verify npm install @pinecone-database/pinecone completed");
    process.exit(1);
  }
}

startServer();