/**
 * Chunk ticket data into searchable pieces
 * @param {object} ticket - Enriched ticket object
 * @returns {Array<{text: string, metadata: object}>} Array of chunks
 */
export function chunkTicketData(ticket) {
  const chunks = [];
  
  // Build custom fields text if available
  let customFieldsText = '';
  if (ticket.custom_fields && Object.keys(ticket.custom_fields).length > 0) {
    const fieldLines = Object.entries(ticket.custom_fields).map(([name, data]) => {
      const value = typeof data === 'object' ? data.value : data;
      return `${name}: ${value}`;
    });
    customFieldsText = '\nCustom Fields:\n' + fieldLines.join('\n');
  }
  
  // Main ticket overview chunk
  const mainContent = `
Ticket ID: ${ticket.ticket_id}
Subject: ${ticket.subject}
Description: ${ticket.description || 'N/A'}
Status: ${ticket.status}
Priority: ${ticket.priority}
Tags: ${ticket.tags?.join(', ') || 'None'}${customFieldsText}
`.trim();
  
  chunks.push({
    text: mainContent,
    metadata: {
      type: 'ticket_overview',
      ticket_id: ticket.ticket_id,
      subject: ticket.subject,
      tags: ticket.tags?.join(', ') || '',
      has_custom_fields: Object.keys(ticket.custom_fields || {}).length > 0
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
  
  // Custom fields chunk (if any custom fields exist)
  if (ticket.custom_fields && Object.keys(ticket.custom_fields).length > 0) {
    const fieldsText = Object.entries(ticket.custom_fields)
      .map(([name, data]) => {
        const value = typeof data === 'object' ? data.value : data;
        const type = typeof data === 'object' ? ` (${data.type})` : '';
        return `${name}${type}: ${value}`;
      })
      .join('\n');
    
    chunks.push({
      text: `Ticket ${ticket.ticket_id} Form Fields:\n\n${fieldsText}`,
      metadata: {
        type: 'custom_fields',
        ticket_id: ticket.ticket_id,
        subject: ticket.subject,
        field_count: Object.keys(ticket.custom_fields).length
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