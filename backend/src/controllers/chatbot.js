/**
 * Chatbot Controller - Handles real-time bot conversations
 * No tickets created - direct customer support
 */

import { generateContent } from "../config/openai.js";
import { queryVectors } from "../config/pinecone.js";
import { embedText } from "../services/embedding.js";
import { buildReplyPrompt } from "../utils/prompts.js";

// In-memory conversation storage (use Redis/DB in production)
const conversationStore = new Map();

/**
 * Initialize a new conversation session
 */
export async function initializeConversation(req, res) {
  try {
    const { visitorId, visitorName, visitorEmail, brand } = req.body;

    if (!visitorId) {
      return res.status(400).json({ error: "visitorId is required" });
    }

    const sessionId = `${visitorId}-${Date.now()}`;
    const conversation = {
      sessionId,
      visitorId,
      visitorName: visitorName || "Guest",
      visitorEmail: visitorEmail || "unknown@example.com",
      brand: brand || "default_brand",
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    conversationStore.set(sessionId, conversation);

    console.log(`💬 New conversation initialized: ${sessionId}`);

    // Send welcome message
    const welcomeMessage = {
      role: "bot",
      text: "👋 Hello! I'm an AI support assistant. How can I help you today?",
      timestamp: new Date(),
    };

    conversation.messages.push(welcomeMessage);

    res.json({
      sessionId,
      welcome: welcomeMessage.text,
      visitorName: conversation.visitorName,
    });
  } catch (err) {
    console.error("❌ Conversation init error:", err);
    res.status(500).json({ error: "Failed to initialize conversation" });
  }
}

/**
 * Handle incoming customer message and generate bot reply
 */
export async function handleChatMessage(req, res) {
  try {
    const { sessionId, message, visitorId } = req.body;

    if (!sessionId || !message) {
      return res.status(400).json({ error: "sessionId and message are required" });
    }

    console.log(`💬 Message received [${sessionId}]: "${message.substring(0, 50)}..."`);

    // Get or create conversation
    let conversation = conversationStore.get(sessionId);
    if (!conversation) {
      return res.status(404).json({ error: "Conversation session not found" });
    }

    // Add customer message to conversation history
    conversation.messages.push({
      role: "customer",
      text: message,
      timestamp: new Date(),
    });

    // Generate AI reply
    const botReply = await generateBotReply(message, conversation);

    // Add bot message to conversation history
    conversation.messages.push({
      role: "bot",
      text: botReply,
      timestamp: new Date(),
    });

    conversation.updatedAt = new Date();

    console.log(`✅ Bot reply sent [${sessionId}]`);

    // Return bot reply
    res.json({
      sessionId,
      reply: botReply,
      conversationId: sessionId,
      messageCount: conversation.messages.length,
    });
  } catch (err) {
    console.error("❌ Chat message error:", err);
    res.status(500).json({ error: "Failed to process message", details: err.message });
  }
}

/**
 * Generate bot reply using KB search + OpenAI
 */
async function generateBotReply(userMessage, conversation) {
  try {
    console.log(`🤖 Generating reply for: "${userMessage.substring(0, 50)}..."`);

    // Step 1: Generate embedding
    const queryEmbedding = await embedText(userMessage);
    const brand = conversation.brand;
    const filter = brand ? { brand: { $eq: brand } } : null;

    // Step 2: PHASE 1 - Search manually uploaded KB
    console.log("📚 Searching KB...");
    const kbFilter = filter ? { ...filter, source: { $eq: "manual_upload" } } : { source: { $eq: "manual_upload" } };
    const kbResults = await queryVectors(queryEmbedding, 10, true, kbFilter);
    const relevantKBMatches = kbResults.matches.filter(m => m.score >= 0.7);

    let finalResults;
    let searchSource = "manual_kb";

    if (relevantKBMatches.length > 0) {
      finalResults = { matches: relevantKBMatches.slice(0, 5) };
      console.log(`✅ Found ${relevantKBMatches.length} KB articles`);
    } else {
      // Step 3: PHASE 2 - Fall back to ticket conversations
      console.log("⚠️ Searching ticket conversations...");
      const chatFilter = filter ? { ...filter, source: { $eq: "ticket_chat" } } : { source: { $eq: "ticket_chat" } };
      const chatResults = await queryVectors(queryEmbedding, 10, true, chatFilter);
      const relevantChatMatches = chatResults.matches.filter(m => m.score >= 0.6);

      finalResults = { matches: relevantChatMatches.slice(0, 5) };
      searchSource = "ticket_chat";
      console.log(`✅ Found ${relevantChatMatches.length} chat references`);
    }

    // Step 4: Extract context
    const kbChunks = finalResults.matches
      .map(match => match.metadata?.content || "")
      .filter(Boolean)
      .join("\n\n") || "No knowledge base available.";

    // Step 5: Build conversation context from history
    const conversationHistory = conversation.messages
      .map(msg => `${msg.role === "bot" ? "Assistant" : "Customer"}: ${msg.text}`)
      .join("\n");

    // Step 6: Create bot-specific prompt
    const botPrompt = `You are a helpful AI customer support assistant for a ${conversation.brand} company.

KNOWLEDGE BASE:
${kbChunks}

CONVERSATION HISTORY:
${conversationHistory}

CUSTOMER'S LATEST MESSAGE: ${userMessage}

Please provide a helpful, friendly, and concise reply. Keep responses under 200 words. If you don't know the answer, be honest about it.`;

    // Step 7: Generate reply
    const replyText = await generateContent(botPrompt, {
      temperature: 0.7,
      topP: 0.8,
      topK: 40,
    });

    console.log(`✅ Reply generated (${replyText.length} chars)`);
    return replyText;

  } catch (err) {
    console.error("❌ Reply generation error:", err);
    return "I apologize, but I'm experiencing technical difficulties. Please try again in a moment.";
  }
}

/**
 * Get conversation history
 */
export async function getConversationHistory(req, res) {
  try {
    const { sessionId } = req.params;

    if (!sessionId) {
      return res.status(400).json({ error: "sessionId is required" });
    }

    const conversation = conversationStore.get(sessionId);
    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    res.json({
      sessionId,
      visitorName: conversation.visitorName,
      visitorEmail: conversation.visitorEmail,
      brand: conversation.brand,
      createdAt: conversation.createdAt,
      messages: conversation.messages,
      messageCount: conversation.messages.length,
    });
  } catch (err) {
    console.error("❌ History error:", err);
    res.status(500).json({ error: "Failed to get conversation history" });
  }
}

/**
 * End conversation and store in database
 */
export async function endConversation(req, res) {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: "sessionId is required" });
    }

    const conversation = conversationStore.get(sessionId);
    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    console.log(`🏁 Conversation ended: ${sessionId} (${conversation.messages.length} messages)`);

    // In production, save to database here
    // await saveConversationToDatabase(conversation);

    // Remove from memory
    conversationStore.delete(sessionId);

    res.json({
      sessionId,
      status: "ended",
      totalMessages: conversation.messages.length,
      duration: new Date() - conversation.createdAt,
    });
  } catch (err) {
    console.error("❌ End conversation error:", err);
    res.status(500).json({ error: "Failed to end conversation" });
  }
}

/**
 * Get active conversations count
 */
export async function getConversationsStats(req, res) {
  try {
    const stats = {
      activeConversations: conversationStore.size,
      totalMessages: Array.from(conversationStore.values()).reduce(
        (sum, conv) => sum + conv.messages.length,
        0
      ),
      conversations: Array.from(conversationStore.values()).map(conv => ({
        sessionId: conv.sessionId,
        visitorName: conv.visitorName,
        brand: conv.brand,
        messageCount: conv.messages.length,
        duration: new Date() - conv.createdAt,
        lastUpdate: conv.updatedAt,
      })),
    };

    res.json(stats);
  } catch (err) {
    console.error("❌ Stats error:", err);
    res.status(500).json({ error: "Failed to get stats" });
  }
}
