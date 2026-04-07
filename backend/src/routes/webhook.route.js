import express from "express";
import { 
  handleTicketCreatedWebhook, 
  handleWebhookEvent, 
  getWebhookStatus 
} from "../controllers/webhook.js";

const router = express.Router();

/**
 * Webhook routes for Zendesk ticket events
 */

// Handle ticket.created events - Auto-reply trigger
router.post("/ticket-created", handleTicketCreatedWebhook);

// General webhook event handler
router.post("/events", handleWebhookEvent);

// Get webhook status
router.get("/status", getWebhookStatus);

export default router;
