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
import { buildReplyBotPrompt } from "../utils/prompts.js";
import { updateTicket, getTicket } from "../services/ticketManager.js";

dotenv.config();

// Track form collection status - store conversation ID and form data
const conversationFormData = new Map();

// Track escalated conversations - store conversation IDs where agent has taken control
const escalatedConversations = new Set();

export async function handleSunshineMessage(req, res) {
  try {
    const payload = req.body;

    // Send 200 immediately so Zendesk doesn't timeout
    res.status(200).json({ success: true, received: true });

    if (
      !payload.events ||
      !Array.isArray(payload.events) ||
      payload.events.length === 0
    ) {
      console.error("Missing events in webhook payload");
      return;
    }

    setImmediate(async () => {
      try {
        for (const event of payload.events) {
          try {
            // Handle ticket creation event
            if (event.type === "conversation:updatedmetadata") {
              console.log("Handling conversation:updatedmetadata event");
              const conversationId = event.payload.conversation?.id;
              const metadata = event.payload.conversation?.metadata;
              const ticketId = metadata?.["zd:ticket"]?.id;

              if (ticketId && conversationId) {
                try {
                  const formData = conversationFormData.get(conversationId);

                  if (formData && formData.data) {
                    const { name, email } = formData.data;
                    console.log(
                      `✅ Ticket ${ticketId} created with customer: ${name} (${email})`,
                    );
                    const ticket = await getTicket(ticketId);
                    console.log(`Ticket requester ID: ${ticket.requester_id}`);
                  } else {
                    console.log(
                      `ℹ️ Ticket ${ticketId} created but no form data found for conversation ${conversationId}`,
                    );
                  }

                  conversationFormData.delete(conversationId);
                } catch (err) {
                  console.error("Could not process ticket:", err.message);
                }
              }

              continue;
            }

            // Only process conversation:message events
            if (event.type !== "conversation:message") {
              continue;
            }

            if (
              !event.payload ||
              !event.payload.conversation ||
              !event.payload.message
            ) {
              console.error("Missing payload fields in event");
              continue;
            }

            const conversationId = event.payload.conversation.id;

            // ✅ Guard: skip if already being processed
            if (conversationFormData.get(conversationId)?.processing) {
              console.log(
                `Skipping duplicate event for conversation ${conversationId}`,
              );
              continue;
            }

            // Mark as processing — preserve existing form data
            const existingData = conversationFormData.get(conversationId);
            conversationFormData.set(conversationId, {
              ...existingData,
              processing: true,
            });

            // ✅ Helper: clears processing flag after every exit path
            const clearProcessing = () => {
              const d = conversationFormData.get(conversationId);
              if (!d) return;
              if (Object.keys(d).length === 1 && d.processing) {
                // Only flag exists, no real data — delete entirely
                conversationFormData.delete(conversationId);
              } else {
                // Real form data exists — just clear the flag
                d.processing = false;
              }
            };

            const messageBody = event.payload.message.content?.text;
            const author = event.payload.message.author;

            const activeSwitchboardIntegration =
              event.payload.conversation?.activeSwitchboardIntegration?.id ||
              event.payload.conversation?.activeSwitchboardIntegration?.name;

            const isAgentActive =
              activeSwitchboardIntegration &&
              (activeSwitchboardIntegration.includes("agentWorkspace") ||
                activeSwitchboardIntegration === "zd-agentWorkspace" ||
                activeSwitchboardIntegration.includes("agent"));

            const isEscalated = escalatedConversations.has(conversationId);
            const userName = author.displayName || "Customer";

            // Skip bot/system/agent messages
            if (
              author.type === "business" ||
              author.displayName?.includes("BOT") ||
              author.displayName?.includes("bot") ||
              author.subtypes?.includes("AI")
            ) {
              clearProcessing();
              continue;
            }

            // Only process customer/user messages
            if (author.type !== "user" && author.type !== "end_user") {
              clearProcessing();
              continue;
            }

            // Handle form submission
            if (
              event.payload.message.content?.type === "formResponse" &&
              event.payload.message.content?.fields
            ) {
              const fields = event.payload.message.content.fields || [];

              const customerName =
                fields.find((f) => f.name === "name")?.text ||
                userName ||
                "Customer";
              const customerEmail =
                fields.find((f) => f.name === "email")?.email ||
                process.env.ZENDESK_EMAIL;
              const issueCategory =
                fields.find((f) => f.name === "category")?.select?.[0]?.name ||
                "general";
              const issueDescription =
                fields.find((f) => f.name === "description")?.text ||
                "No description provided";
              const webUserId = author.userId;

              // Store form data (overwrite processing flag with real data)
              conversationFormData.set(conversationId, {
                status: "form_submitted",
                data: {
                  name: customerName,
                  email: customerEmail,
                  category: issueCategory,
                  description: issueDescription,
                  webUserId: webUserId,
                },
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
                        {
                          type: "reply",
                          text: "✅ Yes, Connect me to Agent",
                          payload: "ESCALATE_TO_AGENT",
                        },
                        {
                          type: "reply",
                          text: "❌ No, Cancel",
                          payload: "CANCEL_ESCALATION",
                        },
                      ],
                    },
                  },
                );
              } catch (quickReplyErr) {
                console.error(
                  "Failed to send quick reply:",
                  quickReplyErr.message,
                );
              }

              // Note: don't call clearProcessing here — form data was just set fresh above
              continue;
            }

            // No messageBody for non-form messages
            if (!messageBody) {
              clearProcessing();
              continue;
            }

            // Handle ESCALATE_TO_AGENT
            if (
              messageBody === "ESCALATE_TO_AGENT" ||
              messageBody === "✅ Yes, Connect me to Agent"
            ) {
              const formData = conversationFormData.get(conversationId);
              if (!formData || !formData.data) {
                console.error(`No form data found for escalation`);
                try {
                  await sendSunshineMessage(
                    conversationId,
                    "Sorry, I couldn't find your form data. Please try again.",
                  );
                } catch (err) {
                  console.error(`Could not send message: ${err.message}`);
                }
                clearProcessing();
                continue;
              }

              const { name, email, category, description, webUserId } =
                formData.data;

              try {
                await escalateToAgent(
                  conversationId,
                  name,
                  email,
                  webUserId,
                  activeSwitchboardIntegration,
                );

                escalatedConversations.add(conversationId);
                setTimeout(
                  () => {
                    escalatedConversations.delete(conversationId);
                  },
                  2 * 60 * 60 * 1000,
                );

                // Delete entirely — escalation done, no more form data needed
                conversationFormData.delete(conversationId);
              } catch (escalateErr) {
                console.error(
                  "Failed to escalate to agent:",
                  escalateErr.message,
                );
                try {
                  await sendSunshineMessage(
                    conversationId,
                    "Sorry, there was an issue connecting you to an agent. Please try again.",
                  );
                } catch (msgErr) {
                  console.error(
                    `Could not send error message: ${msgErr.message}`,
                  );
                }
                clearProcessing();
              }

              continue;
            }

            // Handle CANCEL_ESCALATION
            if (
              messageBody === "CANCEL_ESCALATION" ||
              messageBody === "❌ No, Cancel"
            ) {
              conversationFormData.delete(conversationId);

              try {
                await sendSunshineMessage(
                  conversationId,
                  "No problem! Is there anything else I can help you with?",
                );
              } catch (err) {
                console.error(`Could not send message: ${err.message}`);
              }

              // Note: conversationFormData deleted above, no need to clearProcessing
              continue;
            }

            // Embed message
            let messageEmbedding;
            try {
              messageEmbedding = await embedText(messageBody);
            } catch (err) {
              console.error("Embedding error:", err.message);
              messageEmbedding = null;
            }

            // Search knowledge base (2-phase)
            let selectedArticles = [];

            if (messageEmbedding) {
              try {
                const phase1Results = await queryVectors(
                  messageEmbedding,
                  10,
                  true,
                  { source: "manual_upload" },
                );
                console.log("Phase 1 KB search results:", phase1Results.matches);
                const phase1Filtered = (phase1Results.matches || []).filter(
                  (r) => r.score >= 0.5,
                );

                if (phase1Filtered.length > 0) {
                  selectedArticles = phase1Filtered.slice(0, 5);
                } else {
                  const phase2Results = await queryVectors(
                    messageEmbedding,
                    10,
                    true,
                    { source: "ticket_chat" },
                  );
                  const phase2Filtered = (phase2Results.matches || []).filter(
                    (r) => r.score >= 0.4,
                  );
                  if (phase2Filtered.length > 0) {
                    selectedArticles = phase2Filtered.slice(0, 5);
                  }
                }
              } catch (err) {
                console.error("KB search error:", err.message);
              }
            }

            // Check if customer wants escalation
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

                  setTimeout(
                    () => {
                      conversationFormData.delete(conversationId);
                    },
                    30 * 60 * 1000,
                  );

                  // Note: real data just set above, don't clearProcessing
                  continue;
                }

                const formData = conversationFormData.get(conversationId);
                const { name, email, webUserId } = formData.data;

                await sendEscalationMessage(conversationId, userName);
                await escalateToAgent(
                  conversationId,
                  name,
                  email,
                  webUserId,
                  activeSwitchboardIntegration,
                );

                conversationFormData.delete(conversationId);
                continue;
              }
            } catch (err) {
              console.error("Escalation check failed:", err.message);
            }

            // Skip bot reply if agent is handling
            if (isAgentActive || isEscalated) {
              clearProcessing();
              continue;
            }

            // Generate and send bot reply
            let botReply;
            try {
              const history = await getConversationHistory(conversationId);
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
${
  selectedArticles
    .map((a) => a.metadata?.text)
    .filter(Boolean)
    .join("\n") || "NO RELEVANT fARTICLES FOUND"
}

Customer Message:
${messageBody}

---
REMEMBER: If Knowledge Base says "NO RELEVANT ARTICLES FOUND" and the message is NOT a greeting → always reply with the out-of-topic response. No exceptions.
`;

              botReply = await generateContent(prompt);
            } catch (err) {
              console.error("OpenAI generation error:", err.message);
              botReply =
                "I'm sorry, I encountered an issue generating a response. Please try again.";
            }

            try {
              let quickReplies = await generateSmartQuickReplies(
                messageBody,
                botReply,
                selectedArticles,
              );

              if (!quickReplies || quickReplies.length === 0) {
                quickReplies = await generateDynamicQuickReplies(
                  messageBody,
                  botReply,
                );
              }

              await sendSunshineMessage(conversationId, {
                text: botReply,
                quickReplies,
              });
            } catch (err) {
              console.error("Failed to send reply:", err.message);
            }

            // ✅ Always clear processing at end of normal flow
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
      res
        .status(500)
        .json({ error: "Failed to process message", details: err.message });
    }
  }
}

async function sendSunshineMessage(conversationId, message) {
  try {
    if (!process.env.SUNSHINE_APP_ID) {
      throw new Error("SUNSHINE_APP_ID not configured in .env");
    }

    const sunshineClient = createSunshineClient();
    const text = typeof message === "string" ? message : message.text;
    const quickReplies =
      typeof message === "object" ? message.quickReplies : null;

    const payload = {
      author: { type: "business" },
      content: {
        type: "text",
        text: text,
        ...(quickReplies &&
          quickReplies.length > 0 && {
            actions: quickReplies.map((q) => ({
              type: "reply",
              text: q,
              payload: q.toUpperCase().replace(/[^A-Z0-9]+/g, "_"),
            })),
          }),
      },
    };

    const response = await sunshineClient.post(
      `/apps/${process.env.SUNSHINE_APP_ID}/conversations/${conversationId}/messages`,
      payload,
    );

    return response.data;
  } catch (err) {
    console.error(
      "Failed to send Sunshine message:",
      err.response?.data || err.message,
    );
    throw err;
  }
}

async function getConversationHistory(conversationId) {
  try {
    const client = createSunshineClient();
    const res = await client.get(
      `/apps/${process.env.SUNSHINE_APP_ID}/conversations/${conversationId}/messages?limit=10`,
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

async function searchDatabase(message) {
  try {
    const tickets = await Ticket.find({
      description: { $regex: message, $options: "i" },
    }).limit(3);

    return tickets
      .map((t) => `Ticket: ${t.subject} | ${t.description}`)
      .join("\n");
  } catch (err) {
    return "";
  }
}

async function generateSmartQuickReplies(
  userMessage,
  botReply,
  selectedArticles,
) {
  try {
    const prompt = `
User message: "${userMessage}"
Bot reply: "${botReply}"

Generate 3 quick reply options from USER perspective.

Rules:
- Max 3 options
- Each <= 4 words
- Must feel like USER is clicking it
- Action or intent based
- No generic words like Help or Info

Examples:
Bad: Help, More info
Good: Check warranty, Contact support, Track order

Return JSON array only.
`;

    const res = await generateContent(prompt);
    const parsed = JSON.parse(res);

    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.slice(0, 3);
    }

    throw new Error("Invalid AI response");
  } catch (err) {
    console.error("Smart quick reply error:", err.message);
    return null;
  }
}

async function sendDetailCollectionForm(conversationId) {
  try {
    if (
      !process.env.SUNSHINE_APP_ID ||
      !process.env.ZENDESK_DOMAIN ||
      !process.env.SUNSHINE_KEY_ID ||
      !process.env.SUNSHINE_KEY_SECRET
    ) {
      throw new Error("Missing required config");
    }

    const payload = {
      author: { type: "business" },
      content: {
        type: "form",
        text: "Please fill out this form to help us assist you better.",
        fields: [
          {
            type: "text",
            name: "name",
            label: "Your Name",
            placeholder: "Enter your full name...",
            required: true,
          },
          {
            type: "email",
            name: "email",
            label: "Email Address",
            placeholder: "Enter your email...",
            required: true,
          },
          {
            type: "select",
            name: "category",
            label: "Issue Category",
            placeholder: "Choose the category of your issue...",
            required: true,
            options: [
              { name: "billing", label: "Billing & Payments" },
              { name: "technical", label: "Technical Support" },
              { name: "account", label: "Account & Profile" },
              { name: "general", label: "General Inquiry" },
              { name: "other", label: "Other" },
            ],
          },
          {
            type: "text",
            name: "description",
            label: "Describe Your Issue",
            placeholder: "Please describe the issue in detail...",
            required: true,
          },
        ],
      },
    };

    const endpoint = `/sc/v2/apps/${process.env.SUNSHINE_APP_ID}/conversations/${conversationId}/messages`;
    const fullURL = `https://${process.env.ZENDESK_DOMAIN}.zendesk.com${endpoint}`;
    const auth = Buffer.from(
      `${process.env.SUNSHINE_KEY_ID}:${process.env.SUNSHINE_KEY_SECRET}`,
    ).toString("base64");

    const response = await axios.post(fullURL, payload, {
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
    });

    return response.data;
  } catch (err) {
    console.error(
      "Failed to send detail collection form:",
      err.response?.data || err.message,
    );
    throw err;
  }
}

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

async function escalateToAgent(
  conversationId,
  customerName,
  customerEmail,
  webUserId,
  activeSwitchboardIntegration,
) {
  try {
    if (!process.env.SUNSHINE_APP_ID) {
      throw new Error("SUNSHINE_APP_ID not configured in .env");
    }

    const authConfig = {
      auth: {
        username: `${process.env.ZENDESK_EMAIL}/token`,
        password: process.env.ZENDESK_API_TOKEN,
      },
      headers: { "Content-Type": "application/json" },
    };

    // Step 1: Confirmation message
    await sendSunshineMessage(
      conversationId,
      `Perfect! Connecting you to a human agent. They'll have all your details. One moment...`,
    );

    // Step 2: Get Smooch user ID
    console.log(`🔍 Fetching participants for conversation ${conversationId}`);
    let smoochUserId;
    try {
      const sunshineClient = createSunshineClient();
      const participantsRes = await sunshineClient.get(
        `/apps/${process.env.SUNSHINE_APP_ID}/conversations/${conversationId}/participants`,
      );
      smoochUserId = participantsRes.data.participants?.[0]?.userId;
      console.log(`👤 Smooch user ID: ${smoochUserId}`);
    } catch (partErr) {
      console.error(`⚠️ Failed to fetch participants:`, partErr.message);
    }

    // Step 3: Find Zendesk WebUser
    console.log(
      `🔍 Searching for Zendesk WebUser with Smooch ID: ${smoochUserId}`,
    );
    let zendeskUserId;
    if (smoochUserId) {
      try {
        const searchResponse = await axios.get(
          `https://${process.env.ZENDESK_DOMAIN}.zendesk.com/api/v2/users/search?query=${smoochUserId}`,
          authConfig,
        );
        if (searchResponse.data.users && searchResponse.data.users.length > 0) {
          zendeskUserId = searchResponse.data.users[0].id;
          console.log(`✅ Found Zendesk WebUser ID: ${zendeskUserId}`);
        }
      } catch (searchErr) {
        console.error(
          `⚠️ Failed to search for Zendesk WebUser:`,
          searchErr.response?.data || searchErr.message,
        );
      }
    }

    // Step 4: Update or Merge user
    if (zendeskUserId) {
      console.log(
        `📝 Attempting to update user ${zendeskUserId} → ${customerName} (${customerEmail})`,
      );
      try {
        await axios.put(
          `https://${process.env.ZENDESK_DOMAIN}.zendesk.com/api/v2/users/${zendeskUserId}.json`,
          { user: { name: customerName, email: customerEmail } },
          authConfig,
        );
        console.log(
          `✅ Successfully updated user ${zendeskUserId} with email: ${customerEmail}`,
        );
      } catch (updateErr) {
        const status = updateErr.response?.status;
        if (status === 422) {
          console.log(
            `⚠️ Email ${customerEmail} already taken — searching for existing user to merge...`,
          );
          try {
            const existingUserRes = await axios.get(
              `https://${process.env.ZENDESK_DOMAIN}.zendesk.com/api/v2/users/search?query=email:${customerEmail}`,
              authConfig,
            );
            const existingUser = existingUserRes.data.users?.[0];

            if (existingUser && existingUser.id !== zendeskUserId) {
              console.log(
                `🔀 Merging temp WebUser ${zendeskUserId} into real user ${existingUser.id}`,
              );
              await axios.put(
                `https://${process.env.ZENDESK_DOMAIN}.zendesk.com/api/v2/users/${existingUser.id}/merge.json`,
                { user: { id: zendeskUserId } },
                authConfig,
              );
              zendeskUserId = existingUser.id;
              console.log(
                `✅ Merge successful — using real user ID: ${zendeskUserId}`,
              );
            } else if (existingUser && existingUser.id === zendeskUserId) {
              await axios.put(
                `https://${process.env.ZENDESK_DOMAIN}.zendesk.com/api/v2/users/${zendeskUserId}.json`,
                { user: { name: customerName } },
                authConfig,
              );
              console.log(
                `✅ Same user found — updated name to: ${customerName}`,
              );
            } else {
              console.error(
                `❌ No existing user found for email: ${customerEmail}`,
              );
            }
          } catch (mergeErr) {
            console.error(
              `❌ Merge failed:`,
              mergeErr.response?.data || mergeErr.message,
            );
          }
        } else {
          console.error(
            `❌ Failed to update user (status=${status}):`,
            updateErr.response?.data || updateErr.message,
          );
        }
      }
    } else {
      console.warn(`⚠️ No Zendesk WebUser found — skipping user update/merge`);
    }

    // Step 5: Pass control to agent workspace
    console.log(`🔄 Passing control to agent workspace...`);
    const sunshineClient = createSunshineClient();
    const response = await sunshineClient.post(
      `/apps/${process.env.SUNSHINE_APP_ID}/conversations/${conversationId}/passControl`,
      {
        switchboardIntegration: "zd-agentWorkspace",
        metadata: { reason: "user_requested_agent" },
      },
    );

    console.log(
      `✅ Escalated conversation ${conversationId} to agent workspace`,
    );
    return response.data;
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    console.error(
      `❌ Escalation error (status=${status}):`,
      JSON.stringify(body),
    );
    throw err;
  }
}

async function sendEscalationMessage(conversationId, customerName) {
  try {
    const message = `I'm connecting you with one of our support agents. They'll be with you shortly to assist you further. Thank you for your patience! 👋`;
    await sendSunshineMessage(conversationId, message);
  } catch (err) {
    console.error("Failed to send escalation message:", err.message);
  }
}
