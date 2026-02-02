import { generateContent } from "../config/gemini.js";
import { buildSummaryPrompt, buildTranslationPrompt } from "../utils/prompts.js";

/**
 * Summarize a ticket
 */
export async function summarizeTicket(req, res) {
  try {
    const ticket = req.body;

    if (!ticket.ticketId) {
      return res.status(400).json({ error: "Invalid ticket payload - ticketId required" });
    }

    let prompt = buildSummaryPrompt(ticket);

    if (ticket.language) {
      prompt += `\nPlease provide the summary in ${ticket.language} language.`;
    }

    console.log("📝 Generating summary for ticket:", ticket.ticketId);

    const summary = await generateContent(prompt, {
      temperature: 0.7,
      topP: 0.8,
      topK: 40,
    });

    res.json({
      summary,
      ticketId: ticket.ticketId,
    });
  } catch (error) {
    console.error("❌ Summarization failed:", error);
    res.status(500).json({
      error: "Failed to generate summary",
      details: error.message
    });
  }
}