import axios from "axios";
import { generateContent } from "../config/openai.js";
import { queryVectors } from "../config/pinecone.js";
import { embedText } from "../services/embedding.js";
import { buildReplyPrompt } from "../utils/prompts.js";

/**
 * Webhook handler for Zendesk ticket.created events
 * Automatically generates and sends AI reply to new tickets
 */
export async function handleTicketCreatedWebhook(req, res) {
  try {
    console.log("🔔 Webhook received:", req.body.event_type || "unknown");
    
    // Acknowledge webhook immediately (Zendesk expects 200 OK within 10s)
    res.status(200).json({ status: "received" });

    const { data } = req.body;
    
    if (!data || !data.id) {
      console.warn("⚠️ Invalid webhook payload - missing ticket data");
      return;
    }

    const ticketId = data.id;
    const subject = data.subject || "";
    const description = data.description || "";
    const brand = data.organization_name || "default_brand";

    console.log(`🎫 New ticket webhook received: ID=${ticketId}, Subject="${subject.substring(0, 50)}..."`);

    // Check if ticket already has comments (skip if it does)
    if (data.comment_count && data.comment_count > 0) {
      console.log(`⏭️  Skipping ticket ${ticketId} - already has replies`);
      return;
    }

    // Auto-generate and send reply asynchronously (don't wait)
    handleAutoReplyAsync(ticketId, subject, description, brand).catch(err => {
      console.error(`❌ Async auto-reply failed for ticket ${ticketId}:`, err.message);
    });

  } catch (err) {
    console.error("❌ Webhook handler error:", err);
    res.status(500).json({ error: "Webhook processing failed" });
  }
}

/**
 * Asynchronous handler for auto-reply generation and sending
 */
async function handleAutoReplyAsync(ticketId, subject, description, brand) {
  try {
    console.log(`⏳ Starting async auto-reply for ticket ${ticketId}...`);

    // Step 1: Generate embedding
    const queryEmbedding = await embedText(`${subject} ${description}`);
    const filter = brand ? { brand: { $eq: brand } } : null;

    // Step 2: PHASE 1 - Search manually uploaded KB
    console.log("📚 Searching manual KB for auto-reply...");
    const kbFilter = filter ? { ...filter, source: { $eq: "manual_upload" } } : { source: { $eq: "manual_upload" } };
    const kbResults = await queryVectors(queryEmbedding, 10, true, kbFilter);
    const relevantKBMatches = kbResults.matches.filter(m => m.score >= 0.7);

    let finalResults;
    let searchSource = "manual_kb";

    if (relevantKBMatches.length > 0) {
      finalResults = { matches: relevantKBMatches.slice(0, 5) };
      console.log(`✅ Found ${relevantKBMatches.length} relevant KB articles`);
    } else {
      // Step 3: PHASE 2 - Fall back to ticket conversations
      console.log("⚠️  Searching ticket conversations for auto-reply...");
      const chatFilter = filter ? { ...filter, source: { $eq: "ticket_chat" } } : { source: { $eq: "ticket_chat" } };
      const chatResults = await queryVectors(queryEmbedding, 10, true, chatFilter);
      const relevantChatMatches = chatResults.matches.filter(m => m.score >= 0.6);

      finalResults = { matches: relevantChatMatches.slice(0, 5) };
      searchSource = "ticket_chat";
      console.log(`✅ Found ${relevantChatMatches.length} relevant conversations`);
    }

    // Step 4: Extract context and generate reply
    const kbChunks = finalResults.matches
      .map(match => match.metadata?.content || "")
      .filter(Boolean)
      .join("\n\n") || "No relevant knowledge found.";

    const prompt = buildReplyPrompt(
      { subject, description, ticketId },
      "professional",
      kbChunks
    );

    console.log(`📝 Generating auto-reply for ticket ${ticketId}...`);
    const replyText = await generateContent(prompt, {
      temperature: 0.7,
      topP: 0.8,
      topK: 40,
    });

    // Step 5: Send reply to Zendesk
    console.log(`📤 Sending auto-reply to Zendesk ticket ${ticketId}...`);
    const { createZendeskClient } = await import("../config/zendesk.js");
    const zendeskClient = createZendeskClient();

    await zendeskClient.post(`/tickets/${ticketId}/comments`, {
      comment: {
        body: replyText,
        public: true,
        author_id: -1 // System comment
      }
    });

    console.log(`✅ Auto-reply successfully sent to ticket ${ticketId}`);

  } catch (err) {
    console.error(`❌ Auto-reply generation failed for ticket ${ticketId}:`, err.message);
    
    // Optionally send error notification to Zendesk
    try {
      const { createZendeskClient } = await import("../config/zendesk.js");
      const zendeskClient = createZendeskClient();
      
      await zendeskClient.post(`/tickets/${ticketId}/comments`, {
        comment: {
          body: "⚠️ AI auto-reply generation failed. Please provide a manual response.",
          public: false, // Internal note
          author_id: -1
        }
      });
    } catch (notificationErr) {
      console.error("Failed to send error notification:", notificationErr.message);
    }
  }
}

/**
 * Webhook handler for general Zendesk events
 * Logs event for debugging and validation
 */
export async function handleWebhookEvent(req, res) {
  try {
    console.log("🔔 Webhook event received");
    console.log("Event type:", req.body.event_type);
    console.log("Timestamp:", req.body.timestamp);

    // Acknowledge immediately
    res.status(200).json({ status: "acknowledged" });

    // Log event details
    console.log("Full event data:", JSON.stringify(req.body, null, 2).substring(0, 500));

  } catch (err) {
    console.error("❌ Webhook event handler error:", err);
    res.status(200).json({ status: "error_acknowledged" }); // Still return 200 to avoid retries
  }
}

/**
 * Get webhook status and statistics
 */
export async function getWebhookStatus(req, res) {
  try {
    res.json({
      status: "active",
      endpoint: "/webhook/ticket-created",
      events: ["ticket.created"],
      description: "Automatically generates and sends AI replies to new tickets",
      features: {
        autoReply: true,
        brandIsolation: true,
        kbPrioritization: true,
        errorNotifications: true
      }
    });
  } catch (err) {
    console.error("❌ Status error:", err);
    res.status(500).json({ error: "Failed to get webhook status" });
  }
}
