import PQueue from 'p-queue';
import { 
  fetchTicketsByDateRange, 
  enrichTicketWithComments, 
  createZendeskImportRecord, 
  createZendeskErrorImportRecord,
  fetchFormFields
} from "../config/zendesk.js";
import { upsertVectors, resetKnowledgeBase, getIndexStats } from "../config/pinecone.js";
import { embedText } from "../services/embedding.js";
import { chunkTicketData, extractTicketsFromJSON } from "../services/chunking.js";
import { extractTextFromFile, cleanupFile } from "../services/fileProcessor.js";

// Initialize queue for parallel processing
const enrichmentQueue = new PQueue({
  concurrency: 3,
  interval: 1000,
  intervalCap: 3
});

const embeddingQueue = new PQueue({
  concurrency: 5,
  interval: 1000,
  intervalCap: 10
});


/**
 * Auto-import tickets from Zendesk by date range
 */
export async function autoImportTickets(req, res) {
  const startTime = Date.now();
  
  try {
    const { startDate, endDate } = req.body;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ error: "startDate and endDate are required" });
    }
    
    console.log(`\n🚀 Starting auto-import for ${startDate} to ${endDate}`);
    
    // Fetch form fields first (with caching)
    console.log(`📋 Fetching form field mappings...`);
    const fieldsMap = await fetchFormFields();
    console.log(`✅ Form fields loaded: ${Object.keys(fieldsMap).length} fields available`);
    
    const tickets = await fetchTicketsByDateRange(startDate, endDate);
    
    // Create import record regardless of ticket count
    const customRecord = await createZendeskImportRecord({
      startDate: startDate,
      endDate: endDate,
      ticketCount: tickets.length,
      source: 'auto_import'
    });
    
    if (tickets.length === 0) {
      const processingTime = `${((Date.now() - startTime) / 1000).toFixed(2)}s`;
      return res.json({
        status: "No tickets found in date range",
        ticketsProcessed: 0,
        totalChunks: 0,
        processingTime: processingTime,
        zendeskRecordId: customRecord?.id || null,
        dateRange: {
          start: startDate,
          end: endDate
        }
      });
    }
    
    console.log(`\n📊 Processing ${tickets.length} tickets...`);
    
    // Enrich tickets with comments and custom fields (PARALLEL)
    console.log(`⚡ Using parallel processing (max 3 concurrent enrichments)`);
    const enrichedTickets = [];
    let enrichmentProgress = 0;
    
    const enrichmentResults = await Promise.allSettled(
      tickets.map((ticket, index) =>
        enrichmentQueue.add(async () => {
          enrichmentProgress++;
          console.log(`🔄 Enriching ticket ${enrichmentProgress}/${tickets.length} (ID: ${ticket.id})`);
          const enriched = await enrichTicketWithComments(ticket, fieldsMap);
          return enriched;
        })
      )
    );
    
    // Process results and log any failures
    enrichmentResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        enrichedTickets.push(result.value);
      } else {
        console.error(`❌ Failed to enrich ticket ${index}:`, result.reason.message);
      }
    });
    
    console.log(`✅ Enriched ${enrichedTickets.length}/${tickets.length} tickets successfully`);
    
    console.log(`\n📦 Creating chunks and embeddings...`);
    const vectors = [];
    const timestamp = Date.now();
    let totalChunks = 0;
    
    // First, create all chunks (sequential, fast)
    const allChunks = [];
    for (const ticket of enrichedTickets) {
      const chunks = chunkTicketData(ticket);
      console.log(`📦 Created ${chunks.length} chunks for ticket ${ticket.ticket_id}`);
      
      allChunks.push(...chunks.map((chunk, i) => ({
        chunk,
        ticketId: ticket.ticket_id,
        chunkIndex: i
      })));
    }
    
    console.log(`⚡ Generating embeddings for ${allChunks.length} chunks in parallel (max 5 concurrent)...`);
    
    // Generate embeddings in parallel
    let embeddingProgress = 0;
    const embeddingResults = await Promise.allSettled(
      allChunks.map(({ chunk, ticketId, chunkIndex }) =>
        embeddingQueue.add(async () => {
          embeddingProgress++;
          if (embeddingProgress % 5 === 0) {
            console.log(`⏳ Embedding progress: ${embeddingProgress}/${allChunks.length} chunks`);
          }
          const embedding = await embedText(chunk.text);
          return { embedding, chunk, ticketId, chunkIndex };
        })
      )
    );
    
    // Process embedding results
    embeddingResults.forEach((result) => {
      if (result.status === 'fulfilled') {
        const { embedding, chunk, ticketId, chunkIndex } = result.value;
        vectors.push({
          id: `auto-ticket-${ticketId}-chunk-${chunkIndex}-${timestamp}`,
          values: embedding,
          metadata: {
            ...chunk.metadata,
            content: chunk.text,
            source: 'auto_import',
            importDate: new Date().toISOString(),
            created_at: chunk.metadata?.created_at,
            updated_at: chunk.metadata?.updated_at
          }
        });
        totalChunks++;
      } else {
        console.error(`❌ Failed to generate embedding:`, result.reason.message);
      }
    });
    
    console.log(`✅ Generated embeddings for ${totalChunks}/${allChunks.length} chunks`);
    
    console.log(`\n📤 Uploading ${vectors.length} vectors to Pinecone...`);
    await upsertVectors(vectors);
    
    const processingTime = `${((Date.now() - startTime) / 1000).toFixed(2)}s`;
    
    console.log(`\n✅ Auto-import completed successfully!`);
    console.log(`📊 Stats: ${enrichedTickets.length} tickets, ${totalChunks} chunks, ${processingTime}`);
    
    res.json({
      status: "Import completed successfully",
      ticketsProcessed: enrichedTickets.length,
      totalChunks: totalChunks,
      processingTime: processingTime,
      zendeskRecordId: customRecord?.id || null,
      dateRange: {
        start: startDate,
        end: endDate
      }
    });
    
  } catch (err) {
    console.error("❌ Auto-import error:", err);
    
    // Create error record in separate object
    const errorRecord = await createZendeskErrorImportRecord({
      startDate: req.body?.startDate || 'N/A',
      endDate: req.body?.endDate || 'N/A',
      errorMessage: err.message,
      errorDetails: err.stack || err.toString(),
      source: 'auto_import'
    });
    
    res.status(500).json({ 
      error: "Auto-import failed", 
      details: err.message,
      zendeskErrorRecordId: errorRecord?.id || null
    });
  }
}

/**
 * Import file to knowledge base
 */
export async function importFile(req, res) {
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

    const fileData = await extractTextFromFile(filePath, fileType, fileName);
    
    const timestamp = Date.now();
    let totalChunks = 0;

    if (fileData.type === 'tickets') {
      const tickets = extractTicketsFromJSON(fileData.data);
      console.log(`🎫 Found ${tickets.length} tickets in JSON`);
      
      // Create all chunks first
      const allChunks = [];
      for (const ticket of tickets) {
        const chunks = chunkTicketData(ticket);
        console.log(`📦 Created ${chunks.length} chunks for ticket ${ticket.ticket_id}`);
        
        allChunks.push(...chunks.map((chunk, i) => ({
          chunk,
          ticketId: ticket.ticket_id,
          chunkIndex: i
        })));
      }
      
      console.log(`⚡ Generating embeddings for ${allChunks.length} chunks in parallel...`);
      
      // Generate embeddings in parallel
      let embeddingProgress = 0;
      const embeddingResults = await Promise.allSettled(
        allChunks.map(({ chunk, ticketId, chunkIndex }) =>
          embeddingQueue.add(async () => {
            embeddingProgress++;
            if (embeddingProgress % 5 === 0) {
              console.log(`⏳ Embedding progress: ${embeddingProgress}/${allChunks.length}`);
            }
            const embedding = await embedText(chunk.text);
            return { embedding, chunk, ticketId, chunkIndex };
          })
        )
      );
      
      const vectors = [];
      let successCount = 0;
      
      embeddingResults.forEach((result) => {
        if (result.status === 'fulfilled') {
          const { embedding, chunk, ticketId, chunkIndex } = result.value;
          vectors.push({
            id: `ticket-${ticketId}-chunk-${chunkIndex}-${timestamp}`,
            values: embedding,
            metadata: {
              ...chunk.metadata,
              content: chunk.text,
              source: 'ticket_import',
              fileName: fileName,
              uploadedAt: new Date().toISOString()
            }
          });
          successCount++;
        } else {
          console.error(`❌ Failed embedding:`, result.reason.message);
        }
      });
      
      totalChunks = successCount;
      console.log(`✅ Generated ${successCount}/${allChunks.length} embeddings`);
      
      console.log(`📤 Uploading ${vectors.length} vectors to Pinecone...`);
      await upsertVectors(vectors);
      
      const customRecord = await createZendeskImportRecord({
        startDate: new Date().toISOString().split('T')[0],
        endDate: new Date().toISOString().split('T')[0],
        ticketCount: tickets.length,
        source: 'file_import'
      });
      
      console.log(`✅ Successfully imported ${tickets.length} tickets (${totalChunks} chunks)`);
      
      res.json({
        status: "File imported successfully",
        fileName: fileName,
        type: "tickets",
        ticketsProcessed: tickets.length,
        totalChunks: totalChunks,
        zendeskRecordId: customRecord?.id || null
      });
      
    } else {
      const chunks = [fileData.data];
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
      
      await upsertVectors(vectors);
      
      const customRecord = await createZendeskImportRecord({
        startDate: new Date().toISOString().split('T')[0],
        endDate: new Date().toISOString().split('T')[0],
        ticketCount: 0,
        source: 'file_import'
      });
      
      res.json({
        status: "File imported successfully",
        fileName: fileName,
        type: "text",
        chunks: chunks.length,
        zendeskRecordId: customRecord?.id || null
      });
    }

  } catch (err) {
    console.error("❌ File import error:", err);

    // Create error record in separate object
    const errorRecord = await createZendeskErrorImportRecord({
      startDate: 'N/A',
      endDate: 'N/A',
      errorMessage: err.message,
      errorDetails: err.stack || err.toString(),
      source: 'file_import'
    });

    res.status(500).json({ 
      error: "File import failed", 
      details: err.message,
      zendeskErrorRecordId: errorRecord?.id || null
    });
  } finally {
    cleanupFile(filePath);
  }
}

/**
 * Ingest knowledge base articles
 */
export async function ingestKB(req, res) {
  try {
    const { articles } = req.body;
    if (!Array.isArray(articles)) {
      return res.status(400).json({ error: "articles array required" });
    }

    if (articles.length === 0) {
      return res.status(400).json({ error: "articles array is empty" });
    }

    console.log(`📚 Processing ${articles.length} articles...`);
    console.log(`⚡ Generating embeddings in parallel (max 5 concurrent)...`);

    const vectors = [];
    let totalIngested = 0;
    
    // Generate embeddings in parallel
    const embeddingResults = await Promise.allSettled(
      articles.map((article, index) =>
        embeddingQueue.add(async () => {
          const cleanText = article.content.replace(/<[^>]+>/g, "").slice(0, 2000);
          const embedding = await embedText(cleanText);
          
          if ((index + 1) % 5 === 0) {
            console.log(`⏳ Progress: ${index + 1}/${articles.length} articles`);
          }
          
          return { embedding, article, cleanText };
        })
      )
    );
    
    // Process results
    embeddingResults.forEach((result) => {
      if (result.status === 'fulfilled') {
        const { embedding, article, cleanText } = result.value;
        vectors.push({
          id: `article-${article.id}`,
          values: embedding,
          metadata: {
            title: article.title,
            content: cleanText,
          },
        });
        totalIngested++;
      } else {
        console.error(`❌ Failed to ingest article:`, result.reason.message);
      }
    });

    console.log(`✅ Generated embeddings for ${totalIngested}/${articles.length} articles`);
    
    await upsertVectors(vectors);

    console.log(`✅ Successfully ingested all ${totalIngested} articles into Pinecone`);
    res.json({ status: "KB ingested successfully", count: totalIngested });
  } catch (err) {
    console.error("❌ KB ingestion error:", err);
    res.status(500).json({ error: "KB ingestion failed", details: err.message });
  }
}

/**
 * Reset knowledge base
 */
export async function resetKB(req, res) {
  try {
    await resetKnowledgeBase();
    res.json({ status: "KB reset successfully" });
  } catch (err) {
    console.error("❌ Reset error:", err);
    res.status(500).json({ error: "Reset failed", details: err.message });
  }
}

/**
 * Get index statistics
 */
export async function getStats(req, res) {
  try {
    const stats = await getIndexStats();
    res.json(stats);
  } catch (err) {
    console.error("❌ Stats error:", err);
    res.status(500).json({ error: "Failed to get stats", details: err.message });
  }
}