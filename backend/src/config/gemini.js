import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.GEMINI_API_KEY) {
  console.error("❌ GEMINI_API_KEY missing");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Get Gemini model instance
 * @param {string} modelName - Model name (default: gemini-2.0-flash-exp)
 * @param {object} config - Generation configuration
 */
export function getGeminiModel(
  modelName = "gemini-2.0-flash-exp",
  config = {
    temperature: 0.7,
    topP: 0.8,
    topK: 40,
  }
) {
  return genAI.getGenerativeModel({
    model: modelName,
    generationConfig: config,
  });
}

/**
 * Get embedding model
 */
export function getEmbeddingModel() {
  // Google's embedding model uses a different API
  // The correct model name is "embedding-001" or we need to use generateContent with a special format
  return genAI.getGenerativeModel({ model: "embedding-001" });
}

/**
 * List available models (for debugging)
 */
export async function listAvailableModels() {
  try {
    const response = await genAI.listModels();
    console.log("📋 Available models:");
    for await (const model of response) {
      console.log(`   - ${model.name}: ${model.displayName}`);
    }
  } catch (error) {
    console.error("❌ Could not list models:", error.message);
  }
}

/**
 * Generate content with Gemini
 * @param {string} prompt - The prompt to generate from
 * @param {object} config - Optional generation config
 */
export async function generateContent(prompt, config) {
  const model = getGeminiModel("gemini-2.0-flash-exp", config);
  const result = await model.generateContent(prompt);
  return result.response.text();
}

export default genAI;