/**
 * Zendesk Sunshine Conversations Controller
 * Handles customer messages through Zendesk Sunshine API
 * Messages are managed as conversations in Zendesk, not tickets
 */

import axios from "axios";
import dotenv from "dotenv";
import { generateContent } from "../config/openai.js";
import { queryVectors } from "../config/pinecone.js";
import { embedText } from "../services/embedding.js";
import { buildReplyBotPrompt, buildReplyPrompt } from "../utils/prompts.js";

dotenv.config();

/**
 * Create Sunshine Conversations API client
 * Uses Basic Auth with Key ID + Key Secret
 * Base URL: https://api.smooch.io/v2
 */
function createSunshineClient() {
  if (!process.env.SUNSHINE_KEY_ID || !process.env.SUNSHINE_KEY_SECRET) {
    throw new Error("Zendesk Sunshine credentials not configured. Need SUNSHINE_KEY_ID and SUNSHINE_KEY_SECRET");
  }

  return axios.create({
    baseURL: `https://api.smooch.io/v2`,
    headers: {
      'Content-Type': 'application/json'
    },
    auth: {
      username: process.env.SUNSHINE_KEY_ID,
      password: process.env.SUNSHINE_KEY_SECRET
    }
  });
}

/**
 * Handle incoming message from Zendesk Sunshine webhook
 * Zendesk sends: account_id, event (with message, conversation_id), type, etc.
 */
export async function handleSunshineMessage(req, res) {
  try {
    console.log("📨 Zendesk webhook received:", JSON.stringify(req.body, null, 2));

    const payload = req.body;

    // Extract from Zendesk's webhook structure
    if (!payload.event || !payload.event.message || !payload.event.conversation_id) {
      console.error("❌ Missing required fields. Payload:", payload);
      return res.status(400).json({ 
        error: "Invalid payload structure",
        expected: "event.message.body, event.conversation_id, event.actor"
      });
    }

    const conversationId = payload.event.conversation_id;
    const messageBody = payload.event.message.body;
    const messageId = payload.event.message.id;
    const actor = payload.event.actor;

    // Skip if this is a bot/system/agent message (don't reply to our own replies)
    if (
      actor.type === "system" || 
      actor.type === "business" ||
      actor.id?.includes("bot") || 
      actor.id?.includes("answerBot")
    ) {
      console.log("⏭️ Skipping system/bot/agent message");
      return res.status(200).json({ success: true, skipped: true, reason: "Non-user message" });
    }

    // Only process end_user messages
    if (actor.type !== "end_user") {
      console.log(`⏭️ Skipping message from actor type: ${actor.type}`);
      return res.status(200).json({ success: true, skipped: true, reason: `Actor type: ${actor.type}` });
    }

    // Send 200 immediately so Zendesk doesn't timeout
    res.status(200).json({ success: true, received: true });

    console.log(`💬 Processing message: "${messageBody}"`);

    // Default values
    const userName = actor.name || "Customer";
    const brand = "default_brand";

    // Step 1: Generate embedding for the customer message
    let messageEmbedding;
    try {
      messageEmbedding = await embedText(messageBody);
    } catch (err) {
      console.error("❌ Embedding error:", err.message);
      messageEmbedding = null;
    }

    // Step 2: Search knowledge base (2-phase search)
    let selectedArticles = [];

    if (messageEmbedding) {
      try {
        // PHASE 1: Search manually uploaded KB with higher threshold (0.7)
        const phase1Results = await queryVectors(
          messageEmbedding,
          10,
          { source: "manual_upload", brand: brand }
        );

        const phase1Filtered = phase1Results.filter(r => r.score >= 0.7);

        if (phase1Filtered.length > 0) {
          selectedArticles = phase1Filtered.slice(0, 5);
          console.log(`✅ PHASE 1 (Manual KB) found ${phase1Filtered.length} results`);
        } else {
          // PHASE 2: Fall back to ticket conversations with lower threshold (0.6)
          console.log(`⏳ PHASE 1 found no results, trying PHASE 2...`);
          const phase2Results = await queryVectors(
            messageEmbedding,
            10,
            { source: "ticket_chat", brand: brand }
          );

          const phase2Filtered = phase2Results.filter(r => r.score >= 0.6);
          if (phase2Filtered.length > 0) {
            selectedArticles = phase2Filtered.slice(0, 5);
            console.log(`✅ PHASE 2 (Ticket Chat) found ${phase2Filtered.length} results`);
          } else {
            console.log(`⚠️ PHASE 2 also found no results`);
          }
        }
      } catch (err) {
        console.error("⚠️ KB search error:", err.message);
      }
    }

    // Step 2.5: Check if customer wants to create a ticket
    let ticketCreated = false;
    try {
      const wantsTicket = await shouldCreateTicket(messageBody);
      if (wantsTicket) {
        console.log("🎫 Customer requesting ticket creation...");
        const ticketId = await createZendeskTicket(messageBody, conversationId, userName);
        ticketCreated = true;
        
        // Send escalation message
        await sendTicketEscalationMessage(conversationId, ticketId);
        console.log(`✅ Ticket #${ticketId} created and notified to customer`);
        
        // Skip bot reply for ticket creation - customer already got escalation message
        return;
      }
    } catch (err) {
      console.error("⚠️ Ticket creation check failed:", err.message);
      // Continue with normal flow if ticket creation fails
    }

    // Step 3: Generate reply using OpenAI
    let botReply;
    try {
      const prompt = buildReplyBotPrompt(messageBody, selectedArticles, brand);
      botReply = await generateContent(prompt);
      console.log(`✅ Generated reply: "${botReply.substring(0, 100)}..."`);
    } catch (err) {
      console.error("❌ OpenAI generation error:", err.message);
      botReply = "I'm sorry, I encountered an issue generating a response. Please try again.";
    }

    // Step 4: Send bot reply back through Sunshine API
    try {
      await sendSunshineMessage(conversationId, botReply);
    } catch (err) {
      console.error("❌ Failed to send reply:", err.message);
    }

  } catch (err) {
    console.error("❌ Error handling Zendesk webhook:", err.message);
    // Only send error response if headers not already sent
    if (!res.headersSent) {
      res.status(500).json({
        error: "Failed to process message",
        details: err.message,
      });
    }
  }
}

/**
 * Send bot reply back to Zendesk Sunshine Conversations
 * Uses correct Sunshine API v2 endpoint and payload format
 */
async function sendSunshineMessage(conversationId, message) {
  try {
    if (!process.env.SUNSHINE_APP_ID) {
      throw new Error("SUNSHINE_APP_ID not configured in .env");
    }

    const sunshineClient = createSunshineClient();

    // Correct payload format for Sunshine Conversations API v2
    const payload = {
      author: { 
        type: "business" 
      },
      content: { 
        type: "text", 
        text: message 
      }
    };

    console.log(`📤 Sending Sunshine message to conversation: ${conversationId}`);

    const response = await sunshineClient.post(
      `/apps/${process.env.SUNSHINE_APP_ID}/conversations/${conversationId}/messages`,
      payload
    );

    console.log(`✅ Message sent successfully!`);
    return response.data;

  } catch (err) {
    console.error("❌ Failed to send Sunshine message:", err.response?.data || err.message);
    throw err;
  }
}

/**
 * Get conversation details
 */
export async function getConversation(req, res) {
  try {
    const { conversationId } = req.params;

    if (!conversationId) {
      return res.status(400).json({ error: "conversationId is required" });
    }

    const sunshineClient = createSunshineClient();
    const response = await sunshineClient.get(
      `/apps/${process.env.SUNSHINE_APP_ID}/conversations/${conversationId}`
    );

    res.json(response.data);

  } catch (err) {
    console.error("❌ Error fetching conversation:", err.message);
    res.status(500).json({
      error: "Failed to fetch conversation",
      details: err.message,
    });
  }
}

/**
 * Get conversation history (messages) via API
 */
export async function getConversationHistoryAPI(req, res) {
  try {
    const { conversationId } = req.params;

    if (!conversationId) {
      return res.status(400).json({ error: "conversationId is required" });
    }

    const sunshineClient = createSunshineClient();
    const response = await sunshineClient.get(
      `/apps/${process.env.SUNSHINE_APP_ID}/conversations/${conversationId}/messages`
    );

    res.json({
      conversationId,
      messageCount: response.data.messages?.length || 0,
      messages: response.data.messages || [],
    });

  } catch (err) {
    console.error("❌ Error fetching conversation history:", err.message);
    res.status(500).json({
      error: "Failed to fetch conversation history",
      details: err.message,
    });
  }
}

/**
 * Health check for Sunshine integration
 */
export async function getSunshineStatus(req, res) {
  try {
    const sunshineClient = createSunshineClient();

    const response = await sunshineClient.get(
      `/apps/${process.env.SUNSHINE_APP_ID}`
    );

    res.json({
      status: "ok",
      message: "Sunshine Conversations API is connected",
      appId: process.env.SUNSHINE_APP_ID,
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    console.error("❌ Sunshine status error:", err.message);
    res.status(500).json({
      status: "error",
      message: "Failed to connect to Sunshine Conversations API",
      details: err.message,
    });
  }
}

/**
 * Configure webhook - Call this once to set up the incoming webhook
 * POST /sunshine/configure-webhook with:
 * { webhookUrl: "https://your-backend.com/sunshine/webhook" }
 */
export async function configureWebhook(req, res) {
  try {
    const { webhookUrl } = req.body;

    if (!webhookUrl) {
      return res.status(400).json({ error: "webhookUrl is required" });
    }

    const sunshineClient = createSunshineClient();

    const payload = {
      target: webhookUrl,
      triggers: [
        "conversation:message",
      ],
    };

    console.log(`🔧 Configuring webhook: ${webhookUrl}`);

    const response = await sunshineClient.post(
      `/apps/${process.env.SUNSHINE_APP_ID}/webhooks`,
      payload
    );

    res.json({
      success: true,
      webhookId: response.data.webhook?.id,
      message: "Webhook configured successfully",
    });

  } catch (err) {
    console.error("❌ Webhook configuration error:", err.message);
    res.status(500).json({
      error: "Failed to configure webhook",
      details: err.message,
    });
  }
}

/**
 * Detect if customer is asking to create a ticket
 * Uses LLM to analyze message intent
 */
async function shouldCreateTicket(messageBody) {
  try {
    const detectionPrompt = `You are a message analyzer. Determine if the customer is requesting to create a support ticket or speak with an agent.

Common phrases:
- "create a ticket"
- "I need to speak with an agent"
- "I want to file a complaint"
- "I need help from support team"
- "Can I get human support?"
- "Connect me to an agent"
- "This needs escalation"
- "I need professional help"

Customer message: "${messageBody}"

Respond ONLY with "yes" or "no". Nothing else.`;

    const response = await generateContent(detectionPrompt);
    return response.toLowerCase().trim() === "yes";
  } catch (err) {
    console.error("⚠️ Error detecting ticket request:", err.message);
    return false;
  }
}

/**
 * Create a Zendesk ticket from chat conversation
 * Ticket is created in a specific group for agent routing
 */
async function createZendeskTicket(messageBody, conversationId, customerName) {
  try {
    if (!process.env.ZENDESK_DOMAIN || !process.env.ZENDESK_EMAIL || !process.env.ZENDESK_API_TOKEN) {
      throw new Error("Zendesk credentials not configured");
    }

    // Configuration - Customize these values
    const SUPPORT_GROUP_ID = process.env.ZENDESK_SUPPORT_GROUP_ID || 360003951132; // Default support group
    const TICKET_SUBJECT = `Chat Support Request - ${conversationId.substring(0, 8)}`;

    const ticketData = {
      ticket: {
        subject: TICKET_SUBJECT,
        description: messageBody,
        requester: {
          name: customerName,
          email: process.env.ZENDESK_EMAIL // Use system email, agent will update if needed
        },
        group_id: SUPPORT_GROUP_ID,
        tags: ["sunshine_chat", "auto_created"],
        custom_fields: {
          360015632651: conversationId // Store Sunshine conversation ID for reference
        }
      }
    };

    const basicAuth = Buffer.from(
      `${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`
    ).toString("base64");

    const response = await axios.post(
      `https://${process.env.ZENDESK_DOMAIN}.zendesk.com/api/v2/tickets`,
      ticketData,
      {
        headers: {
          Authorization: `Basic ${basicAuth}`,
          "Content-Type": "application/json"
        }
      }
    );

    const ticketId = response.data.ticket.id;
    console.log(`✅ Ticket created: #${ticketId}`);
    return ticketId;

  } catch (err) {
    console.error("❌ Failed to create Zendesk ticket:", err.response?.data || err.message);
    throw err;
  }
}

/**
 * Send ticket escalation message to customer
 */
async function sendTicketEscalationMessage(conversationId, ticketId) {
  try {
    const message = `I've created ticket #${ticketId} for you. An agent from our support team will get in touch shortly to help you further. You'll receive updates via email and here in the chat.`;
    await sendSunshineMessage(conversationId, message);
  } catch (err) {
    console.error("⚠️ Failed to send escalation message:", err.message);
  }
}
