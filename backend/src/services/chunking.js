/**
 * Chunk ticket data into searchable pieces
 * Respects OpenAI embedding model's 8192 token limit
 * Using conservative estimate: 1 token ≈ 4 characters
 * So max chunk: 8192 * 4 = 32768 chars, but we use 3000 chars (750 tokens) to be safe
 * @param {object} ticket - Enriched ticket object
 * @returns {Array<{text: string, metadata: object}>} Array of chunks
 */
export function chunkTicketData(ticket) {
  const chunks = [];
  
  // Max characters per chunk (3000 chars ≈ 750 tokens, very conservative)
  // This ensures we never hit the 8192 token limit
  const MAX_CHUNK_SIZE = 3000;
  
  /**
   * Split text into chunks if it exceeds max size
   */
  function splitIfNeeded(text, maxSize = MAX_CHUNK_SIZE) {
    if (text.length <= maxSize) {
      return [text];
    }
    
    const splitChunks = [];
    let remaining = text;
    let partNum = 1;
    const totalParts = Math.ceil(text.length / maxSize);
    
    while (remaining.length > 0) {
      const chunk = remaining.substring(0, maxSize);
      splitChunks.push(`${chunk.trim()} [Part ${partNum}/${totalParts}]`);
      remaining = remaining.substring(maxSize).trim();
      partNum++;
    }
    
    return splitChunks;
  }
  
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
      has_custom_fields: Object.keys(ticket.custom_fields || {}).length > 0,
      brand: ticket.brand || 'default',
      brand_id: ticket.brand_id || null
    }
  });
  
  // Conversation chunk - split if too long
  if (ticket.conversation && ticket.conversation.length > 0) {
    const conversationText = ticket.conversation
      .map((msg, idx) => `${idx + 1}. ${msg.author}: ${msg.message}`)
      .join('\n\n');
    
    const conversationChunks = splitIfNeeded(`Ticket ${ticket.ticket_id} Conversation:\n\n${conversationText}`);
    
    conversationChunks.forEach((chunk, idx) => {
      chunks.push({
        text: chunk,
        metadata: {
          type: 'conversation',
          ticket_id: ticket.ticket_id,
          subject: ticket.subject,
          part: idx + 1,
          totalParts: conversationChunks.length,
          brand: ticket.brand || 'default',
          brand_id: ticket.brand_id || null
        }
      });
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
        tags: ticket.tags?.join(', ') || '',
        brand: ticket.brand || 'default',
        brand_id: ticket.brand_id || null
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
        field_count: Object.keys(ticket.custom_fields).length,
        brand: ticket.brand || 'default',
        brand_id: ticket.brand_id || null
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