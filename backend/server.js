import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import { initializeIndex, deleteIndex } from "./src/config/pinecone.js";
import { createCustomObjectType } from "./src/config/zendesk.js";
import navbarRoutes from "./src/routes/navbar.route.js";
import sidebarRoutes from "./src/routes/sidebar.route.js";
import editorRoutes from "./src/routes/editor.route.js";

dotenv.config();

/* ================= APP SETUP ================= */

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

/* ================= ROUTES ================= */

// Navbar routes (Import functionality)
app.use(navbarRoutes);

// Sidebar routes (Summary functionality)
app.use(sidebarRoutes);

// Editor routes (Reply functionality)
app.use(editorRoutes);

/* ================= UTILITY ENDPOINTS ================= */

// Force delete index (for dimension mismatch issues)
app.delete("/force-delete-index", async (req, res) => {
  try {
    await deleteIndex();
    
    res.json({ 
      status: "Index deleted successfully",
      message: "Restart the server now to create a new index with dimension=768"
    });
  } catch (err) {
    console.error("❌ Delete error:", err);
    res.status(500).json({ 
      error: "Failed to delete index", 
      details: err.message 
    });
  }
});

// Health check
app.get("/health", (_, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

/* ================= DEBUG ENDPOINTS (Optional) ================= */

// Debug custom object in Zendesk
app.get("/debug-custom-object", async (_, res) => {
  try {
    const { createZendeskClient } = await import("./src/config/zendesk.js");
    const zendeskClient = createZendeskClient();
    
    const objectResponse = await zendeskClient.get('/custom_objects/kb_import_log_v3');
    const objectInfo = objectResponse.data.custom_object;
    
    const recordsResponse = await zendeskClient.get('/custom_objects/kb_import_log_v3/records?limit=10');
    
    let records = recordsResponse.data.records || 
                  recordsResponse.data.custom_object_records || 
                  [];
    
    res.json({
      status: "ok",
      customObject: {
        id: objectInfo.id,
        key: objectInfo.key,
        title: objectInfo.title,
        fields: objectInfo.custom_object_fields?.map(f => ({ 
          key: f.key, 
          type: f.type, 
          title: f.title 
        })) || "NO FIELDS FOUND",
      },
      recordCount: records?.length || 0,
      recentRecords: records?.slice(0, 5)
    });
  } catch (err) {
    res.status(400).json({
      error: err.message,
      details: err.response?.data
    });
  }
});

// Recreate custom object
app.post("/recreate-custom-object", async (_, res) => {
  try {
    const { createZendeskClient } = await import("./src/config/zendesk.js");
    const zendeskClient = createZendeskClient();
    
    console.log(`🗑️ Attempting to delete old custom object...`);
    
    try {
      await zendeskClient.delete('/custom_objects/kb_import_log_v3');
      console.log(`✅ Old custom object deleted`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (deleteErr) {
      console.log(`⚠️ Could not delete old object:`, deleteErr.message);
    }
    
    const result = await createCustomObjectType();
    
    if (result) {
      res.json({
        status: "Custom object recreated successfully",
        message: "The custom object has been deleted and recreated with proper fields"
      });
    } else {
      res.status(500).json({
        status: "Failed to recreate custom object",
        message: "Check server logs for details"
      });
    }
  } catch (err) {
    res.status(400).json({
      error: err.message,
      details: err.response?.data
    });
  }
});

/* ================= SERVER STARTUP ================= */

async function startServer() {
  try {
    console.log("🚀 Starting server...");
    console.log("🔧 Initializing Pinecone...");
    
    // Create uploads directory if it doesn't exist
    if (!fs.existsSync('uploads')) {
      fs.mkdirSync('uploads');
    }
    
    // Initialize Pinecone index
    await initializeIndex();
    
    // Setup Zendesk custom object (if credentials available)
    if (process.env.ZENDESK_EMAIL && process.env.ZENDESK_API_TOKEN && process.env.ZENDESK_DOMAIN) {
      console.log("🔧 Setting up Zendesk custom object...");
      await createCustomObjectType();
    }
    
    app.listen(PORT, () => {
      console.log(`\n✅ Server running successfully!`);
      console.log(`🌐 URL: http://localhost:${PORT}`);
      console.log(`\n📍 Available endpoints:`);
      console.log(`\n🔹 NAVBAR (Import):`);
      console.log(`  POST   /auto-import-tickets  - Auto-import tickets from Zendesk`);
      console.log(`  POST   /import-file          - Import file to knowledge base`);
      console.log(`  POST   /ingest-kb            - Ingest knowledge base articles`);
      console.log(`  DELETE /reset-kb             - Reset knowledge base`);
      console.log(`  GET    /index-stats          - Get index statistics`);
      console.log(`\n🔹 SIDEBAR (Summary):`);
      console.log(`  POST   /summarize            - Summarize a ticket`);
      console.log(`  POST   /translate            - Translate text`);
      console.log(`\n🔹 EDITOR (Reply):`);
      console.log(`  POST   /compose-reply        - Generate RAG-based reply`);
      console.log(`  POST   /debug-search         - Debug article search`);
      console.log(`\n🔹 UTILITY:`);
      console.log(`  GET    /health               - Health check`);
      console.log(`  DELETE /force-delete-index   - Force delete Pinecone index`);
      console.log(`\n💡 Tip: Test with: curl http://localhost:${PORT}/health\n`);
    });
  } catch (err) {
    console.error("❌ Failed to start server:", err);
    process.exit(1);
  }
}

startServer();