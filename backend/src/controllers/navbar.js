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
    
    console.log(`📋 Step 1: Fetching form field mappings...`);
    const fieldsMap = await fetchFormFields();
    console.log(`✅ Form fields loaded: ${Object.keys(fieldsMap).length} fields available\n`);
    
    console.log(`📡 Step 2: Fetching tickets...`);
    const tickets = await fetchTicketsByDateRange(startDate, endDate);
    console.log(`✅ Fetched ${tickets.length} tickets\n`);
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
    const failedEnrichments = [];
    const skipEnrichment = mode === 'quick';
    const ENRICHMENT_BATCH_SIZE = 10;
    
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
            // Full enrichment with error recovery
            try {
              const enriched = await enrichTicketWithComments(ticket, fieldsMap);
              if (!enriched || typeof enriched !== 'object') {
                throw new Error('Invalid enrichment result');
              }
              enrichedTickets.push(enriched);
            } catch (enrichError) {
              console.warn(`      ⚠️  Full enrichment failed for ticket ${ticket.id}, using fallback...`);
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
              failedEnrichments.push({
                ticketId: ticket.id,
                error: enrichError.message
              });
            }
          }
        } catch (error) {
          console.error(`      ❌ Failed to process ticket ${ticket.id}:`, error.message);
          failedEnrichments.push({
            ticketId: ticket.id,
            error: error.message
          });
          // Continue with next ticket
        }
      }
      
      // Small delay between enrichment batches
      if (i + ENRICHMENT_BATCH_SIZE < tickets.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    if (failedEnrichments.length > 0) {
      console.warn(`⚠️  ${failedEnrichments.length} tickets had enrichment issues (using fallback)\n`);
    }
    console.log(`✅ Enriched ${enrichedTickets.length}/${tickets.length} tickets successfully\n`);
    
    // Step 4: Create chunks
    console.log(`✂️  Step 4: Creating chunks...`);
    const allChunks = [];
    const failedChunking = [];
    
    for (const ticket of enrichedTickets) {
      try {
        const chunks = chunkTicketData(ticket);
        
        if (!Array.isArray(chunks) || chunks.length === 0) {
          console.warn(`      ⚠️  No chunks created for ticket ${ticket.ticket_id}`);
          failedChunking.push({
            ticketId: ticket.ticket_id,
            reason: 'No chunks generated'
          });
          continue;
        }
        
        allChunks.push(...chunks.map((chunk, i) => ({
          chunk,
          ticketId: ticket.ticket_id,
          chunkIndex: i
        })));
      } catch (error) {
        console.error(`      ❌ Chunking failed for ticket ${ticket.ticket_id}:`, error.message);
        failedChunking.push({
          ticketId: ticket.ticket_id,
          error: error.message
        });
      }
    }
    
    if (failedChunking.length > 0) {
      console.warn(`⚠️  ${failedChunking.length} tickets failed chunking (skipped)\n`);
    }
    
    if (allChunks.length === 0) {
      console.error(`❌ No chunks generated from any ticket!`);
      return res.status(400).json({ 
        error: "No chunks could be generated from tickets",
        enrichedCount: enrichedTickets.length,
        chunksGenerated: 0
      });
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
      
      if (!Array.isArray(embeddings) || embeddings.length === 0) {
        throw new Error('No embeddings generated');
      }
      
      if (embeddings.length !== texts.length) {
        console.warn(`⚠️  Embedding count mismatch: got ${embeddings.length}, expected ${texts.length}`);
      }
      
    } catch (error) {
      console.error(`❌ Embedding generation failed:`, error.message);
      
      // Check if it's a rate limit or API key issue
      if (error.message.includes('429') || error.message.includes('rate')) {
        throw new Error(`Rate limited by OpenAI API: ${error.message}`);
      } else if (error.message.includes('401') || error.message.includes('invalid')) {
        throw new Error(`OpenAI API authentication failed: ${error.message}`);
      } else {
        throw new Error(`Embedding generation failed: ${error.message}`);
      }
    }
    
    console.log(`✅ Generated ${embeddings.length} embeddings\n`);
    
    // Step 6: Prepare vectors
    console.log(`📦 Step 6: Preparing vectors for Pinecone...`);
    let vectors;
    try {
      const timestamp = Date.now();
      vectors = embeddings.map((embedding, idx) => {
        const { chunk, ticketId, chunkIndex } = allChunks[idx];
        
        if (!embedding || embedding.length === 0) {
          throw new Error(`Invalid embedding at index ${idx}`);
        }
        
        return {
          id: `auto-ticket-${ticketId}-chunk-${chunkIndex}-${timestamp}`,
          values: embedding,
          metadata: {
            ...chunk.metadata,
            content: chunk.text,
            source: 'ticket_chat',
            importDate: new Date().toISOString(),
            created_at: chunk.metadata?.created_at,
            updated_at: chunk.metadata?.updated_at
          }
        };
      });
      
      if (vectors.length === 0) {
        throw new Error('No vectors prepared');
      }
      
      console.log(`✅ Prepared ${vectors.length} vectors\n`);
    } catch (error) {
      console.error(`❌ Vector preparation failed:`, error.message);
      throw new Error(`Vector preparation failed: ${error.message}`);
    }
    
    // Step 7: Upload to Pinecone
    console.log(`📤 Step 7: Uploading ${vectors.length} vectors to Pinecone...`);
    try {
      const uploadResult = await upsertVectors(vectors);
      console.log(`✅ Upload complete (${uploadResult?.upsertedCount || vectors.length} vectors upserted)\n`);
    } catch (error) {
      console.error(`❌ Pinecone upload failed:`, error.message);
      throw new Error(`Pinecone upload failed: ${error.message}`);
    }
    
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
    console.error("\n" + "=".repeat(60));
    console.error("❌ AUTO-IMPORT ERROR");
    console.error("=".repeat(60));
    console.error("Error Message:", err.message);
    console.error("Stack:", err.stack);
    console.error("=".repeat(60) + "\n");
    
    // Create error record
    try {
      const errorRecord = await createZendeskErrorImportRecord({
        startDate: req.body?.startDate || 'N/A',
        endDate: req.body?.endDate || 'N/A',
        errorMessage: err.message,
        errorDetails: err.stack || err.toString(),
        source: 'auto_import'
      });
      
      return res.status(500).json({ 
        error: "Auto-import failed", 
        details: err.message,
        step: err.step || 'unknown',
        zendeskErrorRecordId: errorRecord?.id || null,
        suggestion: getSuggestionForError(err.message)
      });
    } catch (recordError) {
      console.error("Failed to create error record:", recordError.message);
      return res.status(500).json({ 
        error: "Auto-import failed", 
        details: err.message,
        step: err.step || 'unknown',
        suggestion: getSuggestionForError(err.message)
      });
    }
  }
}

/**
 * Suggest fix based on error message
 */
function getSuggestionForError(message) {
  if (message.includes('rate')) {
    return 'Rate limited - wait a few minutes and try again';
  } else if (message.includes('401') || message.includes('authentication')) {
    return 'Check your API credentials (OPENAI_API_KEY, ZENDESK_API_TOKEN)';
  } else if (message.includes('No tickets')) {
    return 'No tickets found in the specified date range - try a different date range';
  } else if (message.includes('chunks')) {
    return 'Chunking failed - tickets might have invalid data';
  } else if (message.includes('embedding')) {
    return 'Embedding failed - check OpenAI API key and balance';
  } else if (message.includes('Pinecone')) {
    return 'Pinecone error - check connection and API key';
  }
  return 'Check the error details above';
}

/**
 * Import file to knowledge base
 * OPTIMIZED: Uses batched embeddings instead of parallel queue
 */
export async function importFile(req, res) {
  let filePath = null;
  
  try {
    if (!req.file) {
      console.error("❌ No file in request");
      console.error("Request keys:", Object.keys(req));
      console.error("File:", req.file);
      return res.status(400).json({ 
        error: "No file uploaded",
        received: {
          hasFile: !!req.file,
          requestKeys: Object.keys(req)
        }
      });
    }

    filePath = req.file.path;
    const fileName = req.file.originalname;
    const fileType = req.file.mimetype;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`📄 FILE UPLOAD STARTED`);
    console.log(`${'='.repeat(60)}`);
    console.log(`📄 File Name: ${fileName}`);
    console.log(`📋 MIME Type: ${fileType}`);
    console.log(`📦 File Path: ${filePath}`);
    console.log(`${'='.repeat(60)}\n`);

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
            source: 'manual_upload',
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
          source: 'manual_upload',
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
    console.error("\n" + "=".repeat(60));
    console.error("❌ FILE IMPORT ERROR");
    console.error("=".repeat(60));
    console.error("Error Message:", err.message);
    console.error("Error Code:", err.code);
    console.error("Stack:", err.stack);
    console.error("=".repeat(60) + "\n");

    try {
      const errorRecord = await createZendeskErrorImportRecord({
        startDate: 'N/A',
        endDate: 'N/A',
        errorMessage: err.message,
        errorDetails: err.stack || err.toString(),
        source: 'file_import'
      });

      return res.status(500).json({ 
        error: "File import failed", 
        details: err.message,
        step: err.step || 'unknown',
        zendeskErrorRecordId: errorRecord?.id || null,
        suggestion: getFileUploadSuggestion(err.message)
      });
    } catch (recordError) {
      console.error("Failed to create error record:", recordError.message);
      return res.status(500).json({ 
        error: "File import failed", 
        details: err.message,
        suggestion: getFileUploadSuggestion(err.message)
      });
    }
  } finally {
    if (filePath) {
      cleanupFile(filePath);
    }
  }
}

function getFileUploadSuggestion(message) {
  if (message.includes('No file')) {
    return 'Make sure you selected a file before uploading';
  } else if (message.includes('rate')) {
    return 'Rate limited - wait a few minutes and try again';
  } else if (message.includes('JSON')) {
    return 'File must be valid JSON format if uploading tickets';
  } else if (message.includes('embedding')) {
    return 'Embedding failed - check OpenAI API key and balance';
  } else if (message.includes('Pinecone')) {
    return 'Pinecone error - check connection and API key';
  } else if (message.includes('file')) {
    return 'File may be corrupted or in unsupported format';
  }
  return 'Check the error details above';
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

/**
 * Test pagination - fetches tickets without chunking/embedding
 * Useful for testing large date ranges and pagination
 */
export async function testPagination(req, res) {
  const startTime = Date.now();
  
  try {
    const { startDate, endDate } = req.body;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ error: "startDate and endDate are required" });
    }
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🧪 PAGINATION TEST STARTED`);
    console.log(`${'='.repeat(60)}`);
    console.log(`📅 Date Range: ${startDate} to ${endDate}`);
    console.log(`${'='.repeat(60)}\n`);
    
    // Only fetch tickets - no chunking, no embedding
    console.log(`📡 Fetching tickets...`);
    const tickets = await fetchTicketsByDateRange(startDate, endDate);
    
    const processingTime = `${((Date.now() - startTime) / 1000).toFixed(2)}s`;
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`✅ PAGINATION TEST COMPLETED`);
    console.log(`${'='.repeat(60)}`);
    console.log(`📊 Results:`);
    console.log(`   • Total Tickets: ${tickets.length}`);
    console.log(`   • Processing Time: ${processingTime}`);
    console.log(`   • Avg per ticket: ${((Date.now() - startTime) / Math.max(tickets.length, 1)).toFixed(0)}ms`);
    console.log(`${'='.repeat(60)}\n`);
    
    return res.json({
      status: "Pagination test completed",
      ticketsCount: tickets.length,
      processingTime: processingTime,
      dateRange: {
        start: startDate,
        end: endDate
      },
      avgTimePerTicket: `${((Date.now() - startTime) / Math.max(tickets.length, 1)).toFixed(0)}ms`
    });
  } catch (err) {
    const processingTime = `${((Date.now() - startTime) / 1000).toFixed(2)}s`;
    console.error("❌ Pagination test error:", err.message);
    
    res.status(500).json({
      status: "Pagination test failed",
      error: err.message,
      processingTime: processingTime
    });
  }
}