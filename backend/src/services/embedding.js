import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

// Rate limiting configuration for OpenAI
const RATE_LIMIT = {
  requestsPerMinute: 3500,
  delayBetweenRequests: 20,
  maxRetries: 5,
  baseRetryDelay: 1000
};

// Simple in-memory cache to avoid re-embedding identical text
const embeddingCache = new Map();

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generate embedding for text using OpenAI's embedding model
 * Uses text-embedding-3-small (1536 dimensions)
 * Includes rate limiting, retry logic, and caching
 * Truncates text to 7000 chars (~1750 tokens) to stay safely under 8192 limit
 * @param {string} text - Text to embed
 * @param {boolean} useCache - Whether to use cache (default: true)
 * @returns {Promise<number[]>} Embedding vector (1536 dimensions)
 */
export async function embedText(text, useCache = true) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not configured");
  }

  // Truncate text to 7000 chars (~1750 tokens) to be safe
  // OpenAI limit is 8192 tokens, but we're conservative
  const MAX_CHARS = 7000;
  let processText = text;
  if (text.length > MAX_CHARS) {
    console.log(`⚠️  Truncating long chunk from ${text.length} to ${MAX_CHARS} chars`);
    processText = text.substring(0, MAX_CHARS) + '... [truncated]';
  }

  if (useCache && embeddingCache.has(processText)) {
    console.log(`💾 Cache hit for text (${processText.substring(0, 30)}...)`);
    return embeddingCache.get(processText);
  }

  const endpoint = `https://api.openai.com/v1/embeddings`;
  
  let lastError = null;
  
  for (let attempt = 0; attempt < RATE_LIMIT.maxRetries; attempt++) {
    try {
      // Add delay between requests to respect rate limits
      if (attempt > 0 || embeddingCache.size > 0) {
        await sleep(RATE_LIMIT.delayBetweenRequests);
      }
      
      const response = await axios.post(
        endpoint,
        {
          model: "text-embedding-3-small",
          input: processText,
          encoding_format: "float"
        },
        {
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          timeout: 60000
        }
      );

      if (response.data && response.data.data && response.data.data[0]?.embedding) {
        const embedding = response.data.data[0].embedding;
        
        // Cache the result (use processText as key)
        if (useCache) {
          embeddingCache.set(processText, embedding);
        }
        
        return embedding;
      }

      throw new Error("No embedding values in response");
      
    } catch (error) {
      lastError = error;
      
      // Log detailed error info on first attempt
      if (attempt === 0) {
        console.error(`❌ Embedding API error:`, {
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data,
          message: error.message
        });
      }
      
      // Handle rate limiting (429) - parse OpenAI's retry-after header
      if (error.response?.status === 429) {
        const retryAfter = error.response?.headers?.['retry-after'] || RATE_LIMIT.baseRetryDelay * Math.pow(2, attempt);
        const retryDelay = parseFloat(retryAfter) * 1000 || RATE_LIMIT.baseRetryDelay * Math.pow(2, attempt);
        console.warn(`⚠️ Rate limited (attempt ${attempt + 1}/${RATE_LIMIT.maxRetries}). Waiting ${(retryDelay / 1000).toFixed(1)}s...`);
        await sleep(retryDelay);
        continue;
      }
      
      // Handle 404 errors
      if (error.response?.status === 404) {
        console.error(`❌ 404 Error - Model not found`);
        console.error(`   Endpoint: ${endpoint}`);
        console.error(`   Response:`, error.response?.data);
        throw new Error(`Model not available. The API returned: ${error.response?.data?.error?.message || 'Model not found'}`);
      }
      
      // Handle server errors (500, 503) with exponential backoff
      if (error.response?.status >= 500) {
        const retryDelay = RATE_LIMIT.baseRetryDelay * Math.pow(2, attempt);
        console.warn(`⚠️ Server error ${error.response.status} (attempt ${attempt + 1}/${RATE_LIMIT.maxRetries}). Waiting ${retryDelay}ms...`);
        await sleep(retryDelay);
        continue;
      }
      
      // Network errors - retry with exponential backoff
      if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
        const retryDelay = RATE_LIMIT.baseRetryDelay * Math.pow(2, attempt);
        console.warn(`⚠️ Network error (attempt ${attempt + 1}/${RATE_LIMIT.maxRetries}). Waiting ${retryDelay}ms...`);
        await sleep(retryDelay);
        continue;
      }
      
      // Handle timeout errors (also retry)
      if (error.message.includes('timeout')) {
        const retryDelay = RATE_LIMIT.baseRetryDelay * Math.pow(2, attempt);
        console.warn(`⚠️ Request timeout (attempt ${attempt + 1}/${RATE_LIMIT.maxRetries}). Waiting ${retryDelay}ms...`);
        await sleep(retryDelay);
        continue;
      }
      
      // For other errors, fail immediately
      console.error(`❌ Unrecoverable error: ${error.message}`);
      throw error;
    }
  }

  throw new Error(
    `Failed to generate embedding after ${RATE_LIMIT.maxRetries} attempts: ${lastError?.message || 'Unknown error'}`
  );
}

/**
 * Generate embeddings for multiple texts in batch with intelligent rate limiting
 * Uses OpenAI's text-embedding-3-small (fast and cheap)
 * @param {string[]} texts - Array of texts to embed
 * @param {object} options - Options for batch processing
 * @param {number} options.batchSize - Number of texts to process before a longer pause (default: 50 for OpenAI)
 * @param {number} options.batchDelay - Delay in ms between batches (default: 5000ms = 5 seconds for OpenAI)
 * @param {function} options.onProgress - Callback for progress updates (progress, total)
 * @returns {Promise<number[][]>} Array of embedding vectors (each 1536 dimensions)
 */
export async function embedTextBatch(texts, options = {}) {
  const {
    batchSize = 50,
    batchDelay = 5000,
    onProgress = null
  } = options;
  
  const embeddings = [];
  const totalTexts = texts.length;
  
  console.log(`🔄 Starting batch embedding for ${totalTexts} texts...`);
  console.log(`📊 Settings: ${batchSize} per batch, ${batchDelay}ms delay between batches`);
  
  for (let i = 0; i < totalTexts; i++) {
    const text = texts[i];
    
    try {
      const embedding = await embedText(text, true);
      embeddings.push(embedding);
      
      // Progress callback
      if (onProgress) {
        onProgress(i + 1, totalTexts);
      }
      
      // Log progress every 50 items
      if ((i + 1) % 50 === 0) {
        console.log(`✓ Processed ${i + 1}/${totalTexts} embeddings (${Math.round((i + 1) / totalTexts * 100)}%)`);
      }
      
      // Longer pause between batches to avoid sustained rate limiting
      if ((i + 1) % batchSize === 0 && i + 1 < totalTexts) {
        console.log(`⏸️  Batch complete (${i + 1}/${totalTexts}). Pausing ${batchDelay}ms...`);
        await sleep(batchDelay);
      }
      
    } catch (error) {
      console.error(`❌ Failed to embed text ${i + 1}/${totalTexts}:`, error.message);
      console.error(`   Text preview: "${text.substring(0, 100)}..."`);
      
      // Decide whether to fail fast or skip and continue
      throw error; // Fail fast - you can change this to continue on error
    }
  }
  
  console.log(`✅ Batch embedding complete: ${embeddings.length}/${totalTexts} successful`);
  console.log(`💾 Cache size: ${embeddingCache.size} entries`);
  
  return embeddings;
}

/**
 * Clear embedding cache
 */
export function clearEmbeddingCache() {
  const size = embeddingCache.size;
  embeddingCache.clear();
  console.log(`🗑️  Cleared ${size} cached embeddings`);
}

/**
 * Get cache statistics
 */
export function getCacheStats() {
  return {
    size: embeddingCache.size,
    estimatedMemoryMB: (embeddingCache.size * 768 * 8) / (1024 * 1024) // rough estimate
  };
}

/**
 * Parallel batch embedding with controlled concurrency
 * WARNING: Use with caution - can quickly hit rate limits if concurrency is too high
 * @param {string[]} texts - Array of texts to embed
 * @param {number} concurrency - Number of parallel requests (default: 3, max recommended: 5)
 * @returns {Promise<number[][]>} Array of embedding vectors
 */
export async function embedTextBatchParallel(texts, concurrency = 3) {
  console.log(`🚀 Starting parallel batch embedding (concurrency: ${concurrency})...`);
  
  const results = new Array(texts.length);
  const chunks = [];
  
  // Split texts into chunks for parallel processing
  for (let i = 0; i < texts.length; i += concurrency) {
    chunks.push(texts.slice(i, i + concurrency));
  }
  
  let processed = 0;
  
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex];
    
    // Process chunk in parallel
    const promises = chunk.map((text, idx) => {
      const globalIndex = chunkIndex * concurrency + idx;
      return embedText(text, true)
        .then(embedding => {
          results[globalIndex] = embedding;
          processed++;
          
          if (processed % 50 === 0) {
            console.log(`✓ Processed ${processed}/${texts.length} embeddings (${Math.round(processed / texts.length * 100)}%)`);
          }
        })
        .catch(error => {
          console.error(`❌ Failed to embed text ${globalIndex + 1}:`, error.message);
          throw error;
        });
    });
    
    await Promise.all(promises);
    
    // Small delay between chunks
    if (chunkIndex < chunks.length - 1) {
      await sleep(200);
    }
  }
  
  console.log(`✅ Parallel embedding complete: ${results.length} embeddings`);
  return results.filter(r => r !== undefined);
}