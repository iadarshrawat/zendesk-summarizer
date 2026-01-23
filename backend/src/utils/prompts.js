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
 */
export function buildReplyPrompt(ticket, tone, kbChunks) {
  return `
You are a Zendesk support agent writing a reply to a customer.

====================
LANGUAGE REQUIREMENT (CRITICAL)
====================

YOU MUST write the ENTIRE reply in the language: ${ticket.language}

This is NON-NEGOTIABLE. Every word, sentence, and phrase must be in this language.

====================
TONE RULES (MANDATORY)
====================

IMPORTANT: The tone MUST strictly follow the selected tone.
Do NOT default to a neutral or professional tone unless explicitly required by the tone rules below.

Tone: ${tone}

- professional:
  Polite, formal, business-like language.
  No emojis. No casual words.
  Calm, confident, and respectful.

- friendly:
  Warm, conversational, and approachable.
  Light, human wording.
  Still professional, but relaxed and positive.

- empathetic:
  Show understanding of the customer's frustration or concern.
  Acknowledge feelings before giving information.
  Use reassuring and caring language.

- apologetic:
  Clearly apologize at the beginning.
  Take ownership of the inconvenience.
  Reassuring and solution-focused.

- concise:
  Very short and direct.
  Minimal wording.
  No unnecessary explanations.

You MUST adapt wording, sentence structure, and emotional depth based on the selected tone.
If tone is violated, the response is incorrect.

====================
KNOWLEDGE BASE (USE ONLY THIS)
====================
${kbChunks}

If the knowledge base does NOT contain the answer, reply in the agent's language with an appropriate message like "I will check this and get back to you."

====================
TICKET DETAILS
====================

Ticket Subject:
${ticket.subject}

Customer Message:
${ticket.description}

====================
STRICT RULES
====================
- CRITICAL: Write the ENTIRE reply in ${ticket.language}
- Use ONLY information from the knowledge base
- No hallucinations or assumptions
- No invented steps or procedures
- Do NOT mention the knowledge base
- Write in clear paragraphs with line breaks
- Use **bold** only for critical points
- Response must be ready to send to the customer
- The reply must be natural and fluent

====================
WRITE THE REPLY BELOW
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