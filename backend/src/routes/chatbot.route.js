import express from "express";
import {
  initializeConversation,
  handleChatMessage,
  getConversationHistory,
  endConversation,
  getConversationsStats,
} from "../controllers/chatbot.js";

const router = express.Router();

/**
 * Chatbot routes - Customer support via web widget (no tickets)
 */

// Initialize a new conversation session
router.post("/chat/init", initializeConversation);

// Send message and get bot reply
router.post("/chat/message", handleChatMessage);

// Get conversation history
router.get("/chat/history/:sessionId", getConversationHistory);

// End conversation
router.post("/chat/end", endConversation);

// Get chatbot statistics
router.get("/chat/stats", getConversationsStats);

export default router;
