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
import { createSunshineClient } from "../config/sunshine.js";
import { updateTicket, getTicket } from "../services/ticketManager.js";

dotenv.config();

// Track form collection status - store conversation ID and form data
const conversationFormData = new Map();

// Track escalated conversations - store conversation IDs where agent has taken control
const escalatedConversations = new Set();

// ============================================================================
// MAIN WEBHOOK HANDLER
// ============================================================================

export async function handleSunshineMessage(req, res) {
  try {
    const payload = req.body;

    // Send 200 immediately so Zendesk doesn't timeout
    res.status(200).json({ success: true, received: true });

    if (!payload.events || !Array.isArray(payload.events) || payload.events.length === 0) {
      console.error("Missing events in webhook payload");
      return;
    }

    setImmediate(async () => {
      try {
        for (const event of payload.events) {
          try {

            // ----------------------------------------------------------------
            // Handle metadata update (ticket created after agent accepts)
            // ----------------------------------------------------------------
            if (event.type === "conversation:updatedmetadata") {
              console.log("Handling conversation:updatedmetadata event");
              const conversationId = event.payload.conversation?.id;
              const metadata       = event.payload.conversation?.metadata;
              const ticketId       = metadata?.["zd:ticket"]?.id;

              if (ticketId && conversationId) {
                try {
                  const formData = conversationFormData.get(conversationId);
                  if (formData && formData.data) {
                    const { name, email } = formData.data;
                    console.log(`✅ Ticket ${ticketId} created with customer: ${name} (${email})`);
                    const ticket = await getTicket(ticketId);
                    console.log(`Ticket requester ID: ${ticket.requester_id}`);
                  } else {
                    console.log(`ℹ️ Ticket ${ticketId} created but no form data for conversation ${conversationId}`);
                  }
                  conversationFormData.delete(conversationId);
                } catch (err) {
                  console.error("Could not process ticket:", err.message);
                }
              }
              continue;
            }

            // ----------------------------------------------------------------
            // Only process conversation:message events
            // ----------------------------------------------------------------
            if (event.type !== "conversation:message") continue;

            if (!event.payload || !event.payload.conversation || !event.payload.message) {
              console.error("Missing payload fields in event");
              continue;
            }

            const conversationId = event.payload.conversation.id;

            // ----------------------------------------------------------------
            // Processing guard — prevent duplicate webhook handling
            // ----------------------------------------------------------------
            if (conversationFormData.get(conversationId)?.processing) {
              console.log(`Skipping duplicate event for conversation ${conversationId}`);
              continue;
            }

            // Mark as processing — preserve existing form data
            const existingData = conversationFormData.get(conversationId);
            conversationFormData.set(conversationId, { ...existingData, processing: true });

            // Helper: clear processing flag on every exit path
            const clearProcessing = () => {
              const d = conversationFormData.get(conversationId);
              if (!d) return;
              if (Object.keys(d).length === 1 && d.processing) {
                conversationFormData.delete(conversationId);
              } else {
                d.processing = false;
              }
            };

            // ----------------------------------------------------------------
            // Extract event data
            // ----------------------------------------------------------------
            const messageBody = event.payload.message.content?.text;
            const author      = event.payload.message.author;
            const userName    = author.displayName || "Customer";

            const activeSwitchboardIntegration =
              event.payload.conversation?.activeSwitchboardIntegration?.id ||
              event.payload.conversation?.activeSwitchboardIntegration?.name;

            const isAgentActive =
              activeSwitchboardIntegration &&
              (activeSwitchboardIntegration.includes("agentWorkspace") ||
                activeSwitchboardIntegration === "zd-agentWorkspace" ||
                activeSwitchboardIntegration.includes("agent"));

            const isEscalated = escalatedConversations.has(conversationId);

            // ----------------------------------------------------------------
            // Skip bot/system/agent messages
            // ----------------------------------------------------------------
            if (
              author.type === "business" ||
              author.displayName?.includes("BOT") ||
              author.displayName?.includes("bot") ||
              author.subtypes?.includes("AI")
            ) {
              clearProcessing(); continue;
            }

            // Only process customer/user messages
            if (author.type !== "user" && author.type !== "end_user") {
              clearProcessing(); continue;
            }

            // ----------------------------------------------------------------
            // Handle form submission
            // ----------------------------------------------------------------
            if (
              event.payload.message.content?.type === "formResponse" &&
              event.payload.message.content?.fields
            ) {
              const fields = event.payload.message.content.fields || [];

              const customerName     = fields.find((f) => f.name === "name")?.text || userName || "Customer";
              const customerEmail    = fields.find((f) => f.name === "email")?.email || process.env.ZENDESK_EMAIL;
              const issueCategory    = fields.find((f) => f.name === "category")?.select?.[0]?.name || "general";
              const issueDescription = fields.find((f) => f.name === "description")?.text || "No description provided";
              const webUserId        = author.userId;

              // Store form data (overwrites processing flag with real data)
              conversationFormData.set(conversationId, {
                status: "form_submitted",
                data: { name: customerName, email: customerEmail, category: issueCategory, description: issueDescription, webUserId },
                submittedAt: Date.now(),
              });

              try {
                const sunshineClient = createSunshineClient();
                await sunshineClient.post(
                  `/apps/${process.env.SUNSHINE_APP_ID}/conversations/${conversationId}/messages`,
                  {
                    author: { type: "business" },
                    content: {
                      type: "text",
                      text: `Thank you ${customerName}! Would you like to escalate to a human agent to discuss your ${issueCategory} issue?`,
                      actions: [
                        { type: "reply", text: "✅ Yes, Connect me to Agent", payload: "ESCALATE_TO_AGENT" },
                        { type: "reply", text: "❌ No, Cancel",               payload: "CANCEL_ESCALATION"  },
                      ],
                    },
                  }
                );
              } catch (err) {
                console.error("Failed to send quick reply after form:", err.message);
              }

              // Real data freshly written above — no clearProcessing needed
              continue;
            }

            // ----------------------------------------------------------------
            // Require messageBody for all remaining flows
            // ----------------------------------------------------------------
            if (!messageBody) {
              clearProcessing(); continue;
            }

            // ----------------------------------------------------------------
            // Handle ESCALATE_TO_AGENT quick reply
            // ----------------------------------------------------------------
            if (messageBody === "ESCALATE_TO_AGENT" || messageBody === "✅ Yes, Connect me to Agent") {
              const formData = conversationFormData.get(conversationId);

              if (!formData || !formData.data) {
                console.error("No form data found for escalation");
                try {
                  await sendSunshineMessage(conversationId, "Sorry, I couldn't find your form data. Please try again.");
                } catch (err) {
                  console.error(`Could not send message: ${err.message}`);
                }
                clearProcessing(); continue;
              }

              const { name, email, category, webUserId } = formData.data;

              try {
                await escalateToAgent(conversationId, name, email, webUserId, activeSwitchboardIntegration);
                escalatedConversations.add(conversationId);
                setTimeout(() => { escalatedConversations.delete(conversationId); }, 2 * 60 * 60 * 1000);
                conversationFormData.delete(conversationId);
              } catch (escalateErr) {
                console.error("Failed to escalate to agent:", escalateErr.message);
                try {
                  await sendSunshineMessage(conversationId, "Sorry, there was an issue connecting you to an agent. Please try again.");
                } catch (msgErr) {
                  console.error(`Could not send error message: ${msgErr.message}`);
                }
                clearProcessing();
              }
              continue;
            }

            // ----------------------------------------------------------------
            // Handle CANCEL_ESCALATION quick reply
            // ----------------------------------------------------------------
            if (messageBody === "CANCEL_ESCALATION" || messageBody === "❌ No, Cancel") {
              conversationFormData.delete(conversationId);
              try {
                await sendSunshineMessage(conversationId, "No problem! Is there anything else I can help you with?");
              } catch (err) {
                console.error(`Could not send message: ${err.message}`);
              }
              // Map entry deleted above — no clearProcessing needed
              continue;
            }

            // ----------------------------------------------------------------
            // Step 1: Embed user message
            // ----------------------------------------------------------------
            let messageEmbedding;
            try {
              messageEmbedding = await embedText(messageBody);
            } catch (err) {
              console.error("Embedding error:", err.message);
              messageEmbedding = null;
            }

            // ----------------------------------------------------------------
            // Step 2: Search knowledge base (2-phase)
            // ----------------------------------------------------------------
            let selectedArticles = [];

            if (messageEmbedding) {
              try {
                const phase1Results = await queryVectors(messageEmbedding, 10, true, { source: "manual_upload" });
                console.log("Phase 1 KB search results:", phase1Results.matches);
                const phase1Filtered = (phase1Results.matches || []).filter((r) => r.score >= 0.5);

                if (phase1Filtered.length > 0) {
                  selectedArticles = phase1Filtered.slice(0, 5);
                } else {
                  const phase2Results = await queryVectors(messageEmbedding, 10, true, { source: "ticket_chat" });
                  const phase2Filtered = (phase2Results.matches || []).filter((r) => r.score >= 0.4);
                  if (phase2Filtered.length > 0) {
                    selectedArticles = phase2Filtered.slice(0, 5);
                  }
                }
              } catch (err) {
                console.error("KB search error:", err.message);
              }
            }

            // ----------------------------------------------------------------
            // Step 3: Check if customer wants escalation
            // ----------------------------------------------------------------
            try {
              const wantsEscalation = await shouldCreateTicket(messageBody);

              if (wantsEscalation) {
                const hasFormData = conversationFormData.has(conversationId);

                if (!hasFormData) {
                  await sendDetailCollectionForm(conversationId);

                  conversationFormData.set(conversationId, {
                    status: "pending_form",
                    initiatedBy: userName,
                    timestamp: Date.now(),
                  });

                  setTimeout(() => { conversationFormData.delete(conversationId); }, 30 * 60 * 1000);

                  // Real data freshly written above — no clearProcessing needed
                  continue;
                }

                const formData = conversationFormData.get(conversationId);
                const { name, email, webUserId } = formData.data;

                await sendEscalationMessage(conversationId, userName);
                await escalateToAgent(conversationId, name, email, webUserId, activeSwitchboardIntegration);

                conversationFormData.delete(conversationId);
                continue;
              }
            } catch (err) {
              console.error("Escalation check failed:", err.message);
            }

            // ----------------------------------------------------------------
            // Step 4: Skip bot reply if agent is handling
            // ----------------------------------------------------------------
            if (isAgentActive || isEscalated) {
              clearProcessing(); continue;
            }

            // ----------------------------------------------------------------
            // Step 5: Generate bot reply
            // ----------------------------------------------------------------
            let botReply;
            try {
              const history   = await getConversationHistory(conversationId);
              const dbContext = await searchDatabase(messageBody);

              const prompt = `
You are a customer support assistant for MR Brands.

## YOUR IDENTITY
You are a support BOT. You only answer based on the Knowledge Base and Conversation History provided below.
You do NOT have access to any live systems, orders, accounts, or real-time data.

## GREETING RULE
If the customer is greeting you (e.g. "hi", "hello", "hey", "good morning", "howdy") —
respond warmly and ask how you can help. Example:
"Hello! 👋 Welcome to MR Brands support. How can I help you today?"

## KNOWLEDGE BASE RULE (MOST IMPORTANT)
- You MUST only answer from the Knowledge Base provided below.
- If the answer is NOT in the Knowledge Base or Conversation History → respond EXACTLY:
  "I'm sorry, I'm not trained to answer questions outside of my support area.
   For further help, please type 'connect me to an agent' and a human will assist you."
- Do NOT guess, assume, or make up any answer.
- Do NOT use your general knowledge to fill gaps.

## WHAT YOU CANNOT DO
- Check orders, shipments, or tracking
- Access accounts, billing, or payment records
- Process refunds or replacements
- Look up any customer-specific data

If asked to do any of the above, say:
"I don't have access to [order/account/billing] information.
To resolve this, please type 'connect me to an agent' and our team will help you directly."

## HOW TO RESPOND WHEN KNOWLEDGE BASE HAS AN ANSWER
1. Acknowledge the issue briefly (one line)
2. Give a clear step-by-step guide
3. End with: "Does this help? Let me know if you need further assistance."

## TONE
- Warm, professional, and concise
- Never promise outcomes you cannot guarantee
- Never repeat yourself across messages
- Use bullet points or numbered steps when helpful

---

Conversation History:
${history}

Knowledge Base:
${selectedArticles.map((a) => a.metadata?.text).filter(Boolean).join("\n") || "NO RELEVANT ARTICLES FOUND"}

Customer Message:
${messageBody}

---
REMEMBER: If Knowledge Base says "NO RELEVANT ARTICLES FOUND" and the message is NOT a greeting → always reply with the out-of-topic response. No exceptions.
`;

              botReply = await generateContent(prompt);
            } catch (err) {
              console.error("OpenAI generation error:", err.message);
              botReply = "I'm sorry, I encountered an issue generating a response. Please try again.";
            }

            // ----------------------------------------------------------------
            // Step 6: Generate optimized quick replies (KB-grounded)
            // ----------------------------------------------------------------
            let quickReplies = [];
            try {
              quickReplies = await generateSmartQuickReplies(messageBody, botReply, selectedArticles);
            } catch (err) {
              console.error("Quick reply generation error:", err.message);
              quickReplies = [];
            }

            // ----------------------------------------------------------------
            // Step 7: Send reply
            // ----------------------------------------------------------------
            try {
              await sendSunshineMessage(conversationId, { text: botReply, quickReplies });
            } catch (err) {
              console.error("Failed to send reply:", err.message);
            }

            // Always clear processing at end of normal flow
            clearProcessing();

          } catch (eventErr) {
            console.error("Error processing event:", eventErr.message);
          }
        }
      } catch (processErr) {
        console.error("Error in background processing:", processErr.message);
      }
    });

  } catch (err) {
    console.error("Error in webhook handler:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to process message", details: err.message });
    }
  }
}

// ============================================================================
// SEND MESSAGE
// ============================================================================

async function sendSunshineMessage(conversationId, message) {
  try {
    if (!process.env.SUNSHINE_APP_ID) throw new Error("SUNSHINE_APP_ID not configured");

    const sunshineClient  = createSunshineClient();
    const text            = typeof message === "string" ? message : message.text;
    const quickReplies    = typeof message === "object"  ? message.quickReplies : null;

    const payload = {
      author: { type: "business" },
      content: {
        type: "text",
        text: text,
        ...(quickReplies && quickReplies.length > 0 && {
          actions: quickReplies.map((q) => ({
            type:    "reply",
            text:    q,
            payload: q.toUpperCase().replace(/[^A-Z0-9]+/g, "_"),
          })),
        }),
      },
    };

    const response = await sunshineClient.post(
      `/apps/${process.env.SUNSHINE_APP_ID}/conversations/${conversationId}/messages`,
      payload
    );
    return response.data;
  } catch (err) {
    console.error("Failed to send Sunshine message:", err.response?.data || err.message);
    throw err;
  }
}

// ============================================================================
// QUICK REPLIES — Optimized with KB grounding + smart suppression
// ============================================================================

/**
 * Gate 1: Decide if quick replies should be suppressed entirely.
 * Suppresses on: greetings, complete answers, bot asked clarification, escalation flow.
 */
async function shouldSuppressQuickReplies(userMessage, botReply) {
  try {
    const prompt = `You are analyzing a support chat message pair.

User message: "${userMessage}"
Bot reply: "${botReply}"

Decide if quick reply buttons should be SUPPRESSED (hidden).

Suppress quick replies if ANY of these are true:
1. User message is a greeting or simple acknowledgement (hi, hello, thanks, bye, ok, cool, got it, sure)
2. Bot reply is very clear and complete — user has nothing obvious to ask next
3. Bot reply ends with a question asking the user for more info (clarification)
4. This is part of an escalation or agent handoff flow

Respond ONLY with "suppress" or "show". Nothing else.`;

    const response = await generateContent(prompt);
    return response.toLowerCase().trim() === "suppress";
  } catch (err) {
    console.error("Suppress check error:", err.message);
    return false; // default: show on error
  }
}

/**
 * Gate 2: Generate KB-grounded quick replies in question format.
 * Each reply must match a real KB article topic.
 * Returns empty array if suppressed or no KB titles available.
 */
async function generateSmartQuickReplies(userMessage, botReply, selectedArticles) {
  try {
    // Gate 1: suppress check
    const suppress = await shouldSuppressQuickReplies(userMessage, botReply);
    if (suppress) {
      console.log("✅ Quick replies suppressed");
      return [];
    }

    // Gate 2: need KB titles to ground replies
    const kbTitles = (selectedArticles || [])
      .slice(0, 5)
      .map((a) => a.metadata?.title)
      .filter(Boolean);

    if (kbTitles.length === 0) {
      console.log("ℹ️ No KB titles available — skipping quick replies");
      return [];
    }

    const kbContext = kbTitles.join("\n- ");

    const prompt = `You are generating quick reply buttons for a support chat.

User message: "${userMessage}"
Bot reply: "${botReply}"

Available Knowledge Base topics:
- ${kbContext}

Your job:
Generate up to 3 quick reply questions the user is MOST LIKELY to ask next, based ONLY on the KB topics listed above.

Rules:
- Format: Question only (e.g. "How do I reset my password?")
- Must be directly related to one of the KB topics listed above
- Must feel natural as a follow-up to this conversation
- Max 8 words per question
- No generic questions like "How can I get help?"
- If fewer than 3 KB topics are relevant, return fewer — do not force 3
- If NO KB topic is relevant to this conversation, return empty array []

Return ONLY a valid JSON array of strings. No markdown. No explanation.
Example: ["How do I update my billing info?", "How do I cancel my subscription?"]`;

    const res     = await generateContent(prompt);
    const cleaned = res.replace(/```json|```/g, "").trim();
    const parsed  = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) return [];

    const filtered = parsed
      .filter((q) => typeof q === "string" && q.trim().length > 0)
      .slice(0, 3);

    console.log(`✅ Quick replies generated: ${JSON.stringify(filtered)}`);
    return filtered;

  } catch (err) {
    console.error("Smart quick reply error:", err.message);
    return []; // empty — no fallback, no generic replies
  }
}

// ============================================================================
// CONVERSATION HISTORY
// ============================================================================

async function getConversationHistory(conversationId) {
  try {
    const client = createSunshineClient();
    const res    = await client.get(
      `/apps/${process.env.SUNSHINE_APP_ID}/conversations/${conversationId}/messages?limit=10`
    );
    return res.data.messages
      .slice(-6)
      .map((m) => {
        const role = m.author?.type === "business" ? "Bot" : "User";
        return `${role}: ${m.content?.text}`;
      })
      .join("\n");
  } catch (err) {
    console.error("History fetch failed:", err.message);
    return "";
  }
}

// ============================================================================
// DATABASE SEARCH
// ============================================================================

async function searchDatabase(message) {
  try {
    const tickets = await Ticket.find({
      description: { $regex: message, $options: "i" },
    }).limit(3);
    return tickets.map((t) => `Ticket: ${t.subject} | ${t.description}`).join("\n");
  } catch (err) {
    return "";
  }
}

// ============================================================================
// ESCALATION DETECTION
// ============================================================================

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

// ============================================================================
// DETAIL COLLECTION FORM
// ============================================================================

async function sendDetailCollectionForm(conversationId) {
  try {
    if (!process.env.SUNSHINE_APP_ID || !process.env.ZENDESK_DOMAIN || !process.env.SUNSHINE_KEY_ID || !process.env.SUNSHINE_KEY_SECRET) {
      throw new Error("Missing required config for form");
    }

    const payload = {
      author: { type: "business" },
      content: {
        type: "form",
        text: "Please fill out this form to help us assist you better.",
        fields: [
          { type: "text",   name: "name",        label: "Your Name",           placeholder: "Enter your full name...",                required: true },
          { type: "email",  name: "email",        label: "Email Address",       placeholder: "Enter your email...",                    required: true },
          {
            type: "select", name: "category",     label: "Issue Category",      placeholder: "Choose the category of your issue...",   required: true,
            options: [
              { name: "billing",   label: "Billing & Payments" },
              { name: "technical", label: "Technical Support"  },
              { name: "account",   label: "Account & Profile"  },
              { name: "general",   label: "General Inquiry"    },
              { name: "other",     label: "Other"              },
            ],
          },
          { type: "text",   name: "description",  label: "Describe Your Issue", placeholder: "Please describe the issue in detail...", required: true },
        ],
      },
    };

    const fullURL = `https://${process.env.ZENDESK_DOMAIN}.zendesk.com/sc/v2/apps/${process.env.SUNSHINE_APP_ID}/conversations/${conversationId}/messages`;
    const auth    = Buffer.from(`${process.env.SUNSHINE_KEY_ID}:${process.env.SUNSHINE_KEY_SECRET}`).toString("base64");

    const response = await axios.post(fullURL, payload, {
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    });

    return response.data;
  } catch (err) {
    console.error("Failed to send detail collection form:", err.response?.data || err.message);
    throw err;
  }
}

// ============================================================================
// ESCALATE TO AGENT
// ============================================================================

async function escalateToAgent(conversationId, customerName, customerEmail, webUserId, activeSwitchboardIntegration) {
  try {
    if (!process.env.SUNSHINE_APP_ID) throw new Error("SUNSHINE_APP_ID not configured");

    const authConfig = {
      auth:    { username: `${process.env.ZENDESK_EMAIL}/token`, password: process.env.ZENDESK_API_TOKEN },
      headers: { "Content-Type": "application/json" },
    };

    // Step 1: Confirmation message
    await sendSunshineMessage(conversationId, "Perfect! Connecting you to a human agent. They'll have all your details. One moment...");

    // Step 2: Get Smooch user ID
    console.log(`🔍 Fetching participants for conversation ${conversationId}`);
    let smoochUserId;
    try {
      const sunshineClient  = createSunshineClient();
      const participantsRes = await sunshineClient.get(
        `/apps/${process.env.SUNSHINE_APP_ID}/conversations/${conversationId}/participants`
      );
      smoochUserId = participantsRes.data.participants?.[0]?.userId;
      console.log(`👤 Smooch user ID: ${smoochUserId}`);
    } catch (partErr) {
      console.error("⚠️ Failed to fetch participants:", partErr.message);
    }

    // Step 3: Find Zendesk WebUser
    console.log(`🔍 Searching for Zendesk WebUser with Smooch ID: ${smoochUserId}`);
    let zendeskUserId;
    if (smoochUserId) {
      try {
        const searchResponse = await axios.get(
          `https://${process.env.ZENDESK_DOMAIN}.zendesk.com/api/v2/users/search?query=${smoochUserId}`,
          authConfig
        );
        if (searchResponse.data.users?.length > 0) {
          zendeskUserId = searchResponse.data.users[0].id;
          console.log(`✅ Found Zendesk WebUser ID: ${zendeskUserId}`);
        }
      } catch (searchErr) {
        console.error("⚠️ Failed to search for Zendesk WebUser:", searchErr.response?.data || searchErr.message);
      }
    }

    // Step 4: Update or merge Zendesk user with real customer details
    if (zendeskUserId) {
      console.log(`📝 Attempting to update user ${zendeskUserId} → ${customerName} (${customerEmail})`);
      try {
        await axios.put(
          `https://${process.env.ZENDESK_DOMAIN}.zendesk.com/api/v2/users/${zendeskUserId}.json`,
          { user: { name: customerName, email: customerEmail } },
          authConfig
        );
        console.log(`✅ Successfully updated user ${zendeskUserId} with email: ${customerEmail}`);
      } catch (updateErr) {
        if (updateErr.response?.status === 422) {
          console.log(`⚠️ Email ${customerEmail} already taken — searching for existing user to merge...`);
          try {
            const existingUserRes = await axios.get(
              `https://${process.env.ZENDESK_DOMAIN}.zendesk.com/api/v2/users/search?query=email:${customerEmail}`,
              authConfig
            );
            const existingUser = existingUserRes.data.users?.[0];

            if (existingUser && existingUser.id !== zendeskUserId) {
              console.log(`🔀 Merging temp WebUser ${zendeskUserId} into real user ${existingUser.id}`);
              await axios.put(
                `https://${process.env.ZENDESK_DOMAIN}.zendesk.com/api/v2/users/${existingUser.id}/merge.json`,
                { user: { id: zendeskUserId } },
                authConfig
              );
              zendeskUserId = existingUser.id;
              console.log(`✅ Merge successful — real user ID: ${zendeskUserId}`);
            } else if (existingUser?.id === zendeskUserId) {
              await axios.put(
                `https://${process.env.ZENDESK_DOMAIN}.zendesk.com/api/v2/users/${zendeskUserId}.json`,
                { user: { name: customerName } },
                authConfig
              );
              console.log(`✅ Same user found — updated name to: ${customerName}`);
            } else {
              console.error(`❌ No existing user found for email: ${customerEmail}`);
            }
          } catch (mergeErr) {
            console.error("❌ Merge failed:", mergeErr.response?.data || mergeErr.message);
          }
        } else {
          console.error(`❌ Failed to update user (status=${updateErr.response?.status}):`, updateErr.response?.data || updateErr.message);
        }
      }
    } else {
      console.warn("⚠️ No Zendesk WebUser found — skipping user update/merge");
    }

    // Step 5: Pass control to agent workspace
    console.log("🔄 Passing control to agent workspace...");
    const sunshineClient = createSunshineClient();
    const response       = await sunshineClient.post(
      `/apps/${process.env.SUNSHINE_APP_ID}/conversations/${conversationId}/passControl`,
      { switchboardIntegration: "zd-agentWorkspace", metadata: { reason: "user_requested_agent" } }
    );

    console.log(`✅ Escalated conversation ${conversationId} to agent workspace`);
    return response.data;

  } catch (err) {
    console.error(`❌ Escalation error (status=${err.response?.status}):`, JSON.stringify(err.response?.data));
    throw err;
  }
}

// ============================================================================
// ESCALATION MESSAGE
// ============================================================================

async function sendEscalationMessage(conversationId, customerName) {
  try {
    await sendSunshineMessage(
      conversationId,
      "I'm connecting you with one of our support agents. They'll be with you shortly. Thank you for your patience! 👋"
    );
  } catch (err) {
    console.error("Failed to send escalation message:", err.message);
  }
}