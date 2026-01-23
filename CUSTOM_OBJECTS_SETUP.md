# 🎯 Setting Up Custom Objects in Zendesk for Import Tracking

## What Are Custom Objects?

Custom objects in Zendesk allow you to create structured data types beyond standard tickets/users. Perfect for tracking **import events, statistics, and audit logs**.

---

## **Path to Create Custom Objects in Zendesk Admin**

### **Step 1: Access Zendesk Admin Panel**
1. Log in to Zendesk as **Admin**
2. Click **Admin** (⚙️ icon) in the left sidebar
3. Go to **Settings → Objects and Fields → Objects**
   - OR directly: `https://YOUR_SUBDOMAIN.zendesk.com/admin/objects`

### **Step 2: Create New Custom Object**
1. Click **Create object** (blue button, top right)
2. Fill in details:
   ```
   Object Name: Import Event
   Display Name: Import Event
   Plural Name: Import Events
   Key: import_event
   Description: Tracks knowledge base import operations
   ```
3. Click **Create**

### **Step 3: Add Custom Fields to the Object**
After creating, you'll be on the **Fields** tab. Add these fields:

| Field Name | Type | Description |
|-----------|------|-------------|
| `import_type` | Single Select | auto / file / manual |
| `status` | Single Select | success / failed / pending |
| `tickets_count` | Number | Total tickets imported |
| `chunks_count` | Number | Total chunks created |
| `date_range_start` | Date | Start date for auto-import |
| `date_range_end` | Date | End date for auto-import |
| `file_name` | Text | Filename for file imports |
| `processing_time` | Text | Time taken (e.g., "12.45s") |
| `error_message` | Text | Error details if failed |
| `pinecone_vectors` | Number | Vectors uploaded to Pinecone |
| `duplicate_blocked` | Boolean | Was this a duplicate? |
| `admin_user` | User | Which admin performed import |

**To add each field:**
1. Click **Add field** → Select type → Fill name → Click **Save**

### **Step 4: Create Records via API**
Once your object is set up, you can create records via the Zendesk API.

---

## **Code Integration: Send Import Data to Zendesk Custom Object**

Add this function to your `backend/server.js`:

```javascript
/**
 * Create a custom object record in Zendesk for import tracking
 * Stores import statistics and audit trail
 */
async function createZendeskImportRecord(importData) {
  try {
    const zendeskClient = createZendeskClient();
    
    const customObjectRecord = {
      attributes: {
        import_type: importData.type, // 'auto' or 'file'
        status: 'success',
        tickets_count: importData.ticketsCount,
        chunks_count: importData.chunksCount,
        date_range_start: importData.dateRangeStart || null,
        date_range_end: importData.dateRangeEnd || null,
        file_name: importData.fileName || null,
        processing_time: importData.processingTime,
        pinecone_vectors: importData.vectorCount,
        duplicate_blocked: false,
        admin_user: importData.adminId || null
      }
    };

    // POST to Zendesk custom objects API
    const response = await zendeskClient.post(
      '/custom_objects/records/import_event',
      { record: customObjectRecord }
    );

    console.log(`✅ Custom object record created:`, response.data.record.id);
    return response.data.record;
  } catch (err) {
    console.warn(`⚠️ Failed to create custom object record:`, err.message);
    // Don't fail the import if custom object creation fails
    return null;
  }
}

/**
 * Log a failed import to custom object
 */
async function logFailedImport(importData, errorMessage) {
  try {
    const zendeskClient = createZendeskClient();
    
    const customObjectRecord = {
      attributes: {
        import_type: importData.type,
        status: 'failed',
        error_message: errorMessage,
        file_name: importData.fileName || null,
        duplicate_blocked: importData.isDuplicate || false
      }
    };

    const response = await zendeskClient.post(
      '/custom_objects/records/import_event',
      { record: customObjectRecord }
    );

    console.log(`📋 Failed import logged to custom object`);
    return response.data.record;
  } catch (err) {
    console.warn(`⚠️ Failed to log error to custom object:`, err.message);
    return null;
  }
}
```

---

## **Integration Points in Existing Code**

### **1. After Successful Auto-Import (in `/auto-import-tickets` endpoint)**

Add this after the Pinecone upload is complete:

```javascript
// After: "✅ Auto-import completed successfully!"

const customRecord = await createZendeskImportRecord({
  type: 'auto',
  ticketsCount: enrichedTickets.length,
  chunksCount: totalChunks,
  dateRangeStart: startDate,
  dateRangeEnd: endDate,
  processingTime: processingTime,
  vectorCount: vectors.length
});

res.json({
  status: "Import completed successfully",
  ticketsProcessed: enrichedTickets.length,
  totalChunks: totalChunks,
  processingTime: processingTime,
  dateRange: { start: startDate, end: endDate },
  customObjectId: customRecord?.id, // Include in response
  eventLogged: true
});
```

### **2. After Successful File Import (in `/import-file` endpoint)**

```javascript
// After file import completes

const customRecord = await createZendeskImportRecord({
  type: 'file',
  ticketsCount: tickets.length || 1,
  chunksCount: totalChunks,
  fileName: fileName,
  processingTime: `${(Date.now() - startTime) / 1000}s`,
  vectorCount: vectors.length
});

res.json({
  status: "File imported successfully",
  fileName: fileName,
  customObjectId: customRecord?.id
});
```

### **3. On Duplicate Import Blocked**

```javascript
// When duplicate is detected (before returning 409 error)

await logFailedImport({
  type: duplicateCheck.isDuplicate ? 'auto' : 'file',
  fileName: fileName,
  isDuplicate: true
}, `Duplicate import blocked. Last import: ${duplicateCheck.lastImportTime}`);
```

---

## **View Custom Objects in Zendesk Admin**

### **After Creating Records:**
1. Go to **Admin → Objects and Fields → Objects**
2. Click on **Import Event** object
3. Click **Records** tab
4. You'll see all import history records with full details

### **Create a Report (Analytics)**
1. Go to **Admin → Reporting**
2. Create **New report**
3. Select **Custom objects** → **Import Events**
4. Build dashboard showing:
   - Imports per day
   - Total tickets imported
   - Success vs failed rate
   - Processing time trends

---

## **API Endpoints to Manage Custom Objects**

Once set up, you can use these Zendesk API endpoints:

### **Create Record**
```bash
POST /api/v2/custom_objects/records/import_event
Content-Type: application/json
Authorization: Basic {base64_encoded_credentials}

{
  "record": {
    "attributes": {
      "import_type": "auto",
      "status": "success",
      "tickets_count": 150,
      "chunks_count": 450
    }
  }
}
```

### **List All Records**
```bash
GET /api/v2/custom_objects/records/import_event
```

### **Get Single Record**
```bash
GET /api/v2/custom_objects/records/import_event/{record_id}
```

### **Update Record**
```bash
PATCH /api/v2/custom_objects/records/import_event/{record_id}
Content-Type: application/json

{
  "record": {
    "attributes": {
      "status": "completed"
    }
  }
}
```

### **Delete Record**
```bash
DELETE /api/v2/custom_objects/records/import_event/{record_id}
```

---

## **Full Implementation Path (Summary)**

### **Phase 1: Zendesk Setup** ✅ (Manual)
1. Admin → Objects and Fields → Objects
2. Create "Import Event" custom object
3. Add fields (import_type, status, tickets_count, etc.)
4. Save

### **Phase 2: Backend Integration** (Code)
1. Add `createZendeskImportRecord()` function to `server.js`
2. Add `logFailedImport()` function for error tracking
3. Call these functions in `/auto-import-tickets` endpoint
4. Call these functions in `/import-file` endpoint
5. Call these functions when duplicates are blocked

### **Phase 3: Testing**
1. Start backend: `node server.js`
2. Trigger an import via Navbar iframe
3. Check Zendesk Admin → Objects → Import Event → Records
4. Verify record was created with correct data

### **Phase 4: Dashboard** (Optional)
1. Create Zendesk report
2. Visualize import metrics
3. Track trends over time

---

## **Example: How It Looks in Zendesk**

After integration, you'll see in **Admin → Objects → Import Event → Records**:

```
Record ID: 12345
Import Type: auto
Status: success
Tickets Count: 150
Chunks Count: 450
Date Range: 2026-01-01 to 2026-01-21
Processing Time: 12.45s
Created At: 2026-01-21 14:30:45
Updated At: 2026-01-21 14:30:45
```

---

## **Next Steps**

1. **Create the custom object in Zendesk Admin** (steps 1-4 above)
2. **I can add the integration code to your server.js** (ready to implement)
3. **Test by running an import**
4. **Verify records appear in Zendesk Admin**

**Would you like me to:**
- ✅ Add the code directly to your `server.js`?
- ✅ Create a helper module for custom object operations?
- ✅ Add error handling and retry logic?
- ✅ Create a dashboard query script?

**Let me know and I'll implement it!**
