import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.ZENDESK_EMAIL || !process.env.ZENDESK_API_TOKEN || !process.env.ZENDESK_DOMAIN) {
  console.warn("⚠️ Zendesk credentials missing - auto-import feature will not work");
  console.warn("💡 Add ZENDESK_EMAIL, ZENDESK_API_TOKEN, and ZENDESK_DOMAIN to .env file");
}

/**
 * Create Zendesk API client
 */
export function createZendeskClient() {
  if (!process.env.ZENDESK_EMAIL || !process.env.ZENDESK_API_TOKEN || !process.env.ZENDESK_DOMAIN) {
    throw new Error("Zendesk credentials not configured");
  }

  const auth = Buffer.from(
    `${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`
  ).toString('base64');

  return axios.create({
    baseURL: `https://${process.env.ZENDESK_DOMAIN}.zendesk.com/api/v2`,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json'
    }
  });
}

/**
 * Fetch tickets by date range
 */
export async function fetchTicketsByDateRange(startDate, endDate) {
  const zendeskClient = createZendeskClient();
  const allTickets = [];
  
  const formatDate = (dateStr) => {
    const date = new Date(dateStr);
    return date.toISOString().split('T')[0];
  };
  
  const startFormatted = formatDate(startDate);
  const endFormatted = formatDate(endDate);
  
  console.log(`📅 Fetching tickets from ${startFormatted} to ${endFormatted}`);
  
  const query = `type:ticket created>=${startFormatted} created<=${endFormatted}`;
  const encodedQuery = encodeURIComponent(query);
  
  let nextUrl = `/search.json?query=${encodedQuery}&sort_by=created_at&sort_order=desc`;
  let page = 1;
  
  while (nextUrl) {
    console.log(`📄 Fetching page ${page}...`);
    
    try {
      const response = await zendeskClient.get(nextUrl);
      const tickets = response.data.results || [];
      
      console.log(`✓ Found ${tickets.length} tickets on page ${page}`);
      allTickets.push(...tickets);
      
      nextUrl = response.data.next_page || null;
      page++;
      
      if (nextUrl) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (err) {
      console.error(`❌ Error fetching page ${page}:`, err.message);
      break;
    }
  }
  
  console.log(`✅ Total tickets fetched: ${allTickets.length}`);
  return allTickets;
}

/**
 * Fetch ticket comments
 */
export async function fetchTicketComments(ticketId) {
  const zendeskClient = createZendeskClient();
  
  try {
    const response = await zendeskClient.get(`/tickets/${ticketId}/comments.json`);
    return response.data.comments || [];
  } catch (err) {
    console.error(`❌ Error fetching comments for ticket ${ticketId}:`, err.message);
    return [];
  }
}

/**
 * Enrich ticket with comments
 */
export async function enrichTicketWithComments(ticket) {
  const comments = await fetchTicketComments(ticket.id);
  
  const conversation = comments.map(comment => ({
    author: comment.author_id === ticket.requester_id ? 'Customer' : 'Agent',
    message: comment.plain_body || comment.body || '',
    created_at: comment.created_at,
    public: comment.public
  }));
  
  const agentComments = conversation.filter(c => c.author === 'Agent' && c.message.trim());
  const resolution = agentComments.length > 0 
    ? agentComments[agentComments.length - 1].message 
    : null;
  
  return {
    ticket_id: ticket.id,
    subject: ticket.subject || '',
    description: ticket.description || '',
    status: ticket.status,
    priority: ticket.priority,
    tags: ticket.tags || [],
    created_at: ticket.created_at,
    updated_at: ticket.updated_at,
    conversation: conversation,
    resolution: resolution
  };
}

/**
 * Create custom object type for import logging
 */
export async function createCustomObjectType() {
  try {
    const zendeskClient = createZendeskClient();
    
    const objectKey = 'kb_import_log_v3';
    console.log(`🔧 Checking if custom object '${objectKey}' exists...`);
    
    try {
      const getResponse = await zendeskClient.get(`/custom_objects/${objectKey}`);
      console.log(`✅ Custom object '${objectKey}' already exists`);
      return true;
    } catch (err) {
      if (err.response?.status !== 404) {
        throw err;
      }
      console.log(`📝 Custom object not found, creating new...`);
    }
    
    const createResponse = await zendeskClient.post('/custom_objects', {
      custom_object: {
        key: objectKey,
        title: 'KB Import Records',
        title_pluralized: 'KB Import Records',
        description: 'Tracks knowledge base import history',
        raw_title: 'KB Import Records',
        raw_title_pluralized: 'KB Import Records',
        raw_description: 'Tracks knowledge base import history'
      }
    });
    
    console.log(`✅ Custom object created successfully`);
    
    const fieldsToCreate = [
      { key: 'import_date', type: 'date', title: 'Import Date' },
      { key: 'start_date', type: 'date', title: 'Start Date' },
      { key: 'end_date', type: 'date', title: 'End Date' },
      { key: 'status', type: 'text', title: 'Status' },
      { key: 'ticket_count', type: 'integer', title: 'Ticket Count' },
      { key: 'source', type: 'text', title: 'Source' }
    ];
    
    console.log(`🔧 Creating custom fields...`);
    for (const field of fieldsToCreate) {
      try {
        await zendeskClient.post(`/custom_objects/${objectKey}/fields`, {
          custom_object_field: {
            key: field.key,
            type: field.type,
            title: field.title,
            raw_title: field.title
          }
        });
        console.log(`   ✅ Created field: ${field.key}`);
      } catch (fieldErr) {
        if (fieldErr.response?.status === 422) {
          console.log(`   ℹ️  Field ${field.key} already exists`);
        } else {
          console.warn(`   ⚠️ Could not create field ${field.key}:`, fieldErr.response?.data?.error || fieldErr.message);
        }
      }
    }
    
    return true;
  } catch (err) {
    console.warn(`⚠️ Could not create custom object:`, err.message);
    return false;
  }
}

/**
 * Create import record in Zendesk
 */
export async function createZendeskImportRecord(importData = {}) {
  try {
    const zendeskClient = createZendeskClient();
    const {
      startDate,
      endDate,
      status = 'success',
      ticketCount = 0,
      source = 'auto_import'
    } = importData;

    const today = new Date().toISOString().split('T')[0];
    const recordName = `Import ${today} | ${startDate} to ${endDate} | ${status} | ${ticketCount} tickets | ${source}`;

    console.log(`📝 Creating import record in Zendesk...`);

    // Step 1: Create the record with just the name
    const recordPayload = {
      custom_object_record: {
        name: recordName
      }
    };

    const createResponse = await zendeskClient.post(
      '/custom_objects/kb_import_log_v3/records',
      recordPayload
    );

    const recordId = createResponse.data.custom_object_record?.id;
    console.log(`✅ Record created with ID: ${recordId}`);

    // Step 2: Update the record with custom field values
    const updatePayload = {
      custom_object_record: {
        custom_object_fields: {
          import_date: today,
          start_date: startDate,
          end_date: endDate,
          status: status,
          ticket_count: ticketCount,
          source: source
        }
      }
    };

    const updateResponse = await zendeskClient.patch(
      `/custom_objects/kb_import_log_v3/records/${recordId}`,
      updatePayload
    );

    console.log(`✅ Custom fields populated successfully`);
    return updateResponse.data.custom_object_record;

  } catch (err) {
    console.warn(`⚠️ Could not create import record:`, err.message);
    return null;
  }
}

/**
 * Get import records
 */
export async function getImportRecords(limit = 100) {
  try {
    const zendeskClient = createZendeskClient();
    
    const response = await zendeskClient.get(
      `/custom_object_records?custom_object_key=kb_import_log_v3&per_page=${limit}`
    );
    
    return response.data.custom_object_records || [];
  } catch (err) {
    console.warn(`⚠️ Could not fetch import records:`, err.message);
    return [];
  }
}