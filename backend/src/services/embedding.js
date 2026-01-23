import { getEmbeddingModel } from "../config/gemini.js";

/**
 * Generate embedding for text
 * @param {string} text - Text to embed
 * @returns {Promise<number[]>} Embedding vector
 */
export async function embedText(text) {
  const model = getEmbeddingModel();
  const result = await model.embedContent(text);
  return result.embedding.values;
}

/**
 * Generate embeddings for multiple texts in batch
 * @param {string[]} texts - Array of texts to embed
 * @returns {Promise<number[][]>} Array of embedding vectors
 */
export async function embedTextBatch(texts) {
  const embeddings = [];
  
  for (const text of texts) {
    const embedding = await embedText(text);
    embeddings.push(embedding);
  }
  
  return embeddings;
}