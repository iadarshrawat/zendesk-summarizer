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
import { buildReplyBotPrompt } from "../utils/prompts.js";
import { updateTicket, getTicket } from "../services/ticketManager.js";

dotenv.config();

// Track form collection status - store conversation ID and form data
// Used to collect customer details before creating a ticket
const conversationFormData = new Map();

// Track escalated conversations - store conversation IDs where agent has taken control
// Used to prevent bot from replying after escalation
const escalatedConversations = new Set();

/**
 * Create Sunshine Conversations API client
 * Uses Basic Auth with Key ID + Key Secret
 * Base URL: https://api.smooch.io/v2
 */
function createSunshineClient() {
  if (!process.env.SUNSHINE_KEY_ID || !process.env.SUNSHINE_KEY_SECRET) {
    throw new Error(
      "Zendesk Sunshine credentials not configured. Need SUNSHINE_KEY_ID and SUNSHINE_KEY_SECRET",
    );
  }

  return axios.create({
    baseURL: `https://api.smooch.io/v2`,
    headers: {
      "Content-Type": "application/json",
    },
    auth: {
      username: process.env.SUNSHINE_KEY_ID,
      password: process.env.SUNSHINE_KEY_SECRET,
    },
  });
}

/**
 * Handle incoming message from Zendesk Sunshine webhook (v2 format)
 * New format: { app, webhook, events: [{ type, payload: { conversation, message } }] }
 */
export async function handleSunshineMessage(req, res) {
  try {
    const payload = req.body;

    console.log("Received Sunshine webhook:", JSON.stringify(payload, null, 2));
    
    console.log("Received 1");
    // Send 200 immediately so Zendesk doesn't timeout
    res.status(200).json({ success: true, received: true });

    console.log("Received 2");

    // Check if we have events
    if (!payload.events || !Array.isArray(payload.events) || payload.events.length === 0) {
      console.error("Missing events in webhook payload");
      return;
    }

    setImmediate(async () => {
      try {
        for (const event of payload.events) {
          console.log("lskjdhfslkjfdhskdfjhsaldkfjhs@@@@@@@@@@@@@@@@")
          try {
            // Handle ticket creation event (when agent accepts escalation)
            if (event.type === "conversation:updatedmetadata") {

              console.log("Handling conversation:updatedmetadata event");
              const conversationId = event.payload.conversation?.id;
              const metadata = event.payload.conversation?.metadata;
              const ticketId = metadata?.["zd:ticket"]?.id;

              if (ticketId && conversationId) {
                try {
                  // Get stored form data for this conversation
                  const formData = conversationFormData.get(conversationId);
                  
                  if (formData && formData.data) {
                    const { name, email } = formData.data;
                    
                    // Verify and update ticket with customer information
                    console.log(`✅ Ticket ${ticketId} created with customer: ${name} (${email})`);
                    
                    // Get ticket to verify it has correct requester
                    const ticket = await getTicket(ticketId);
                    console.log(`� Ticket requester ID: ${ticket.requester_id}`);
                    
                  } else {
                    console.log(`ℹ️ Ticket ${ticketId} created but no form data found for conversation ${conversationId}`);
                  }
                  
                  // Clean up stored form data after ticket is created
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

            if (!event.payload || !event.payload.conversation || !event.payload.message) {
              console.error("Missing payload fields in event");
              continue;
            }

            const conversationId = event.payload.conversation.id;
            const messageBody = event.payload.message.content?.text;
            const author = event.payload.message.author;

            // Active switchboard integration
            const activeSwitchboardIntegration = 
              event.payload.conversation?.activeSwitchboardIntegration?.id ||
              event.payload.conversation?.activeSwitchboardIntegration?.name;

            // Check if agent has taken control - if so, skip bot processing
            const isAgentActive = activeSwitchboardIntegration && 
              (activeSwitchboardIntegration.includes("agentWorkspace") || 
               activeSwitchboardIntegration === "zd-agentWorkspace" ||
               activeSwitchboardIntegration.includes("agent"));
            
            // Also check if we previously escalated this conversation
            const isEscalated = escalatedConversations.has(conversationId);

            const userName = author.displayName || "Customer";

            // Skip bot/system/agent messages
            if (
              author.type === "business" ||
              author.displayName?.includes("BOT") ||
              author.displayName?.includes("bot") ||
              author.subtypes?.includes("AI")
            ) {
              continue;
            }

            // Only process customer/user messages
            if (author.type !== "user" && author.type !== "end_user") {
              continue;
            }

            // Check if this is a form submission
            if (event.payload.message.content?.type === "formResponse" && event.payload.message.content?.fields) {
              const fields = event.payload.message.content.fields || [];
              
              // Extract form fields by name
              const customerName = fields.find(f => f.name === "name")?.text || userName || "Customer";
              const customerEmail = fields.find(f => f.name === "email")?.email || process.env.ZENDESK_EMAIL;
              const issueCategory = fields.find(f => f.name === "category")?.select?.[0]?.name || "general";
              const issueDescription = fields.find(f => f.name === "description")?.text || "No description provided";
              
              // Get WebUser ID from the message author
              const webUserId = author.userId;
         
              // Store form data temporarily for quick reply action handling
              conversationFormData.set(conversationId, {
                status: "form_submitted",
                data: {
                  name: customerName,
                  email: customerEmail,
                  category: issueCategory,
                  description: issueDescription,
                  webUserId: webUserId
                },
                submittedAt: Date.now()
              });
              
              // Send quick reply with two options
              try {
                const sunshineClient = createSunshineClient();

                const quickReplyPayload = {
                  author: {
                    type: "business",
                  },
                  content: {
                    type: "text",
                    text: `Thank you ${customerName}! Would you like to escalate to a human agent to discuss your ${issueCategory} issue?`,
                    actions: [
                      {
                        type: "reply",
                        text: "✅ Yes, Connect me to Agent",
                        payload: "ESCALATE_TO_AGENT"
                      },
                      {
                        type: "reply",
                        text: "❌ No, Cancel",
                        payload: "CANCEL_ESCALATION"
                      }
                    ]
                  },
                };

                const response = await sunshineClient.post(
                  `/apps/${process.env.SUNSHINE_APP_ID}/conversations/${conversationId}/messages`,
                  quickReplyPayload,
                );
              } catch (quickReplyErr) {
                console.error("Failed to send quick reply:", quickReplyErr.message);
              }
              
              continue;
            }

            // Now check for messageBody only for non-form messages
            if (!messageBody) {
              continue;
            }

            // ✅ Check if this is a quick reply payload (ESCALATE_TO_AGENT or CANCEL_ESCALATION)
            if (messageBody === "ESCALATE_TO_AGENT" || messageBody === "✅ Yes, Connect me to Agent") {
              const formData = conversationFormData.get(conversationId);
              if (!formData || !formData.data) {
                console.error(`No form data found for escalation`);
                try {
                  await sendSunshineMessage(conversationId, "Sorry, I couldn't find your form data. Please try again.");
                } catch (err) {
                  console.error(`Could not send message: ${err.message}`);
                }
                continue;
              }

              const { name, email, category, description, webUserId } = formData.data;

              try {
                // Escalate to agent
                // Send handoff message to customer
                const handoffMsg = `Perfect! Connecting you to a human agent who can assist with your ${category} issue. They'll have all your details. One moment...`;
                try {
                  await sendSunshineMessage(conversationId, handoffMsg);
                } catch (msgErr) {
                  console.error(`Could not send handoff message: ${msgErr.message}`);
                }

                // Now escalate to agent with webUserId
                await escalateToAgent(conversationId, name, email, webUserId, activeSwitchboardIntegration);

                // Mark this conversation as escalated so bot won't reply
                escalatedConversations.add(conversationId);

                // Clear form data after escalation
                conversationFormData.delete(conversationId);

              } catch (escalateErr) {
                console.error("Failed to escalate to agent:", escalateErr.message);
                try {
                  const errorMsg = `Sorry, there was an issue connecting you to an agent. Please try again.`;
                  await sendSunshineMessage(conversationId, errorMsg);
                } catch (msgErr) {
                  console.error(`Could not send error message: ${msgErr.message}`);
                }
              }
              
              continue;
            }

            // Handle CANCEL_ESCALATION response
            if (messageBody === "CANCEL_ESCALATION" || messageBody === "❌ No, Cancel") {
              conversationFormData.delete(conversationId);
              
              try {
                await sendSunshineMessage(conversationId, "No problem! Is there anything else I can help you with?");
              } catch (err) {
                console.error(`Could not send message: ${err.message}`);
              }
              
              continue;
            }

            let messageEmbedding;
            try {
              messageEmbedding = await embedText(messageBody);
            } catch (err) {
              console.error("Embedding error:", err.message);
              messageEmbedding = null;
            }

            // Step 2: Search knowledge base (2-phase search)
            let selectedArticles = [];

            if (messageEmbedding) {
              try {
                const phase1Results = await queryVectors(
                  messageEmbedding, 10, true,
                  { source: "manual_upload" }
                );

                const phase1Filtered = phase1Results.filter((r) => r.score >= 0.7);

                if (phase1Filtered.length > 0) {
                  selectedArticles = phase1Filtered.slice(0, 5);
                } else {
                  const phase2Results = await queryVectors(
                    messageEmbedding, 10, true,
                    { source: "ticket_chat" }
                  );

                  const phase2Filtered = phase2Results.filter((r) => r.score >= 0.6);
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
                // Check if we already have form data for this conversation
                const hasFormData = conversationFormData.has(conversationId);
                
                if (!hasFormData) {
                  // First time - send form to collect customer details
                  await sendDetailCollectionForm(conversationId);
                  
                  // Store that we're waiting for form response
                  conversationFormData.set(conversationId, {
                    status: "pending_form",
                    initiatedBy: userName,
                    timestamp: Date.now()
                  });
                  
                  continue; // Don't escalate yet, wait for form response
                }

                // If we already have form data, proceed with escalation
                const formData = conversationFormData.get(conversationId);
                const { name, email, webUserId } = formData.data;

                // Send escalation message to customer
                await sendEscalationMessage(conversationId, userName);

                // Transfer to agent with email and webUserId
                await escalateToAgent(conversationId, name, email, webUserId, activeSwitchboardIntegration);

                // Clear form data after escalation
                conversationFormData.delete(conversationId);

                continue;
              }
            } catch (err) {
              console.error("Escalation check failed:", err.message);
            }

            // Skip bot reply if agent is already handling the conversation
            if (isAgentActive || isEscalated) {
              continue;
            }

            // Generate reply from OpenAI
            let botReply;
            try {
              const prompt = buildReplyBotPrompt(messageBody, selectedArticles);
              botReply = await generateContent(prompt);
            } catch (err) {
              console.error("OpenAI generation error:", err.message);
              botReply = "I'm sorry, I encountered an issue generating a response. Please try again.";
            }

            // Send reply
            try {
              await sendSunshineMessage(conversationId, botReply);
              
            } catch (err) {
              console.error("Failed to send reply:", err.message);
            }

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
        type: "business",
      },
      content: {
        type: "text",
        text: message,
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

/**
 * Send detail collection form to customer
 * Collects: name, email, and issue category before creating ticket
 * Uses Zendesk Sunshine Conversations API with form support
 */
async function sendDetailCollectionForm(conversationId) {
  try {
    if (!process.env.SUNSHINE_APP_ID || !process.env.ZENDESK_DOMAIN || !process.env.SUNSHINE_KEY_ID || !process.env.SUNSHINE_KEY_SECRET) {
      throw new Error("Missing required config: SUNSHINE_APP_ID, ZENDESK_DOMAIN, SUNSHINE_KEY_ID, SUNSHINE_KEY_SECRET");
    }

    // Form payload with all fields
    // ✅ Note: Sunshine API supports: text, email, select - NOT textarea
    const payload = {
      author: {
        type: "business",
      },
      content: {
        type: "form",
        text: "Please fill out this form to help us assist you better.",
        fields: [
          {
            type: "text",
            name: "name",
            label: "Your Name",
            placeholder: "Enter your full name...",
            required: true
          },
          {
            type: "email",
            name: "email",
            label: "Email Address",
            placeholder: "Enter your email...",
            required: true
          },
          {
            type: "select",
            name: "category",
            label: "Issue Category",
            placeholder: "Choose the category of your issue...",
            required: true,
            options: [
              {
                name: "billing",
                label: "Billing & Payments"
              },
              {
                name: "technical",
                label: "Technical Support"
              },
              {
                name: "account",
                label: "Account & Profile"
              },
              {
                name: "general",
                label: "General Inquiry"
              },
              {
                name: "other",
                label: "Other"
              }
            ]
          },
          {
            type: "text",
            name: "description",
            label: "Describe Your Issue",
            placeholder: "Please describe the issue in detail...",
            required: true
          }
        ]
      },
    };

    // Build endpoint and URL
    const endpoint = `/sc/v2/apps/${process.env.SUNSHINE_APP_ID}/conversations/${conversationId}/messages`;
    const fullURL = `https://${process.env.ZENDESK_DOMAIN}.zendesk.com${endpoint}`;

    // Use Sunshine API credentials (not Zendesk Support API)
    const auth = Buffer.from(
      `${process.env.SUNSHINE_KEY_ID}:${process.env.SUNSHINE_KEY_SECRET}`
    ).toString('base64');

    // Send form via axios with full URL and Sunshine Auth
    const response = await axios.post(
      fullURL,
      payload,
      {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data;
  } catch (err) {
    console.error(
      "Failed to send detail collection form:",
      err.response?.data || err.message,
    );
    throw err;
  }
}


/**
 * Get conversation history (messages) via API
 */

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
 * Escalate conversation to agent using Sunshine API switchboard
 * Uses the active switchboard integration from the conversation
 * 
 * @param {string} conversationId - Conversation ID from webhook
 * @param {string} customerName - Customer name for logging
 * @param {string} customerEmail - Customer email for ticket requester
 * @param {string} webUserId - Sunshine WebUser ID (temporary user in conversation)
 * @param {string} activeSwitchboardIntegration - Active switchboard integration ID or name from the conversation payload
 */
async function escalateToAgent(conversationId, customerName, customerEmail, webUserId, activeSwitchboardIntegration) {
  try {
    if (!process.env.SUNSHINE_APP_ID) {
      throw new Error("SUNSHINE_APP_ID not configured in .env");
    }

    // Step 1: Send confirmation message to customer
    const confirmationMsg = `Perfect! Connecting you to a human agent. They'll have all your details. One moment...`;
    await sendSunshineMessage(conversationId, confirmationMsg);

    // Step 2: Get Smooch user ID from conversation participants
    console.log(`� Fetching participants for conversation ${conversationId}`);
    let smoochUserId;
    try {
      const sunshineClient = createSunshineClient();
      const participantsRes = await sunshineClient.get(
        `/apps/${process.env.SUNSHINE_APP_ID}/conversations/${conversationId}/participants`
      );
      smoochUserId = participantsRes.data.participants?.[0]?.userId;
      console.log(`📧 Smooch user ID: ${smoochUserId}`);
    } catch (partErr) {
      console.error(`⚠️ Failed to fetch participants:`, partErr.message);
    }

    // Step 3: Find Zendesk WebUser by Smooch user ID
    console.log(`🔍 Searching for Zendesk WebUser with Smooch ID: ${smoochUserId}`);
    let zendeskUserId;
    if (smoochUserId) {
      try {
        const searchResponse = await axios.get(
          `https://${process.env.ZENDESK_DOMAIN}.zendesk.com/api/v2/users/search?query=${smoochUserId}`,
          {
            auth: {
              username: `${process.env.ZENDESK_EMAIL}/token`,
              password: process.env.ZENDESK_API_TOKEN
            },
            headers: {
              'Content-Type': 'application/json'
            }
          }
        );

        if (searchResponse.data.users && searchResponse.data.users.length > 0) {
          zendeskUserId = searchResponse.data.users[0].id;
          console.log(`✅ Found Zendesk WebUser: ${zendeskUserId}`);
        }
      } catch (searchErr) {
        console.error(`⚠️ Failed to search for Zendesk WebUser:`, searchErr.response?.data || searchErr.message);
      }
    }

    // Step 4: Update the Zendesk WebUser with real customer details
    if (zendeskUserId) {
      console.log(`📝 Updating Zendesk user ${zendeskUserId} with: ${customerName} (${customerEmail})`);
      try {
        const updateResponse = await axios.put(
          `https://${process.env.ZENDESK_DOMAIN}.zendesk.com/api/v2/users/${zendeskUserId}.json`,
          {
            user: {
              name: customerName,
              email: customerEmail
            }
          },
          {
            auth: {
              username: `${process.env.ZENDESK_EMAIL}/token`,
              password: process.env.ZENDESK_API_TOKEN
            },
            headers: {
              'Content-Type': 'application/json'
            }
          }
        );

        console.log(`✅ Updated Zendesk WebUser: ${customerName} (${customerEmail})`);
      } catch (updateErr) {
        console.error(`⚠️ Failed to update Zendesk WebUser:`, updateErr.response?.data || updateErr.message);
      }
    }

    // Step 5: Pass control to agent workspace via switchboard
    console.log(`🔄 Passing control to agent workspace...`);
    const sunshineClient = createSunshineClient();
    const escalationPayload = {
      switchboardIntegration: "zd-agentWorkspace",
      metadata: {
        reason: "user_requested_agent",
      },
    };

    const endpoint = `/apps/${process.env.SUNSHINE_APP_ID}/conversations/${conversationId}/passControl`;
    const response = await sunshineClient.post(endpoint, escalationPayload);

    console.log(`✅ Escalated conversation ${conversationId} to agent workspace`);
    console.log(`⏳ Waiting for agent to accept and for Zendesk to create ticket...`);

    return response.data;

  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    console.error(`Escalation error (status=${status}):`, JSON.stringify(body));

    throw err;
  }
}

/**
 * Send escalation confirmation message to customer
 */
async function sendEscalationMessage(conversationId, customerName) {
  try {
    const message = `I'm connecting you with one of our support agents. They'll be with you shortly to assist you further. Thank you for your patience! 👋`;
    await sendSunshineMessage(conversationId, message);
  } catch (err) {
    console.error("Failed to send escalation message:", err.message);
  }
}