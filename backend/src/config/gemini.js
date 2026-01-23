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
  return genAI.getGenerativeModel({ model: "text-embedding-004" });
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