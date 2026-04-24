import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import { initializeIndex, deleteIndex } from "./src/config/pinecone.js";
import { createCustomObjectType } from "./src/config/zendesk.js";
import navbarRoutes from "./src/routes/navbar.route.js";
import sidebarRoutes from "./src/routes/sidebar.route.js";
import editorRoutes from "./src/routes/editor.route.js";
import sunshineRoutes from "./src/routes/sunshine.route.js";

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

// Sunshine routes (Chat widget functionality)
app.use(sunshineRoutes);

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
    
    try {
      await zendeskClient.delete('/custom_objects/kb_import_log_v3');
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (deleteErr) {
      // Custom object may not exist, continue
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
    // Create uploads directory if it doesn't exist
    if (!fs.existsSync('uploads')) {
      fs.mkdirSync('uploads');
    }
    
    // Start listening immediately
    app.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}`);
      
      // Initialize Pinecone in background (with timeout)
      Promise.race([
        initializeIndex(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000))
      ]).catch(err => {
        console.error("Pinecone initialization failed:", err.message);
      });
      
      // Setup Zendesk custom object in background (with timeout)
      if (process.env.ZENDESK_EMAIL && process.env.ZENDESK_API_TOKEN && process.env.ZENDESK_DOMAIN) {
        Promise.race([
          createCustomObjectType(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000))
        ]).catch(err => {
          console.error("Zendesk setup error:", err.message);
        });
      }
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

startServer();
