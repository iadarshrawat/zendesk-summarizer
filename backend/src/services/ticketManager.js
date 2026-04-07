/**
 * Zendesk Ticket Manager
 * Handles ticket creation, routing, and agent assignment
 */

import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

/**
 * Get Zendesk API client
 */
function getZendeskClient() {
  if (!process.env.ZENDESK_DOMAIN || !process.env.ZENDESK_EMAIL || !process.env.ZENDESK_API_TOKEN) {
    throw new Error("Zendesk credentials not configured");
  }

  const basicAuth = Buffer.from(
    `${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`
  ).toString("base64");

  return axios.create({
    baseURL: `https://${process.env.ZENDESK_DOMAIN}.zendesk.com/api/v2`,
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/json"
    }
  });
}

/**
 * Get all support groups
 * Useful for finding the correct group ID for ticket routing
 */
export async function getAllGroups() {
  try {
    const client = getZendeskClient();
    const response = await client.get("/groups");
    return response.data.groups;
  } catch (err) {
    console.error("❌ Failed to fetch groups:", err.message);
    throw err;
  }
}

/**
 * Get group by name
 */
export async function getGroupByName(groupName) {
  try {
    const groups = await getAllGroups();
    return groups.find(g => g.name.toLowerCase() === groupName.toLowerCase());
  } catch (err) {
    console.error("❌ Failed to find group:", err.message);
    throw err;
  }
}

/**
 * Get available agents in a group (online/idle)
 */
export async function getAvailableAgentsInGroup(groupId) {
  try {
    const client = getZendeskClient();
    const response = await client.get("/users", {
      params: {
        role: "agent",
        group_id: groupId
      }
    });
    return response.data.users;
  } catch (err) {
    console.error("❌ Failed to fetch agents:", err.message);
    throw err;
  }
}

/**
 * Create a new Zendesk ticket
 */
export async function createTicket(ticketData) {
  try {
    if (!ticketData.subject || !ticketData.description) {
      throw new Error("subject and description are required");
    }

    const client = getZendeskClient();

    const payload = {
      ticket: {
        subject: ticketData.subject,
        description: ticketData.description,
        requester: ticketData.requester || {
          name: "Customer",
          email: process.env.ZENDESK_EMAIL
        },
        group_id: ticketData.group_id || process.env.ZENDESK_SUPPORT_GROUP_ID,
        priority: ticketData.priority || "normal",
        tags: ticketData.tags || [],
        custom_fields: ticketData.custom_fields || {}
      }
    };

    console.log(`🎫 Creating ticket: "${ticketData.subject}"`);

    const response = await client.post("/tickets", payload);
    const ticket = response.data.ticket;

    console.log(`✅ Ticket created: #${ticket.id}`);
    return ticket;

  } catch (err) {
    console.error("❌ Failed to create ticket:", err.message);
    throw err;
  }
}

/**
 * Update ticket
 */
export async function updateTicket(ticketId, updateData) {
  try {
    const client = getZendeskClient();

    const payload = {
      ticket: updateData
    };

    const response = await client.put(`/tickets/${ticketId}`, payload);
    console.log(`✅ Ticket #${ticketId} updated`);
    return response.data.ticket;

  } catch (err) {
    console.error("❌ Failed to update ticket:", err.message);
    throw err;
  }
}

/**
 * Add comment to ticket
 */
export async function addTicketComment(ticketId, comment, isPublic = true) {
  try {
    const client = getZendeskClient();

    const payload = {
      ticket: {
        comment: {
          body: comment,
          public: isPublic
        }
      }
    };

    const response = await client.put(`/tickets/${ticketId}`, payload);
    console.log(`✅ Comment added to ticket #${ticketId}`);
    return response.data.ticket;

  } catch (err) {
    console.error("❌ Failed to add comment:", err.message);
    throw err;
  }
}

/**
 * Link Sunshine conversation to Zendesk ticket
 * Stores conversation ID in custom field
 */
export async function linkConversationToTicket(ticketId, conversationId, customFieldId = "360015632651") {
  try {
    const updateData = {
      custom_fields: [
        {
          id: customFieldId,
          value: conversationId
        }
      ]
    };

    const ticket = await updateTicket(ticketId, updateData);
    console.log(`✅ Linked conversation ${conversationId} to ticket #${ticketId}`);
    return ticket;

  } catch (err) {
    console.error("❌ Failed to link conversation:", err.message);
    throw err;
  }
}

/**
 * Get ticket by ID
 */
export async function getTicket(ticketId) {
  try {
    const client = getZendeskClient();
    const response = await client.get(`/tickets/${ticketId}`);
    return response.data.ticket;
  } catch (err) {
    console.error("❌ Failed to fetch ticket:", err.message);
    throw err;
  }
}

/**
 * Search for ticket by conversation ID (in custom field)
 */
export async function getTicketByConversationId(conversationId, customFieldId = "360015632651") {
  try {
    const client = getZendeskClient();
    const query = `custom_field_${customFieldId}:${conversationId}`;
    
    const response = await client.get("/search", {
      params: { query }
    });

    if (response.data.results && response.data.results.length > 0) {
      return response.data.results[0];
    }
    return null;

  } catch (err) {
    console.error("❌ Failed to search ticket:", err.message);
    throw err;
  }
}
