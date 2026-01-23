import express from "express";
import { summarizeTicket } from "../controllers/sidebar.js";

const router = express.Router();

// Summarize a ticket
router.post("/summarize", summarizeTicket);

export default router;