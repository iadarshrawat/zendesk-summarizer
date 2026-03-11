/**
 * Build summary prompt for ticket
 */
export function buildSummaryPrompt(ticket) {
  const customFieldsText =
    Object.keys(ticket.customFields || {}).length > 0
      ? Object.entries(ticket.customFields)
          .map(([id, value]) => `- ${id}: ${value}`)
          .join("\n")
      : "No custom fields used";

  return `
You are an AI support assistant.

Summarize the Zendesk ticket below in ${ticket.language || "English"}.

------------------------
Ticket ID: ${ticket.ticketId}
Form: ${ticket.ticketFormName || "N/A"}

Subject:
${ticket.subject || "N/A"}

Description:
${ticket.description || "N/A"}

Custom Fields:
${customFieldsText}
------------------------

Provide:
1. Short summary (2–3 lines)
2. Main customer issue
3. Recommended next action

Use clear formatting with bold text for emphasis where appropriate.
`;
}

/**
 * Build reply prompt with RAG context
 * ENHANCED: Forces clear solutions, ignores vague data, prevents "I'll investigate" responses
 */
export function buildReplyPrompt(ticket, tone, kbChunks) {
  return `
You are a Zendesk support agent writing a SOLUTION-FOCUSED reply to a customer.

====================
CRITICAL RULE: PROVIDE CLEAR SOLUTIONS ONLY
====================

⛔ DO NOT USE VAGUE PHRASES LIKE:
- "I will investigate this"
- "Let me look into it"
- "We will check this"
- "I'll get back to you soon"
- "We appreciate your patience"
- "Thank you for contacting us"

✅ INSTEAD, PROVIDE:
- Step-by-step solutions
- Specific answers from the knowledge base and there previous chats
- Give first priority to knowledge base information that matches the customer's issue.
- If the KB does not have a clear answer, use relevant information from previous ticket conversations.
- Clear next steps the customer can take
- Direct answers to their question

====================
LANGUAGE REQUIREMENT (CRITICAL)
====================

Write the ENTIRE reply in: ${ticket.language}

====================
TONE: ${tone}
====================

- professional: Polite, formal, confident
- friendly: Warm, conversational, approachable
- empathetic: Acknowledge feelings, then provide solution
- apologetic: Apologize briefly, then provide clear fix
- concise: Very short, direct, action-focused

====================
KNOWLEDGE BASE (EXTRACT SOLUTIONS ONLY)
====================
${kbChunks}

FILTER RULES:
- Ignore vague or incomplete information
- Extract ONLY actionable, specific solutions
- Skip generic greetings or pleasantries
- Focus on technical steps or direct answers

====================
TICKET DETAILS
====================

Subject: ${ticket.subject}
Customer Issue: ${ticket.description}

====================
RESPONSE RULES
====================
✓ Start with the direct solution (not an apology or greeting)
✓ Use numbered steps if multiple actions needed
✓ Include specific commands, links, or procedures
✓ End with clear next steps
✗ No phrases like "I will investigate"
✗ No generic pleasantries
✗ No vague commitments to follow up
✗ No hallucinated solutions

====================
WRITE THE SOLUTION-FOCUSED REPLY BELOW
====================
`;
}

/**
 * Build translation prompt
 */
export function buildTranslationPrompt(text, targetLanguage) {
  return `
Translate the following text to ${targetLanguage}.

CRITICAL RULES:
- Maintain the exact same tone and style
- Preserve all formatting (line breaks, bold text, etc.)
- Keep technical terms accurate
- Do NOT add any preamble or explanation
- Return ONLY the translated text

Text to translate:
${text}

Translated text:
`;
}