import express from "express";
import {
  handleSunshineMessage,
  getConversation,
  getConversationHistoryAPI,
  getSunshineStatus,
  configureWebhook,
} from "../controllers/sunshine.js";

const router = express.Router();

/**
 * Sunshine Conversations Routes
 * Handles chatbot integration through Zendesk Sunshine API
 */

// Incoming webhook from Zendesk Sunshine (customer messages)
router.post("/sunshine/webhook", handleSunshineMessage);

// Get specific conversation details
router.get("/sunshine/conversation/:conversationId", getConversation);

// Get conversation history (messages)
router.get("/sunshine/history/:conversationId", getConversationHistoryAPI);

// Health check for Sunshine integration
router.get("/sunshine/status", getSunshineStatus);

// Configure webhook URL (run once during setup)
router.post("/sunshine/configure-webhook", configureWebhook);

export default router;
