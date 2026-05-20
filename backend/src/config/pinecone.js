import { Pinecone } from "@pinecone-database/pinecone";
import dotenv from "dotenv";

dotenv.config();

// ============================================================================
// CONFIGURATION & VALIDATION
// ============================================================================

/**
 * Pinecone Vector Database Configuration
 * 
 * Pinecone stores semantic embeddings for knowledge base articles and tickets.
 * This enables similarity search for intelligent customer support responses.
 * 
 * Required environment variables:
 * - PINECONE_API_KEY: API key from Pinecone
 * 
 * Optional environment variables:
 * - PINECONE_INDEX_NAME: Index name (default: "zendesk-kb")
 * - PINECONE_DIMENSION: Vector dimension (default: 1536 for OpenAI small model)
 * - PINECONE_METRIC: Distance metric (default: "cosine")
 */
export const PINECONE_CONFIG = {
  apiKey: process.env.PINECONE_API_KEY || '',
  indexName: process.env.PINECONE_INDEX_NAME || "zendesk-kb",
  dimension: parseInt(process.env.PINECONE_DIMENSION) || 2048, // OpenAI text-embedding-3-large dimension
  metric: process.env.PINECONE_METRIC || "cosine",
  region: "us-east-1",
  cloud: "aws",
};

/**
 * Search configuration - thresholds for different content types
 */
export const SEARCH_CONFIG = {
  // Manual knowledge base articles (high quality)
  manualUpload: {
    source: "manual_upload",
    scoreThreshold: 0.7,
    topK: 5,
  },
  // Ticket-based knowledge (lower quality but contextual)
  ticketChat: {
    source: "ticket_chat",
    scoreThreshold: 0.6,
    topK: 5,
  },
};

// Validate configuration
if (!PINECONE_CONFIG.apiKey) {
  console.error("❌ PINECONE_API_KEY missing from environment");
  process.exit(1);
}

// Export constants for convenience
const INDEX_NAME = PINECONE_CONFIG.indexName;
const DIMENSION = PINECONE_CONFIG.dimension;

const pc = new Pinecone({
  apiKey: PINECONE_CONFIG.apiKey,
});

let indexCache = null;

/**
 * Initialize Pinecone index
 */
export async function initializeIndex() {
  try {
    const indexList = await pc.listIndexes();
    const indexExists = indexList.indexes?.some(idx => idx.name === INDEX_NAME);

    if (!indexExists) {
      await pc.createIndex({
        name: INDEX_NAME,
        dimension: DIMENSION,
        metric: "cosine",
        spec: {
          serverless: {
            cloud: "aws",
            region: "us-east-1",
          },
        },
      });
      
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
      try {
        const indexDesc = await pc.describeIndex(INDEX_NAME);
        const indexDimension = indexDesc.dimension;
        
        if (indexDimension !== DIMENSION) {
          console.error(`\n⚠️ Dimension mismatch detected!`);
          console.error(`   Index has: ${indexDimension} dimensions`);
          console.error(`   Model needs: ${DIMENSION} dimensions`);
          console.error(`\n� Auto-fixing: Deleting old index and creating new one...`);
          
          // Auto-delete and recreate
          await pc.deleteIndex(INDEX_NAME);
          console.log(`✅ Old index deleted`);
          
          // Wait for deletion
          await new Promise(resolve => setTimeout(resolve, 5000));
          
          console.log(`📦 Creating new index with ${DIMENSION} dimensions...`);
          await pc.createIndex({
            name: INDEX_NAME,
            dimension: DIMENSION,
            metric: "cosine",
            spec: {
              serverless: {
                cloud: "aws",
                region: "us-east-1"
              }
            }
          });
          
          console.log(`✅ New index created successfully!`);
          // Wait for new index to be ready
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
        
        console.log(`✅ Dimension verified: ${DIMENSION}`);
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

/**
 * Get Pinecone index instance
 */
export async function getIndex() {
  if (!indexCache) {
    indexCache = await initializeIndex();
  }
  return indexCache;
}

/**
 * Force delete index (for resetting)
 */
export async function deleteIndex() {
  console.log(`🗑️ Deleting index: ${INDEX_NAME}`);
  await pc.deleteIndex(INDEX_NAME);
  indexCache = null;
  console.log(`✅ Index deleted successfully`);
}

/**
 * Get index statistics
 */
export async function getIndexStats() {
  const index = await getIndex();
  const stats = await index.describeIndexStats();
  return {
    indexName: INDEX_NAME,
    dimension: DIMENSION,
    stats: stats,
  };
}

/**
 * Reset knowledge base (delete all vectors)
 */
export async function resetKnowledgeBase() {
  const index = await getIndex();
  await index.deleteAll();
  console.log("🗑️ Deleted all vectors from index:", INDEX_NAME);
}

/**
 * Upsert vectors in batches
 */
export async function upsertVectors(vectors, batchSize = 100) {
  const index = await getIndex();
  
  for (let i = 0; i < vectors.length; i += batchSize) {
    const batch = vectors.slice(i, i + batchSize);
    await index.upsert(batch);
    console.log(`✓ Uploaded batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(vectors.length/batchSize)}`);
  }
}

/**
 * Query vectors with optional metadata filtering
 * @param {number[]} vector - Embedding vector
 * @param {number} topK - Number of results to return
 * @param {boolean} includeMetadata - Include metadata in results
 * @param {object} filter - Metadata filter (e.g., { brand: { $eq: 'brand_name' } })
 */
export async function queryVectors(vector, topK = 5, includeMetadata = true, filter = null) {
  const index = await getIndex();
  
  const queryConfig = {
    vector,
    topK,
    includeMetadata,
  };
  
  if (filter) {
    queryConfig.filter = filter;
  }
  
  return await index.query(queryConfig);
}

export { INDEX_NAME, DIMENSION, pc };