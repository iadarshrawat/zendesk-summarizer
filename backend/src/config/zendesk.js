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
 * Cache for form fields (to avoid redundant API calls)
 */
let formFieldsCache = null;

/**
 * Fetch all ticket form fields
 */
export async function fetchFormFields() {
  // Return cached fields if available
  if (formFieldsCache) {
    console.log(`📋 Using cached form fields (${Object.keys(formFieldsCache).length} fields)`);
    return formFieldsCache;
  }

  const zendeskClient = createZendeskClient();
  const fieldsMap = {};
  
  try {
    console.log(`📋 Fetching ticket form fields...`);
    
    let nextUrl = '/ticket_fields.json';
    let page = 1;
    let totalFields = 0;
    
    while (nextUrl) {
      try {
        const response = await zendeskClient.get(nextUrl);
        const fields = response.data.ticket_fields || [];
        
        // Map field ID to field details (id, title, type, description)
        for (const field of fields) {
          fieldsMap[field.id] = {
            id: field.id,
            title: field.title,
            type: field.type,
            description: field.description || '',
            system: field.system,
            key: field.key || ''
          };
        }
        
        totalFields += fields.length;
        console.log(`   ✓ Fetched ${fields.length} fields on page ${page}`);
        
        nextUrl = response.data.next_page || null;
        page++;
        
        if (nextUrl) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (err) {
        console.error(`❌ Error fetching page ${page}:`, err.message);
        break;
      }
    }
    
    console.log(`✅ Total form fields fetched: ${totalFields}`);
    
    // Cache the results
    formFieldsCache = fieldsMap;
    return fieldsMap;
  } catch (err) {
    console.error(`❌ Error fetching form fields:`, err.message);
    return {};
  }
}

/**
 * Get field name by ID
 */
export function getFieldNameById(fieldId, fieldsMap) {
  if (!fieldsMap || !fieldsMap[fieldId]) {
    return `Unknown Field (${fieldId})`;
  }
  return fieldsMap[fieldId].title;
}

/**
 * Map ticket custom fields to human-readable format
 */
export function mapTicketCustomFields(ticket, fieldsMap) {
  if (!ticket.custom_fields || !Array.isArray(ticket.custom_fields)) {
    return {};
  }
  
  const mappedFields = {};
  
  for (const field of ticket.custom_fields) {
    const fieldId = field.id;
    const fieldValue = field.value;
    
    if (fieldValue === null || fieldValue === '') {
      continue; // Skip empty fields
    }
    
    const fieldInfo = fieldsMap[fieldId];
    if (fieldInfo) {
      mappedFields[fieldInfo.title] = {
        value: fieldValue,
        type: fieldInfo.type,
        key: fieldInfo.key,
        description: fieldInfo.description
      };
    } else {
      mappedFields[`Field_${fieldId}`] = {
        value: fieldValue,
        type: 'unknown',
        key: '',
        description: ''
      };
    }
  }
  
  return mappedFields;
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
 * Enrich ticket with comments and form fields
 */
export async function enrichTicketWithComments(ticket, fieldsMap = null) {
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
  
  // Map custom fields if fieldsMap is provided
  const customFields = fieldsMap 
    ? mapTicketCustomFields(ticket, fieldsMap)
    : {};
  
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
    resolution: resolution,
    custom_fields: customFields,
    requester_id: ticket.requester_id,
    assignee_id: ticket.assignee_id
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
    } catch (err) {
      if (err.response?.status !== 404) {
        throw err;
      }
      console.log(`📝 Custom object not found, creating new...`);
      
      await zendeskClient.post('/custom_objects', {
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
    }
    
    const fieldsToCreate = [
      { key: 'import_date', type: 'date', title: 'Import Date' },
      { key: 'start_date', type: 'date', title: 'Start Date' },
      { key: 'end_date', type: 'date', title: 'End Date' },
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
 * Create custom object type for import errors
 */
export async function createErrorCustomObjectType() {
  try {
    const zendeskClient = createZendeskClient();
    
    const objectKey = 'kb_import_errors';
    console.log(`🔧 Checking if error custom object '${objectKey}' exists...`);
    
    try {
      const getResponse = await zendeskClient.get(`/custom_objects/${objectKey}`);
      console.log(`✅ Error custom object '${objectKey}' already exists`);
    } catch (err) {
      if (err.response?.status !== 404) {
        throw err;
      }
      console.log(`📝 Error custom object not found, creating new...`);
      
      await zendeskClient.post('/custom_objects', {
        custom_object: {
          key: objectKey,
          title: 'KB Import Errors',
          title_pluralized: 'KB Import Errors',
          description: 'Tracks knowledge base import errors',
          raw_title: 'KB Import Errors',
          raw_title_pluralized: 'KB Import Errors',
          raw_description: 'Tracks knowledge base import errors'
        }
      });
      
      console.log(`✅ Error custom object created successfully`);
    }
    
    const fieldsToCreate = [
      { key: 'error_date', type: 'date', title: 'Error Date' },
      { key: 'start_date', type: 'date', title: 'Start Date' },
      { key: 'end_date', type: 'date', title: 'End Date' },
      { key: 'error_message', type: 'text', title: 'Error Message' },
      { key: 'error_details', type: 'text', title: 'Error Details' },
      { key: 'source', type: 'text', title: 'Source' }
    ];
    
    console.log(`🔧 Creating error custom fields...`);
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
    console.warn(`⚠️ Could not create error custom object:`, err.message);
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
      ticketCount = 0,
      source = 'auto_import'
    } = importData;

    const today = new Date().toISOString().split('T')[0];
    const recordName = `Import ${today} | ${startDate} to ${endDate} | ${ticketCount} tickets | ${source}`;

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
 * Create import record in Zendesk
 */
/**
 * Create error record in Zendesk
 */
export async function createZendeskErrorImportRecord(errorData = {}) {
  try {
    const zendeskClient = createZendeskClient();
    const {
      startDate = 'N/A',
      endDate = 'N/A',
      errorMessage = 'Unknown error',
      errorDetails = '',
      source = 'auto_import'
    } = errorData;

    const today = new Date().toISOString().split('T')[0];
    const recordName = `Error ${today} | ${startDate} to ${endDate} | ${errorMessage.substring(0, 50)}`;

    console.log(`📝 Creating error record in Zendesk...`);

    // Step 1: Create the record with just the name
    const recordPayload = {
      custom_object_record: {
        name: recordName
      }
    };

    const createResponse = await zendeskClient.post(
      '/custom_objects/kb_import_errors/records',
      recordPayload
    );

    const recordId = createResponse.data.custom_object_record?.id;
    console.log(`✅ Error record created with ID: ${recordId}`);

    // Step 2: Update the record with custom field values
    const updatePayload = {
      custom_object_record: {
        custom_object_fields: {
          error_date: today,
          start_date: startDate,
          end_date: endDate,
          error_message: errorMessage,
          error_details: errorDetails,
          source: source
        }
      }
    };

    const updateResponse = await zendeskClient.patch(
      `/custom_objects/kb_import_errors/records/${recordId}`,
      updatePayload
    );

    console.log(`✅ Error custom fields populated successfully`);
    return updateResponse.data.custom_object_record;

  } catch (err) {
    console.warn(`⚠️ Could not create error record:`, err.message);
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

/**
 * Get error records
 */
export async function getErrorRecords(limit = 100) {
  try {
    const zendeskClient = createZendeskClient();
    
    const response = await zendeskClient.get(
      `/custom_object_records?custom_object_key=kb_import_errors&per_page=${limit}`
    );
    
    return response.data.custom_object_records || [];
  } catch (err) {
    console.warn(`⚠️ Could not fetch error records:`, err.message);
    return [];
  }
}