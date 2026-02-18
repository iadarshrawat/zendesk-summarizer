import { 
  fetchTicketsByDateRange, 
  enrichTicketWithComments, 
  createZendeskImportRecord, 
  createZendeskErrorImportRecord,
  fetchFormFields
} from "../config/zendesk.js";
import { upsertVectors, resetKnowledgeBase, getIndexStats } from "../config/pinecone.js";
import { embedTextBatch, clearEmbeddingCache, getCacheStats } from "../services/embedding.js";
import { chunkTicketData, extractTicketsFromJSON } from "../services/chunking.js";
import { extractTextFromFile, cleanupFile } from "../services/fileProcessor.js";

/**
 * Auto-import tickets from Zendesk by date range
 * OPTIMIZED: Uses batched processing with rate limiting instead of parallel queues
 */
export async function autoImportTickets(req, res) {
  const startTime = Date.now();
  
  try {
    const { startDate, endDate, mode = 'standard' } = req.body;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ error: "startDate and endDate are required" });
    }
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 AUTO-IMPORT STARTED`);
    console.log(`${'='.repeat(60)}`);
    console.log(`📅 Date Range: ${startDate} to ${endDate}`);
    console.log(`⚙️  Mode: ${mode === 'quick' ? 'Quick (no enrichment)' : 'Standard (full enrichment)'}`);
    console.log(`${'='.repeat(60)}\n`);
    
    // Step 1: Fetch form fields first (with caching)
    console.log(`📋 Step 1: Fetching form field mappings...`);
    const fieldsMap = await fetchFormFields();
    console.log(`✅ Form fields loaded: ${Object.keys(fieldsMap).length} fields available\n`);
    
    // Step 2: Fetch tickets
    console.log(`📡 Step 2: Fetching tickets...`);
    const tickets = await fetchTicketsByDateRange(startDate, endDate);
    console.log(`✅ Fetched ${tickets.length} tickets\n`);
    
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
    
    // Step 3: Enrich tickets in batches
    console.log(`🔄 Step 3: Enriching tickets...`);
    const enrichedTickets = [];
    const skipEnrichment = mode === 'quick';
    
    const ENRICHMENT_BATCH_SIZE = 10; // Process 10 at a time to avoid overwhelming Zendesk API
    
    for (let i = 0; i < tickets.length; i += ENRICHMENT_BATCH_SIZE) {
      const batch = tickets.slice(i, i + ENRICHMENT_BATCH_SIZE);
      const batchNum = Math.floor(i / ENRICHMENT_BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(tickets.length / ENRICHMENT_BATCH_SIZE);
      
      console.log(`   📦 Enriching batch ${batchNum}/${totalBatches} (tickets ${i + 1}-${Math.min(i + ENRICHMENT_BATCH_SIZE, tickets.length)}/${tickets.length})`);
      
      for (const ticket of batch) {
        try {
          if (skipEnrichment) {
            // Quick mode: minimal data
            enrichedTickets.push({
              ticket_id: ticket.id,
              subject: ticket.subject || '',
              description: ticket.description || '',
              status: ticket.status,
              priority: ticket.priority,
              tags: ticket.tags || [],
              created_at: ticket.created_at,
              updated_at: ticket.updated_at,
              conversation: [],
              resolution: null,
              custom_fields: {}
            });
          } else {
            // Full enrichment
            const enriched = await enrichTicketWithComments(ticket, fieldsMap);
            enrichedTickets.push(enriched);
          }
        } catch (error) {
          console.error(`      ❌ Failed to enrich ticket ${ticket.id}:`, error.message);
          // Continue with next ticket
        }
      }
      
      // Small delay between enrichment batches
      if (i + ENRICHMENT_BATCH_SIZE < tickets.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    console.log(`✅ Enriched ${enrichedTickets.length}/${tickets.length} tickets successfully\n`);
    
    // Step 4: Create chunks
    console.log(`✂️  Step 4: Creating chunks...`);
    const allChunks = [];
    
    for (const ticket of enrichedTickets) {
      const chunks = chunkTicketData(ticket);
      allChunks.push(...chunks.map((chunk, i) => ({
        chunk,
        ticketId: ticket.ticket_id,
        chunkIndex: i
      })));
    }
    
    console.log(`✅ Created ${allChunks.length} chunks (avg ${(allChunks.length / enrichedTickets.length).toFixed(1)} per ticket)\n`);
    
    // Step 5: Generate embeddings with smart batching and rate limiting
    console.log(`🧮 Step 5: Generating embeddings for ${allChunks.length} chunks...`);
    console.log(`⚙️  Using smart rate limiting to avoid API limits...\n`);
    
    const texts = allChunks.map(({ chunk }) => chunk.text);
    
    // Configure OpenAI embedding settings - much faster than Google
    const embeddingConfig = mode === 'quick' 
      ? { batchSize: 100, batchDelay: 1000 }  // Quick mode: 100 per batch, 1 sec delay
      : { batchSize: 50, batchDelay: 5000 };  // Standard mode: 50 per batch, 5 sec delay
    
    let embeddings;
    try {
      embeddings = await embedTextBatch(texts, {
        ...embeddingConfig,
        onProgress: (current, total) => {
          if (current % 50 === 0) {
            console.log(`   ⏳ Embedding progress: ${current}/${total} (${Math.round(current / total * 100)}%)`);
          }
        }
      });
    } catch (error) {
      console.error(`❌ Embedding failed:`, error.message);
      throw new Error(`Embedding generation failed: ${error.message}`);
    }
    
    console.log(`✅ Generated ${embeddings.length} embeddings\n`);
    
    // Step 6: Prepare vectors
    console.log(`📦 Step 6: Preparing vectors for Pinecone...`);
    const timestamp = Date.now();
    const vectors = embeddings.map((embedding, idx) => {
      const { chunk, ticketId, chunkIndex } = allChunks[idx];
      return {
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
      };
    });
    
    console.log(`✅ Prepared ${vectors.length} vectors\n`);
    
    // Step 7: Upload to Pinecone
    console.log(`📤 Step 7: Uploading ${vectors.length} vectors to Pinecone...`);
    await upsertVectors(vectors);
    console.log(`✅ Upload complete\n`);
    
    const processingTime = `${((Date.now() - startTime) / 1000).toFixed(2)}s`;
    const cacheStats = getCacheStats();
    
    console.log(`${'='.repeat(60)}`);
    console.log(`✅ AUTO-IMPORT COMPLETED`);
    console.log(`${'='.repeat(60)}`);
    console.log(`📊 Statistics:`);
    console.log(`   • Tickets Processed: ${enrichedTickets.length}`);
    console.log(`   • Total Chunks: ${vectors.length}`);
    console.log(`   • Avg Chunks/Ticket: ${(vectors.length / enrichedTickets.length).toFixed(1)}`);
    console.log(`   • Processing Time: ${processingTime}`);
    console.log(`   • Cache Hits: ${cacheStats.size} entries`);
    console.log(`${'='.repeat(60)}\n`);
    
    res.json({
      status: "Import completed successfully",
      ticketsProcessed: enrichedTickets.length,
      totalChunks: vectors.length,
      processingTime: processingTime,
      cacheHits: cacheStats.size,
      zendeskRecordId: customRecord?.id || null,
      dateRange: {
        start: startDate,
        end: endDate
      }
    });
    
  } catch (err) {
    console.error("\n❌ AUTO-IMPORT ERROR:", err);
    console.error("Stack:", err.stack);
    
    // Create error record
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
 * OPTIMIZED: Uses batched embeddings instead of parallel queue
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

    console.log(`\n📄 Processing file: ${fileName}`);
    console.log(`📋 MIME type: ${fileType}\n`);

    const fileData = await extractTextFromFile(filePath, fileType, fileName);
    const timestamp = Date.now();

    if (fileData.type === 'tickets') {
      const tickets = extractTicketsFromJSON(fileData.data);
      console.log(`🎫 Found ${tickets.length} tickets in JSON\n`);
      
      // Create all chunks
      console.log(`✂️  Creating chunks...`);
      const allChunks = [];
      for (const ticket of tickets) {
        const chunks = chunkTicketData(ticket);
        allChunks.push(...chunks.map((chunk, i) => ({
          chunk,
          ticketId: ticket.ticket_id,
          chunkIndex: i
        })));
      }
      console.log(`✅ Created ${allChunks.length} chunks\n`);
      
      // Generate embeddings with batching
      console.log(`🧮 Generating embeddings for ${allChunks.length} chunks...`);
      const texts = allChunks.map(({ chunk }) => chunk.text);
      
      const embeddings = await embedTextBatch(texts, {
        batchSize: 100,
        batchDelay: 2000,
        onProgress: (current, total) => {
          if (current % 50 === 0) {
            console.log(`   ⏳ Progress: ${current}/${total} (${Math.round(current / total * 100)}%)`);
          }
        }
      });
      
      console.log(`✅ Generated ${embeddings.length} embeddings\n`);
      
      // Prepare vectors
      const vectors = embeddings.map((embedding, idx) => {
        const { chunk, ticketId, chunkIndex } = allChunks[idx];
        return {
          id: `ticket-${ticketId}-chunk-${chunkIndex}-${timestamp}`,
          values: embedding,
          metadata: {
            ...chunk.metadata,
            content: chunk.text,
            source: 'ticket_import',
            fileName: fileName,
            uploadedAt: new Date().toISOString()
          }
        };
      });
      
      console.log(`📤 Uploading ${vectors.length} vectors to Pinecone...`);
      await upsertVectors(vectors);
      console.log(`✅ Upload complete\n`);
      
      const customRecord = await createZendeskImportRecord({
        startDate: new Date().toISOString().split('T')[0],
        endDate: new Date().toISOString().split('T')[0],
        ticketCount: tickets.length,
        source: 'file_import'
      });
      
      res.json({
        status: "File imported successfully",
        fileName: fileName,
        type: "tickets",
        ticketsProcessed: tickets.length,
        totalChunks: embeddings.length,
        zendeskRecordId: customRecord?.id || null
      });
      
    } else {
      // Simple text file
      const chunks = [fileData.data];
      
      console.log(`🧮 Generating embeddings...`);
      const embeddings = await embedTextBatch(chunks, {
        batchSize: 100,
        batchDelay: 2000
      });
      
      const vectors = embeddings.map((embedding, i) => ({
        id: `file-${timestamp}-${i}`,
        values: embedding,
        metadata: {
          title: fileName,
          content: chunks[i],
          source: 'file_import',
          uploadedAt: new Date().toISOString()
        }
      }));
      
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
 * OPTIMIZED: Uses batched embeddings
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

    console.log(`\n📚 Processing ${articles.length} articles...`);
    
    // Prepare texts
    const processedArticles = articles.map(article => ({
      article,
      cleanText: article.content.replace(/<[^>]+>/g, "").slice(0, 2000)
    }));
    
    const texts = processedArticles.map(p => p.cleanText);
    
    // Generate embeddings with batching
    console.log(`🧮 Generating embeddings...`);
    const embeddings = await embedTextBatch(texts, {
      batchSize: 100,
      batchDelay: 2000,
      onProgress: (current, total) => {
        if (current % 25 === 0) {
          console.log(`   ⏳ Progress: ${current}/${total} (${Math.round(current / total * 100)}%)`);
        }
      }
    });
    
    // Prepare vectors
    const vectors = embeddings.map((embedding, idx) => {
      const { article, cleanText } = processedArticles[idx];
      return {
        id: `article-${article.id}`,
        values: embedding,
        metadata: {
          title: article.title,
          content: cleanText,
        }
      };
    });

    console.log(`📤 Uploading ${vectors.length} vectors to Pinecone...`);
    await upsertVectors(vectors);

    console.log(`✅ Successfully ingested ${vectors.length} articles\n`);
    res.json({ status: "KB ingested successfully", count: vectors.length });
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
    
    // Clear embedding cache on reset
    clearEmbeddingCache();
    
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
    const cacheStats = getCacheStats();
    
    res.json({
      ...stats,
      cache: {
        entries: cacheStats.size,
        estimatedMemoryMB: cacheStats.estimatedMemoryMB
      }
    });
  } catch (err) {
    console.error("❌ Stats error:", err);
    res.status(500).json({ error: "Failed to get stats", details: err.message });
  }
}

/**
 * Clear embedding cache (new endpoint)
 */
export async function clearCache(req, res) {
  try {
    const statsBefore = getCacheStats();
    clearEmbeddingCache();
    
    res.json({ 
      status: "Cache cleared successfully",
      entriesCleared: statsBefore.size,
      memoryFreedMB: statsBefore.estimatedMemoryMB
    });
  } catch (err) {
    console.error("❌ Cache clear error:", err);
    res.status(500).json({ error: "Failed to clear cache", details: err.message });
  }
}