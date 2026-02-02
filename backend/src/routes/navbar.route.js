import express from "express";
import { upload } from "../middleware/upload.js";
import {
  autoImportTickets,
  importFile,
  ingestKB,
  resetKB,
  getStats
} from "../controllers/navbar.js";

const router = express.Router();

// Auto-import tickets from Zendesk by date range
router.post("/auto-import-tickets", autoImportTickets);

// Import file to knowledge base
router.post("/import-file", upload.single('file'), importFile);

// Ingest knowledge base articles
router.post("/ingest-kb", ingestKB);

// Reset knowledge base
router.delete("/reset-kb", resetKB);

// Get index statistics
router.get("/index-stats", getStats);

export default router;