import { Pinecone } from "@pinecone-database/pinecone";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.PINECONE_API_KEY) {
  console.error("❌ PINECONE_API_KEY missing");
  process.exit(1);
}

const INDEX_NAME = "zendesk-kb";
const DIMENSION = 768;

const pc = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY,
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
      console.log(`📦 Creating new index: ${INDEX_NAME}`);
      console.log(`⏳ This may take 30-60 seconds...`);
      
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
      
      console.log(`✅ Index created with dimension: ${DIMENSION}`);
    } else {
      console.log(`✅ Index already exists: ${INDEX_NAME}`);
      
      try {
        const indexDesc = await pc.describeIndex(INDEX_NAME);
        const indexDimension = indexDesc.dimension;
        
        console.log(`🔍 Index dimension: ${indexDimension}`);
        
        if (indexDimension !== DIMENSION) {
          console.error(`\n❌ CRITICAL ERROR: Dimension mismatch!`);
          console.error(`   Index has: ${indexDimension} dimensions`);
          console.error(`   Model produces: ${DIMENSION} dimensions`);
          console.error(`\n💡 FIX: Delete the index via /force-delete-index endpoint`);
          throw new Error(`Dimension mismatch: index=${indexDimension}, model=${DIMENSION}`);
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
 * Query vectors
 */
export async function queryVectors(vector, topK = 5, includeMetadata = true) {
  const index = await getIndex();
  return await index.query({
    vector,
    topK,
    includeMetadata,
  });
}

export { INDEX_NAME, DIMENSION, pc };