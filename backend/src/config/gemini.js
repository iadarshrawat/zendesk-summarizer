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
 * @param {string} modelName - Model name (default: gemini-2.5-flash)
 * @param {object} config - Generation configuration
 */
export function getGeminiModel(
  modelName = "gemini-2.5-flash",
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
  return genAI.getGenerativeModel({ model: "text-embedding-004" });
}

/**
 * List available models (for debugging)
 */
export async function listAvailableModels() {
  try {
    const models = await genAI.listModels();
    console.log("📋 Available models:");
    for (const model of models) {
      console.log(`   - ${model.name}`);
      console.log(`     Display Name: ${model.displayName}`);
      console.log(`     Description: ${model.description}`);
      console.log(`     Supported Methods: ${model.supportedGenerationMethods.join(", ")}`);
      console.log("");
    }
  } catch (error) {
    console.error("❌ Could not list models:", error.message);
  }
}

/**
 * Generate content with Gemini
 * @param {string} prompt - The prompt to generate from
 * @param {object} config - Optional generation config
 * @param {string} modelName - Model to use (default: gemini-2.5-flash)
 */
export async function generateContent(prompt, config, modelName = "gemini-2.5-flash") {
  const model = getGeminiModel(modelName, config);
  const result = await model.generateContent(prompt);
  return result.response.text();
}

export default genAI;