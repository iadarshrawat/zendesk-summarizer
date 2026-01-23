/**
 * Chunk ticket data into searchable pieces
 * @param {object} ticket - Enriched ticket object
 * @returns {Array<{text: string, metadata: object}>} Array of chunks
 */
export function chunkTicketData(ticket) {
  const chunks = [];
  
  // Main ticket overview chunk
  const mainContent = `
Ticket ID: ${ticket.ticket_id}
Subject: ${ticket.subject}
Description: ${ticket.description || 'N/A'}
Status: ${ticket.status}
Priority: ${ticket.priority}
Tags: ${ticket.tags?.join(', ') || 'None'}
`.trim();
  
  chunks.push({
    text: mainContent,
    metadata: {
      type: 'ticket_overview',
      ticket_id: ticket.ticket_id,
      subject: ticket.subject,
      tags: ticket.tags?.join(', ') || ''
    }
  });
  
  // Conversation chunk
  if (ticket.conversation && ticket.conversation.length > 0) {
    const conversationText = ticket.conversation
      .map((msg, idx) => `${idx + 1}. ${msg.author}: ${msg.message}`)
      .join('\n\n');
    
    chunks.push({
      text: `Ticket ${ticket.ticket_id} Conversation:\n\n${conversationText}`,
      metadata: {
        type: 'conversation',
        ticket_id: ticket.ticket_id,
        subject: ticket.subject
      }
    });
  }
  
  // Resolution chunk
  if (ticket.resolution) {
    const resolutionText = `
Ticket ${ticket.ticket_id} Resolution:
Problem: ${ticket.subject}
Solution: ${ticket.resolution}
Related Tags: ${ticket.tags?.join(', ') || 'None'}
`.trim();
    
    chunks.push({
      text: resolutionText,
      metadata: {
        type: 'resolution',
        ticket_id: ticket.ticket_id,
        subject: ticket.subject,
        tags: ticket.tags?.join(', ') || ''
      }
    });
  }
  
  return chunks;
}

/**
 * Extract tickets from various JSON formats
 * @param {object|array} jsonData - JSON data to extract from
 * @returns {array} Array of tickets
 */
export function extractTicketsFromJSON(jsonData) {
  const tickets = [];
  
  if (jsonData.knowledge_base?.tickets) {
    tickets.push(...jsonData.knowledge_base.tickets);
  } else if (jsonData.tickets) {
    tickets.push(...jsonData.tickets);
  } else if (Array.isArray(jsonData)) {
    tickets.push(...jsonData);
  } else {
    tickets.push(jsonData);
  }
  
  return tickets;
}