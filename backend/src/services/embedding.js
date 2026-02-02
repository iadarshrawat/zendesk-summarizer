import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

/**
 * Generate embedding for text using Google's Generative AI Embedding model
 * Uses the officially supported gemini-embedding-001 model
 * @param {string} text - Text to embed
 * @returns {Promise<number[]>} Embedding vector
 */
export async function embedText(text) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not configured");
  }

  try {
    // Use the official Google embedding model: gemini-embedding-001
    const modelName = "models/gemini-embedding-001";
    const apiVersion = "v1beta";
    const endpoint = `https://generativelanguage.googleapis.com/${apiVersion}/${modelName}:embedContent?key=${apiKey}`;
    
    const response = await axios.post(
      endpoint,
      {
        model: modelName,
        content: {
          parts: [{
            text: text
          }]
        }
      },
      {
        headers: {
          "Content-Type": "application/json"
        },
        timeout: 10000
      }
    );

    if (response.data && response.data.embedding && response.data.embedding.values) {
      return response.data.embedding.values;
    }

    throw new Error("No embedding values in response");
  } catch (error) {
    if (error.response?.status === 429) {
      throw new Error(`Rate limited by Google API: ${error.message}`);
    }
    throw new Error(
      `Failed to generate embedding: ${error.message}`
    );
  }
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