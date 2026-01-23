import { 
  fetchTicketsByDateRange, 
  enrichTicketWithComments, 
  createZendeskImportRecord 
} from "../config/zendesk.js";
import { upsertVectors, resetKnowledgeBase, getIndexStats } from "../config/pinecone.js";
import { embedText } from "../services/embedding.js";
import { chunkTicketData, extractTicketsFromJSON } from "../services/chunking.js";
import { extractTextFromFile, cleanupFile } from "../services/fileProcessor.js";


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
    
    const tickets = await fetchTicketsByDateRange(startDate, endDate);
    
    // Create import record regardless of ticket count
    const customRecord = await createZendeskImportRecord({
      startDate: startDate,
      endDate: endDate,
      status: tickets.length > 0 ? 'success' : 'no_tickets_found',
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
    
    // Enrich tickets with comments
    const enrichedTickets = [];
    for (let i = 0; i < tickets.length; i++) {
      console.log(`🔄 Enriching ticket ${i + 1}/${tickets.length} (ID: ${tickets[i].id})`);
      const enriched = await enrichTicketWithComments(tickets[i]);
      enrichedTickets.push(enriched);
      
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log(`\n📦 Creating chunks and embeddings...`);
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
    
    await createZendeskImportRecord({
      status: 'failed',
      ticketCount: 0,
      source: 'auto_import'
    });
    
    res.status(500).json({ 
      error: "Auto-import failed", 
      details: err.message 
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
      
      console.log(`📤 Uploading ${vectors.length} vectors to Pinecone...`);
      await upsertVectors(vectors);
      
      await createZendeskImportRecord({
        status: 'success',
        ticketCount: tickets.length,
        source: 'file_import'
      });
      
      console.log(`✅ Successfully imported ${tickets.length} tickets (${totalChunks} chunks)`);
      
      res.json({
        status: "File imported successfully",
        fileName: fileName,
        type: "tickets",
        ticketsProcessed: tickets.length,
        totalChunks: totalChunks
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
      
      await createZendeskImportRecord({
        status: 'success',
        ticketCount: 0,
        source: 'file_import'
      });
      
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

    const vectors = [];
    let totalIngested = 0;

    for (const article of articles) {
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
      
      totalIngested++;
      console.log(`✅ Processed ${totalIngested}/${articles.length} articles`);
    }

    await upsertVectors(vectors);

    console.log(`✅ Successfully ingested all ${articles.length} articles into Pinecone`);
    res.json({ status: "KB ingested successfully", count: articles.length });
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