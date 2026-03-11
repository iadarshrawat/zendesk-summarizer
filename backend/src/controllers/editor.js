import { generateContent } from "../config/openai.js";
import { queryVectors } from "../config/pinecone.js";
import { embedText } from "../services/embedding.js";
import { buildReplyPrompt } from "../utils/prompts.js";
import { buildTranslationPrompt } from "../utils/prompts.js";

/**
 * Compose RAG-based reply for ticket
 * Priority: Manually uploaded KB > Ticket conversations
 */
export async function composeReply(req, res) {
  try {
    const ticket = req.body;

    if (!ticket.subject || !ticket.description) {
      return res.status(400).json({ error: "Invalid ticket payload - subject and description required" });
    }

    // Generate query embedding
    const queryEmbedding = await embedText(`${ticket.subject} ${ticket.description}`);

    // Build brand filter if brand is provided
    const filter = ticket.brand ? { brand: { $eq: ticket.brand } } : null;

    // ==================== PHASE 1: Search manually uploaded KB first ====================
    console.log("📚 PHASE 1: Searching manually uploaded knowledge base...");
    
    const kbFilter = filter ? { ...filter, source: { $eq: "manual_upload" } } : { source: { $eq: "manual_upload" } };
    const kbResults = await queryVectors(queryEmbedding, 10, true, kbFilter);
    
    // Filter results with good relevance score (cosine > 0.7)
    const relevantKBMatches = kbResults.matches.filter(m => m.score >= 0.7);
    console.log(`✅ Found ${relevantKBMatches.length} relevant KB articles (score >= 0.7)`);

    let finalResults = null;
    let searchSource = "manual_kb";

    if (relevantKBMatches.length > 0) {
      // ✅ Use manually uploaded KB results
      finalResults = { matches: relevantKBMatches.slice(0, 5) };
      console.log("✅ Using manually uploaded KB for reply generation");
    } else {
      // ==================== PHASE 2: Fall back to ticket conversations if KB not sufficient ====================
      console.log("⚠️  PHASE 2: No good KB matches found. Searching ticket conversations...");
      
      const chatFilter = filter ? { ...filter, source: { $eq: "ticket_chat" } } : { source: { $eq: "ticket_chat" } };
      const chatResults = await queryVectors(queryEmbedding, 10, true, chatFilter);
      
      const relevantChatMatches = chatResults.matches.filter(m => m.score >= 0.6);
      console.log(`✅ Found ${relevantChatMatches.length} relevant chat conversations (score >= 0.6)`);
      
      finalResults = { matches: relevantChatMatches.slice(0, 5) };
      searchSource = "ticket_chat";
    }

    // Extract relevant context from best source
    const kbChunks = finalResults.matches
      .map(match => match.metadata?.content || "")
      .filter(Boolean)
      .join("\n\n") || "No relevant knowledge found.";

    const prompt = buildReplyPrompt(ticket, ticket.tone || "professional", kbChunks);
    console.log("📝 Generating reply for ticket:", ticket.ticketId, `[Brand: ${ticket.brand || 'default'}, Source: ${searchSource}]`);

    const replyText = await generateContent(prompt, {
      temperature: 0.7,
      topP: 0.8,
      topK: 40,
    });

    res.json({
      ticketId: ticket.ticketId,
      reply: replyText,
      source: searchSource,
      sources: finalResults.matches.map(m => ({
        title: m.metadata?.subject || m.metadata?.title,
        type: m.metadata?.type,
        source: m.metadata?.source,
        score: m.score
      })).filter(s => s.title),
    });
  } catch (err) {
    console.error("❌ RAG reply error:", err);
    res.status(500).json({ error: "RAG reply failed", details: err.message });
  }
}

/**
 * Debug search endpoint for testing retrieval
 */
export async function debugSearch(req, res) {
  try {
    const { query } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: "query required" });
    }

    const queryEmbedding = await embedText(query);
    const results = await queryVectors(queryEmbedding, 10, true);

    res.json({
      query: query,
      results: results.matches.map(match => ({
        id: match.id,
        score: match.score,
        type: match.metadata?.type,
        ticket_id: match.metadata?.ticket_id,
        subject: match.metadata?.subject || match.metadata?.title,
        content: match.metadata?.content?.slice(0, 200) + "...",
      })),
    });
  } catch (err) {
    console.error("❌ Debug search error:", err);
    res.status(500).json({ error: "Debug search failed", details: err.message });
  }
}

/**
 * Translate text to target language
 */
export async function translateText(req, res) {
  try {
    const { text, targetLanguage } = req.body;
    console.log(`🌐 Received translation request to ${targetLanguage} and ${text}`);

    if (!text || !targetLanguage) {
      return res.status(400).json({ error: "text and targetLanguage are required" });
    }

    console.log(`🌐 Translating text to ${targetLanguage}...`);

    const prompt = buildTranslationPrompt(text, targetLanguage);

    const translatedText = await generateContent(prompt, {
      temperature: 0.3,
      topP: 0.8,
      topK: 40,
    });

    console.log(`✅ Translation completed`);

    console.log(`🌐 Translated Text: ${translatedText}`);

    res.json({
      originalText: text,
      translatedText: translatedText.trim(),
      targetLanguage: targetLanguage
    });

  } catch (err) {
    console.error("❌ Translation error:", err);
    res.status(500).json({ 
      error: "Translation failed", 
      details: err.message 
    });
  }
}