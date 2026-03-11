import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY missing");
  process.exit(1);
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/**
 * Generate content with OpenAI
 * @param {string} prompt - The prompt to generate from
 * @param {object} config - Optional generation config
 * @param {string} modelName - Model to use (default: gpt-4-turbo)
 */
export async function generateContent(prompt, config = {}, modelName = "gpt-4-turbo") {
  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: modelName,
        messages: [
          {
            role: "system",
            content: "You are a helpful customer support assistant. Provide clear, concise, and helpful responses."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: config.temperature || 0.7,
        top_p: config.topP || 0.8,
        max_tokens: config.maxTokens || 2000,
      },
      {
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 60000 // 60 seconds
      }
    );

    if (!response.data.choices || response.data.choices.length === 0) {
      throw new Error("No choices in OpenAI response");
    }

    return response.data.choices[0].message.content;
  } catch (error) {
    if (error.response?.status === 429) {
      throw new Error(`OpenAI rate limited: ${error.message}`);
    } else if (error.response?.status === 401) {
      throw new Error(`OpenAI authentication failed: Invalid API key`);
    } else if (error.response?.status === 500) {
      throw new Error(`OpenAI server error: ${error.message}`);
    } else {
      throw new Error(`OpenAI generation failed: ${error.message}`);
    }
  }
}

/**
 * List available models (for debugging)
 */
export async function listAvailableModels() {
  try {
    const response = await axios.get(
      "https://api.openai.com/v1/models",
      {
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`
        }
      }
    );
    
    console.log("📋 Available OpenAI models:");
    const gptModels = response.data.data.filter(m => m.id.includes("gpt"));
    gptModels.slice(0, 10).forEach(model => {
      console.log(`   - ${model.id}`);
    });
    console.log(`   ... and ${gptModels.length - 10} more models`);
  } catch (error) {
    console.error("❌ Could not list models:", error.message);
  }
}

export { OPENAI_API_KEY };
