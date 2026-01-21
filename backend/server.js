import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Pinecone } from "@pinecone-database/pinecone";
import multer from "multer";
import path from "path";
import fs from "fs";
import axios from "axios";

dotenv.config();

/* ================= APP SETUP ================= */

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Setup file upload
const upload = multer({ 
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

/* ================= VALIDATION ================= */

if (!process.env.GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY missing");
  process.exit(1);
}

if (!process.env.PINECONE_API_KEY) {
  console.error("PINECONE_API_KEY missing");
  process.exit(1);
}

if (!process.env.ZENDESK_EMAIL || !process.env.ZENDESK_API_TOKEN || !process.env.ZENDESK_DOMAIN) {
  console.warn("⚠️ Zendesk credentials missing - auto-import feature will not work");
  console.warn("💡 Add ZENDESK_EMAIL, ZENDESK_API_TOKEN, and ZENDESK_DOMAIN to .env file");
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
    const indexList = await pc.listIndexes();
    const indexExists = indexList.indexes?.some(idx => idx.name === INDEX_NAME);

    if (!indexExists) {
      console.log(`📦 Creating new index: ${INDEX_NAME}`);
      console.log(`⏳ This may take 30-60 seconds...`);
      
      await pc.createIndex({
        name: INDEX_NAME,
        dimension: 768, // ✅ FIXED: Changed from 2048 to 768 for text-embedding-004
        metric: "cosine",
        spec: {
          serverless: {
            cloud: "aws",
            region: "us-east-1",
          },
        },
      });
      
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
      
      console.log("✅ Index created with dimension: 768");
    } else {
      console.log(`Index already exists: ${INDEX_NAME}`);
      
      // ✅ ADDED: Verify dimension matches
      try {
        const indexDesc = await pc.describeIndex(INDEX_NAME);
        const indexDimension = indexDesc.dimension;
        
        console.log(`🔍 Index dimension: ${indexDimension}`);
        
        if (indexDimension !== 768) {
          console.error(`\n❌ CRITICAL ERROR: Dimension mismatch!`);
          console.error(`   Index has: ${indexDimension} dimensions`);
          console.error(`   Model produces: 768 dimensions`);
          console.error(`\n💡 FIX: Delete the index and restart:`);
          console.error(`   curl -X DELETE http://localhost:${PORT}/force-delete-index`);
          console.error(`   Then restart the server\n`);
          throw new Error(`Dimension mismatch: index=${indexDimension}, model=768`);
        }
        
        console.log(`✅ Dimension verified: 768`);
      } catch (err) {
        if (err.message.includes('Dimension mismatch')) {
          throw err;
        }
        console.warn(`⚠️ Could not verify dimension:`, err.message);
      }
    }

    const index = pc.index(INDEX_NAME);
    indexCache = index;
    console.log("✅ Index ready:", INDEX_NAME);
    return index;
  } catch (err) {
    console.error("❌ Failed to initialize index:", err);
    throw err;
  }
}


function cleanMarkdown(text) {
  if (!text) return "";

  return text
    // Remove bold **text** or __text__
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    
    // Remove italic *text* or _text_
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/_(.*?)_/g, "$1")
    
    // Remove headers ### text
    .replace(/^#{1,6}\s+/gm, "")
    
    // Remove code blocks ```code```
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`(.*?)`/g, "$1")
    
    // Clean up bullet points - convert to natural text
    .replace(/^\s*[-*+]\s+/gm, "")
    
    // Preserve numbered lists but clean format
    .replace(/^\s*(\d+)\.\s+/gm, "$1. ")
    
    // Clean excessive line breaks (more than 2)
    .replace(/\n{3,}/g, "\n\n")
    
    // Trim whitespace
    .trim();
}


// ✅ ADDED: Force delete endpoint for troubleshooting
app.delete("/force-delete-index", async (req, res) => {
  try {
    console.log(`🗑️ Deleting index: ${INDEX_NAME}`);
    await pc.deleteIndex(INDEX_NAME);
    indexCache = null;
    
    console.log(`✅ Index deleted successfully`);
    console.log(`⚠️ Please restart the server to create a new index with correct dimensions`);
    
    res.json({ 
      status: "Index deleted successfully",
      message: "Restart the server now to create a new index with dimension=768"
    });
  } catch (err) {
    console.error("❌ Delete error:", err);
    res.status(500).json({ 
      error: "Failed to delete index", 
      details: err.message 
    });
  }
});

async function getIndex() {
  if (!indexCache) {
    indexCache = await initializeIndex();
  }
  return indexCache;
}

/* ================= ZENDESK API ================= */

function createZendeskClient() {
  if (!process.env.ZENDESK_EMAIL || !process.env.ZENDESK_API_TOKEN || !process.env.ZENDESK_DOMAIN) {
    throw new Error("Zendesk credentials not configured");
  }

  const auth = Buffer.from(
    `${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`
  ).toString('base64');

  return axios.create({
    baseURL: `https://${process.env.ZENDESK_DOMAIN}.zendesk.com/api/v2`,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json'
    }
  });
}

async function fetchTicketsByDateRange(startDate, endDate) {
  const zendeskClient = createZendeskClient();
  const allTickets = [];
  
  // Format dates as YYYY-MM-DD for Zendesk
  const formatDate = (dateStr) => {
    const date = new Date(dateStr);
    return date.toISOString().split('T')[0];
  };
  
  const startFormatted = formatDate(startDate);
  const endFormatted = formatDate(endDate);
  
  console.log(`📅 Fetching tickets from ${startFormatted} to ${endFormatted}`);
  
  // Zendesk search query syntax: created>YYYY-MM-DD created<YYYY-MM-DD
  // Note: Use URL encoding for special characters
  const query = `type:ticket created>=${startFormatted} created<=${endFormatted}`;
  const encodedQuery = encodeURIComponent(query);
  
  let nextUrl = `/search.json?query=${encodedQuery}&sort_by=created_at&sort_order=desc`;
  let page = 1;
  
  // console.log(`🔍 Search query: ${query}`);
  // console.log(`🔍 Encoded URL: ${nextUrl}`);
  
  while (nextUrl) {
    console.log(`📄 Fetching page ${page}...`);
    
    try {
      console.log(`➡️ Request URL: ${nextUrl}`);
      const response = await zendeskClient.get(nextUrl);
      if(page === 2){
      console.log(`✅ Received response ${response}`);
      }
      const tickets = response.data.results || [];

    
      
      console.log(`✓ Found ${tickets.length} tickets on page ${page}`);
      allTickets.push(...tickets);
      
      // For pagination, Zendesk returns absolute URLs in next_page.
      // Use the absolute URL directly to avoid mismatching the baseURL
      // (sometimes pathname includes `/api/v2` which would duplicate when
      // combined with the client baseURL and cause 404s).
      if (response.data.next_page) {
        nextUrl = response.data.next_page; // absolute URL
        console.log(`➡️ Next page URL: ${nextUrl}`);
      } else {
        nextUrl = null;
      }
      
      page++;
      
      // Rate limiting - wait 1 second between requests
      if (nextUrl) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (err) {
      console.error(`❌ Error fetching page ${page}:`, err.message);
      if (err.response) {
        console.error(`❌ Response status: ${err.response.status}`);
        console.error(`❌ Response data:`, JSON.stringify(err.response.data, null, 2));
      }
      break;
    }
  }
  
  console.log(`✅ Total tickets fetched: ${allTickets.length}`);
  return allTickets;
}

async function fetchTicketComments(ticketId) {
  const zendeskClient = createZendeskClient();
  
  try {
    const response = await zendeskClient.get(`/tickets/${ticketId}/comments.json`);
    return response.data.comments || [];
  } catch (err) {
    console.error(`❌ Error fetching comments for ticket ${ticketId}:`, err.message);
    return [];
  }
}

async function enrichTicketWithComments(ticket) {
  const comments = await fetchTicketComments(ticket.id);
  
  const conversation = comments.map(comment => ({
    author: comment.author_id === ticket.requester_id ? 'Customer' : 'Agent',
    message: comment.plain_body || comment.body || '',
    created_at: comment.created_at,
    public: comment.public
  }));
  
  // Find resolution (last non-empty comment from agent)
  const agentComments = conversation.filter(c => c.author === 'Agent' && c.message.trim());
  const resolution = agentComments.length > 0 
    ? agentComments[agentComments.length - 1].message 
    : null;
  
  return {
    ticket_id: ticket.id,
    subject: ticket.subject || '',
    description: ticket.description || '',
    status: ticket.status,
    priority: ticket.priority,
    tags: ticket.tags || [],
    created_at: ticket.created_at,
    updated_at: ticket.updated_at,
    conversation: conversation,
    resolution: resolution
  };
}

/* ================= EMBEDDING ================= */

async function embedText(text) {
  const model = genAI.getGenerativeModel({ model: "text-embedding-004" });
  const result = await model.embedContent(text);
  return result.embedding.values;
}

/* ================= IMPROVED TICKET CHUNKING ================= */

function chunkTicketData(ticket) {
  const chunks = [];
  
  // Chunk 1: Subject + Description + Tags
  const mainContent = `
Ticket ID: ${ticket.ticket_id}
Subject: ${ticket.subject}
Description: ${ticket.description || 'N/A'}
Status: ${ticket.status}
Priority: ${ticket.priority}
Tags: ${ticket.tags?.join(', ') || 'None'}
`.trim();
  
  chunks.push({
    text: mainContent,
    metadata: {
      type: 'ticket_overview',
      ticket_id: ticket.ticket_id,
      subject: ticket.subject,
      tags: ticket.tags?.join(', ') || ''
    }
  });
  
  // Chunk 2: Full Conversation
  if (ticket.conversation && ticket.conversation.length > 0) {
    const conversationText = ticket.conversation
      .map((msg, idx) => `${idx + 1}. ${msg.author}: ${msg.message}`)
      .join('\n\n');
    
    chunks.push({
      text: `Ticket ${ticket.ticket_id} Conversation:\n\n${conversationText}`,
      metadata: {
        type: 'conversation',
        ticket_id: ticket.ticket_id,
        subject: ticket.subject
      }
    });
  }
  
  // Chunk 3: Resolution + Tags
  if (ticket.resolution) {
    const resolutionText = `
Ticket ${ticket.ticket_id} Resolution:
Problem: ${ticket.subject}
Solution: ${ticket.resolution}
Related Tags: ${ticket.tags?.join(', ') || 'None'}
`.trim();
    
    chunks.push({
      text: resolutionText,
      metadata: {
        type: 'resolution',
        ticket_id: ticket.ticket_id,
        subject: ticket.subject,
        tags: ticket.tags?.join(', ') || ''
      }
    });
  }
  
  return chunks;
}

/* ================= IMPROVED FILE PROCESSING ================= */

function extractTicketsFromJSON(jsonData) {
  const tickets = [];
  
  // Handle different JSON structures
  if (jsonData.knowledge_base?.tickets) {
    tickets.push(...jsonData.knowledge_base.tickets);
  } else if (jsonData.tickets) {
    tickets.push(...jsonData.tickets);
  } else if (Array.isArray(jsonData)) {
    tickets.push(...jsonData);
  } else {
    // Single ticket object
    tickets.push(jsonData);
  }
  
  return tickets;
}

async function extractTextFromFile(filePath, mimetype, originalName) {
  console.log(`🔍 Reading file: ${filePath}`);
  
  const stats = fs.statSync(filePath);
  console.log(`📄 File size: ${stats.size} bytes`);
  
  if (stats.size > 5 * 1024 * 1024) {
    throw new Error('File too large. Maximum size is 5MB.');
  }
  
  const fileContent = fs.readFileSync(filePath, 'utf8');
  
  // Handle JSON files specially for ticket data
  if (mimetype === 'application/json' || originalName.endsWith('.json')) {
    console.log(`🔄 Parsing JSON file as ticket data...`);
    try {
      const jsonData = JSON.parse(fileContent);
      console.log(`✓ JSON parsed successfully`);
      
      return { type: 'tickets', data: jsonData };
    } catch (err) {
      console.error("❌ Failed to parse JSON:", err.message);
      throw new Error(`Invalid JSON file: ${err.message}`);
    }
  }
  
  // Handle text files
  if (mimetype === 'text/plain' || mimetype === 'text/markdown' || mimetype === 'text/csv') {
    return { type: 'text', data: fileContent.slice(0, 10000) };
  }
  
  return { type: 'text', data: fileContent.slice(0, 10000) };
}


/* ================= IMPROVED PROMPTS ================= */

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

Use clear formatting with bold text for emphasis where appropriate.
`;
}

function buildReplyPrompt(ticket, tone, kbChunks, language) {
  return `
You are a Zendesk support agent writing a reply to a customer.

====================
LANGUAGE REQUIREMENT (CRITICAL)
====================

YOU MUST write the ENTIRE reply in the language: ${ticket.language}

This is NON-NEGOTIABLE. Every word, sentence, and phrase must be in this language.

====================
TONE RULES (MANDATORY)
====================

IMPORTANT: The tone MUST strictly follow the selected tone.
Do NOT default to a neutral or professional tone unless explicitly required by the tone rules below.

Tone: ${tone}

- professional:
  Polite, formal, business-like language.
  No emojis. No casual words.
  Calm, confident, and respectful.

- friendly:
  Warm, conversational, and approachable.
  Light, human wording.
  Still professional, but relaxed and positive.

- empathetic:
  Show understanding of the customer's frustration or concern.
  Acknowledge feelings before giving information.
  Use reassuring and caring language.

- apologetic:
  Clearly apologize at the beginning.
  Take ownership of the inconvenience.
  Reassuring and solution-focused.

- concise:
  Very short and direct.
  Minimal wording.
  No unnecessary explanations.

You MUST adapt wording, sentence structure, and emotional depth based on the selected tone.
If tone is violated, the response is incorrect.

====================
KNOWLEDGE BASE (USE ONLY THIS)
====================
${kbChunks}

If the knowledge base does NOT contain the answer, reply in the agent's language with an appropriate message like "I will check this and get back to you."

====================
TICKET DETAILS
====================

Ticket Subject:
${ticket.subject}

Customer Message:
${ticket.description}

====================
STRICT RULES
====================
- CRITICAL: Write the ENTIRE reply in ${ticket.language}
- Use ONLY information from the knowledge base
- No hallucinations or assumptions
- No invented steps or procedures
- Do NOT mention the knowledge base
- Write in clear paragraphs with line breaks
- Use **bold** only for critical points
- Response must be ready to send to the customer
- The reply must be natural and fluent

====================
WRITE THE REPLY BELOW
====================
`;
}


/* ================= NEW: AUTO-IMPORT TICKETS ENDPOINT ================= */

app.post("/auto-import-tickets", async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { startDate, endDate } = req.body;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ error: "startDate and endDate are required" });
    }
    
    console.log(`\n🚀 Starting auto-import for ${startDate} to ${endDate}`);
    
    // Step 1: Fetch tickets from Zendesk
    const tickets = await fetchTicketsByDateRange(startDate, endDate);
    
    if (tickets.length === 0) {
      return res.json({
        status: "No tickets found in date range",
        ticketsProcessed: 0,
        totalChunks: 0,
        processingTime: `${((Date.now() - startTime) / 1000).toFixed(2)}s`
      });
    }
    
    console.log(`\n📊 Processing ${tickets.length} tickets...`);
    
    // Step 2: Enrich tickets with comments
    const enrichedTickets = [];
    for (let i = 0; i < tickets.length; i++) {
      console.log(`🔄 Enriching ticket ${i + 1}/${tickets.length} (ID: ${tickets[i].id})`);
      const enriched = await enrichTicketWithComments(tickets[i]);
      enrichedTickets.push(enriched);
      
      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // Step 3: Create chunks and embeddings
    console.log(`\n📦 Creating chunks and embeddings...`);
    const index = await getIndex();
    const vectors = [];
    const timestamp = Date.now();
    let totalChunks = 0;
    
    for (const ticket of enrichedTickets) {
      const chunks = chunkTicketData(ticket);
      console.log(`📦 Created ${chunks.length} chunks for ticket ${ticket.ticket_id}`);
      
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embedding = await embedText(chunk.text);
        
        vectors.push({
          id: `auto-ticket-${ticket.ticket_id}-chunk-${i}-${timestamp}`,
          values: embedding,
          metadata: {
            ...chunk.metadata,
            content: chunk.text,
            source: 'auto_import',
            importDate: new Date().toISOString(),
            created_at: ticket.created_at,
            updated_at: ticket.updated_at
          }
        });
        
        totalChunks++;
      }
    }
    
    // Step 4: Upload to Pinecone
    console.log(`\n📤 Uploading ${vectors.length} vectors to Pinecone...`);
    const batchSize = 100;
    for (let i = 0; i < vectors.length; i += batchSize) {
      const batch = vectors.slice(i, i + batchSize);
      await index.upsert(batch);
      console.log(`✓ Uploaded batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(vectors.length/batchSize)}`);
    }
    
    const processingTime = `${((Date.now() - startTime) / 1000).toFixed(2)}s`;
    
    console.log(`\n✅ Auto-import completed successfully!`);
    console.log(`📊 Stats: ${enrichedTickets.length} tickets, ${totalChunks} chunks, ${processingTime}`);
    
    res.json({
      status: "Import completed successfully",
      ticketsProcessed: enrichedTickets.length,
      totalChunks: totalChunks,
      processingTime: processingTime,
      dateRange: {
        start: startDate,
        end: endDate
      }
    });
    
  } catch (err) {
    console.error("❌ Auto-import error:", err);
    res.status(500).json({ 
      error: "Auto-import failed", 
      details: err.message 
    });
  }
});

/* ================= TICKET SUMMARIZATION ================= */

app.post("/summarize", async (req, res) => {
  try {
    const ticket = req.body;

    if (!ticket.ticketId) {
      return res.status(400).json({ error: "Invalid ticket payload - ticketId required" });
    }

    const model = genAI.getGenerativeModel({ 
      model: "gemini-2.0-flash-exp",
      generationConfig: {
        temperature: 0.7,
        topP: 0.8,
        topK: 40,
      }
    });

    let prompt = buildSummaryPrompt(ticket);

    if (ticket.language) {
      prompt += `\nPlease provide the summary in ${ticket.language} language.`;
    }

    console.log("📝 Generating summary for ticket:", ticket.ticketId);

    const result = await model.generateContent(prompt);
    let summary = result.response.text();

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

/* ================= IMPROVED FILE IMPORT ================= */

app.post("/import-file", upload.single('file'), async (req, res) => {
  let filePath = null;
  
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    filePath = req.file.path;
    const fileName = req.file.originalname;
    const fileType = req.file.mimetype;

    console.log(`📄 Processing file: ${fileName}`);
    console.log(`📋 MIME type: ${fileType}`);

    // Extract data from file
    const fileData = await extractTextFromFile(filePath, fileType, fileName);
    
    const index = await getIndex();
    const timestamp = Date.now();
    let totalChunks = 0;

    // Process based on file type
    if (fileData.type === 'tickets') {
      // Extract tickets from JSON
      const tickets = extractTicketsFromJSON(fileData.data);
      console.log(`🎫 Found ${tickets.length} tickets in JSON`);
      
      const vectors = [];
      
      for (const ticket of tickets) {
        const chunks = chunkTicketData(ticket);
        console.log(`📦 Created ${chunks.length} chunks for ticket ${ticket.ticket_id}`);
        
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const embedding = await embedText(chunk.text);
          
          vectors.push({
            id: `ticket-${ticket.ticket_id}-chunk-${i}-${timestamp}`,
            values: embedding,
            metadata: {
              ...chunk.metadata,
              content: chunk.text,
              source: 'ticket_import',
              fileName: fileName,
              uploadedAt: new Date().toISOString()
            }
          });
          
          totalChunks++;
        }
      }
      
      // Upload to Pinecone in batches
      console.log(`📤 Uploading ${vectors.length} vectors to Pinecone...`);
      const batchSize = 100;
      for (let i = 0; i < vectors.length; i += batchSize) {
        const batch = vectors.slice(i, i + batchSize);
        await index.upsert(batch);
        console.log(`✓ Uploaded batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(vectors.length/batchSize)}`);
      }
      
      console.log(`✅ Successfully imported ${tickets.length} tickets (${totalChunks} chunks)`);
      
      res.json({
        status: "File imported successfully",
        fileName: fileName,
        type: "tickets",
        ticketsProcessed: tickets.length,
        totalChunks: totalChunks
      });
      
    } else {
      // Handle text files (old way)
      const chunks = [fileData.data]; // Simple chunking for text
      const vectors = [];
      
      for (let i = 0; i < chunks.length; i++) {
        const embedding = await embedText(chunks[i]);
        
        vectors.push({
          id: `file-${timestamp}-${i}`,
          values: embedding,
          metadata: {
            title: fileName,
            content: chunks[i],
            source: 'file_import',
            uploadedAt: new Date().toISOString()
          }
        });
      }
      
      await index.upsert(vectors);
      
      res.json({
        status: "File imported successfully",
        fileName: fileName,
        type: "text",
        chunks: chunks.length
      });
    }

  } catch (err) {
    console.error("❌ File import error:", err);
    res.status(500).json({ 
      error: "File import failed", 
      details: err.message
    });
  } finally {
    // Clean up uploaded file
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        console.log(`🗑️ Cleaned up temporary file`);
      } catch (cleanupError) {
        console.error("⚠️ Failed to clean up file:", cleanupError);
      }
    }
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
      topK: 5,
      includeMetadata: true,
    });

    const kbChunks = results.matches
      .map(match => match.metadata?.content || "")
      .filter(Boolean)
      .join("\n\n") || "No relevant knowledge base found.";

    const prompt = buildReplyPrompt(ticket, ticket.tone|| "professional", kbChunks);
    console.log("📝 promt", prompt);

    console.log("🤖 Generating reply for ticket:", ticket.ticketId);

    const model = genAI.getGenerativeModel({ 
      model: "gemini-2.0-flash-exp",
      generationConfig: {
        temperature: 0.7,
        topP: 0.8,
        topK: 40,
      }
    });
    
    const response = await model.generateContent(prompt);
    let replyText = response.response.text();

    res.json({
      ticketId: ticket.ticketId,
      reply: replyText,
      sources: results.matches.map(m => ({
        title: m.metadata?.subject || m.metadata?.title,
        type: m.metadata?.type,
        score: m.score
      })).filter(s => s.title),
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
      topK: 10,
      includeMetadata: true,
    });

    res.json({
      query: query,
      results: results.matches.map(match => ({
        id: match.id,
        score: match.score,
        type: match.metadata?.type,
        ticket_id: match.metadata?.ticket_id,
        subject: match.metadata?.subject || match.metadata?.title,
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
    await index.deleteAll();
    
    console.log("🗑️ Deleted all vectors from index:", INDEX_NAME);
    
    res.json({ status: "KB reset successfully" });
  } catch (err) {
    console.error("❌ Reset error:", err);
    res.status(500).json({ error: "Reset failed", details: err.message });
  }
});

/* ================= TRANSLATE TEXT ================= */

app.post("/translate", async (req, res) => {
  try {
    const { text, targetLanguage } = req.body;

    if (!text || !targetLanguage) {
      return res.status(400).json({ error: "text and targetLanguage are required" });
    }

    console.log(`🌐 Translating text to ${targetLanguage}...`);

    const model = genAI.getGenerativeModel({ 
      model: "gemini-2.0-flash-exp",
      generationConfig: {
        temperature: 0.3,
        topP: 0.8,
        topK: 40,
      }
    });

    const prompt = `
You are a professional translator.

Translate the following text to ${targetLanguage}.

CRITICAL RULES:
- Maintain the exact same tone and style
- Preserve all formatting (line breaks, bold text, etc.)
- Keep technical terms accurate
- If the text is already in ${targetLanguage}, return it unchanged
- Do NOT add any preamble or explanation
- Return ONLY the translated text

Text to translate:
${text}

Translated text:
`;

    const result = await model.generateContent(prompt);
    const translatedText = result.response.text().trim();

    console.log(`✅ Translation completed`);

    res.json({
      originalText: text,
      translatedText: translatedText,
      targetLanguage: targetLanguage
    });

  } catch (err) {
    console.error("❌ Translation error:", err);
    res.status(500).json({ 
      error: "Translation failed", 
      details: err.message 
    });
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
    
    if (!fs.existsSync('uploads')) {
      fs.mkdirSync('uploads');
    }
    
    await initializeIndex();
    
    app.listen(PORT, () => {
      console.log(`\n✅ Server running successfully!`);
      console.log(`🌐 URL: http://localhost:${PORT}`);
      console.log(`📚 Index: "${INDEX_NAME}" ready`);
      console.log(`🌲 Using Pinecone (Serverless)`);
      console.log(`\n📍 Available endpoints:`);
      console.log(`  POST   /summarize            - Summarize a ticket`);
      console.log(`  POST   /compose-reply        - Generate RAG-based reply`);
      console.log(`  POST   /ingest-kb            - Ingest knowledge base articles`);
      console.log(`  POST   /import-file          - Import file to knowledge base`);
      console.log(`  POST   /auto-import-tickets  - Auto-import tickets from Zendesk ⭐ NEW`);
      console.log(`  POST   /debug-search         - Debug article search`);
      console.log(`  GET    /index-stats          - Get index statistics`);
      console.log(`  DELETE /reset-kb             - Reset knowledge base`);
      console.log(`  GET    /health               - Health check`);
      console.log(`\n💡 Tip: Test with: curl http://localhost:${PORT}/health\n`);
    });
  } catch (err) {
    console.error("❌ Failed to start server:", err);
    process.exit(1);
  }
}

startServer();