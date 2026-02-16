import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fetch from "node-fetch";

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function testGemini() {
  console.log("🔍 Checking available Gemini models...\n");
  
  try {
    // Use direct API call to list models
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`
    );
    
    const data = await response.json();
    
    if (!response.ok) {
      console.error("❌ API Error:", data);
      console.log("\nTrying alternative models...\n");
      await testAlternativeModels();
      return;
    }
    
    const models = data.models || [];
    
    console.log("📋 All available models:");
    console.log("================================\n");
    
    const generativeModels = [];
    
    for (const model of models) {
      const modelName = model.name.split("/")[1];
      console.log(`📌 Model: ${modelName}`);
      console.log(`   Display Name: ${model.displayName}`);
      console.log(`   Supported Methods: ${model.supportedGenerationMethods?.join(", ") || "N/A"}`);
      
      // Check if this model supports generateContent
      if (model.supportedGenerationMethods?.includes("generateContent")) {
        console.log(`   ✅ Supports generateContent`);
        generativeModels.push(modelName);
      } else {
        console.log(`   ❌ Does NOT support generateContent`);
      }
      console.log("");
    }
    
    if (generativeModels.length > 0) {
      console.log("\n✅ MODELS AVAILABLE FOR generateContent:");
      console.log("================================");
      generativeModels.forEach((model) => {
        console.log(`  - ${model}`);
      });
      
      // Test the first available model
      const firstModel = generativeModels[0];
      
      console.log(`\n🧪 Testing with: ${firstModel}`);
      const model = genAI.getGenerativeModel({ model: firstModel });
      const result = await model.generateContent("Say 'Hello, Gemini is working!'");
      console.log(`✅ Response: ${result.response.text()}`);
      
      console.log(`\n✅ USE THIS MODEL: "${firstModel}"`);
    } else {
      console.log("\n❌ No models available for generateContent!");
    }
    
  } catch (error) {
    console.error("❌ Error:", error.message);
    console.log("\nTrying alternative models...\n");
    await testAlternativeModels();
  }
}

async function testAlternativeModels() {
  const modelsToTry = [
    "gemini-pro",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
    "gemini-2.0-flash",
    "gemini-2.0-pro"
  ];
  
  console.log("Testing common models:\n");
  
  for (const modelName of modelsToTry) {
    try {
      console.log(`🧪 Testing ${modelName}...`);
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent("test");
      console.log(`✅ ${modelName} WORKS!\n`);
      console.log(`✅ USE THIS MODEL: "${modelName}"`);
      return;
    } catch (error) {
      console.log(`❌ ${modelName} failed: ${error.message}\n`);
    }
  }
  
  console.log("❌ None of the common models are available!");
}

testGemini();
