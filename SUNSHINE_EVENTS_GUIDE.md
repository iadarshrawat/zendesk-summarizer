# 📊 Viewing Import Statistics & Sunshine Events in Zendesk

## Quick Answer: Where to See Stats

### **1. Immediate UI Feedback (Navbar Modal)**
When you click "📥 Fetch & Import Tickets", you'll see a **success message with stats**:
```
✅ Successfully imported!
📊 Tickets: 150
📦 Chunks: 450
⏱️ Time: 12.45s
```
This appears **right in the modal** after import completes.

---

## **2. Backend Console Logs** (Most Detailed)
When running the backend (`node server.js`), you'll see detailed logs:

```
🚀 Starting auto-import for 2026-01-01 to 2026-01-21
📅 Fetching tickets from 2026-01-01 to 2026-01-21
📄 Fetching page 1...
✓ Found 100 tickets on page 1
📄 Fetching page 2...
✓ Found 50 tickets on page 2

📊 Processing 150 tickets...
🔄 Enriching ticket 1/150 (ID: 12345)
🔄 Enriching ticket 2/150 (ID: 12346)
...

📦 Creating chunks and embeddings...
📦 Created 3 chunks for ticket 12345
📦 Created 2 chunks for ticket 12346
...

📤 Uploading 450 vectors to Pinecone...
✓ Uploaded batch 1/5
✓ Uploaded batch 2/5
...

✅ Auto-import completed successfully!
📊 Stats: 150 tickets, 450 chunks, 12.45s
📝 Event logged: ticket_import_auto
```

---

## **3. Recent Imports Endpoint** (API)
Call this endpoint to retrieve all recent imports:

```bash
# Get last 20 imports
curl http://localhost:3000/recent-imports

# Get last 50 imports
curl http://localhost:3000/recent-imports?limit=50
```

**Response:**
```json
{
  "recentImports": [
    {
      "type": "auto",
      "timestamp": "2026-01-21T14:30:45.123Z",
      "metadata": {
        "ticketsCount": 150,
        "chunksCount": 450,
        "dateRange": {
          "start": "2026-01-01",
          "end": "2026-01-21"
        },
        "processingTime": "12.45s"
      }
    },
    {
      "type": "file",
      "timestamp": "2026-01-21T14:20:15.987Z",
      "metadata": {
        "fileName": "tickets.json",
        "ticketsCount": 50,
        "chunksCount": 120
      }
    }
  ],
  "totalCount": 2
}
```

---

## **4. Zendesk Admin Panel** (Custom Events)
Currently, custom Sunshine events are logged **server-side** but not visible in standard Zendesk UI.

To view them in Zendesk admin in the future, you would need to:

### **Option A: View via Zendesk API** (Advanced)
```bash
# Requires Zendesk authentication and setup of custom event types
curl -H "Authorization: Basic $(echo -n 'email@domain.com/token:YOUR_API_TOKEN' | base64)" \
  https://YOUR_SUBDOMAIN.zendesk.com/api/v2/custom_events
```

### **Option B: Create a Dashboard in Zendesk** (Requires Admin)
1. Go to Zendesk Admin → Dashboards
2. Create custom dashboard
3. Add widgets using the Explore API to query import events
4. Track: imports per day, tickets imported, chunks created

### **Option C: Use Zendesk Insights** (Recommended)
1. Zendesk Admin → Insights
2. Create custom report
3. Filter by:
   - Event type: `ticket_import_auto` or `ticket_import_file`
   - Date range
   - Source: `ticket_copilot_backend`

---

## **5. Quick Check: Verify Data Was Imported**

### **Check Pinecone Index Stats**
```bash
curl http://localhost:3000/index-stats
```

**Response:**
```json
{
  "indexName": "zendesk-kb",
  "stats": {
    "dimensionality": 768,
    "indexFullness": 0.45,
    "totalVectorCount": 1250
  }
}
```

This shows:
- ✅ Total vectors in knowledge base: `1250`
- ✅ Index is 45% full

### **Test Search to Verify Imported Data**
```bash
curl -X POST http://localhost:3000/debug-search \
  -H "Content-Type: application/json" \
  -d '{"query": "billing issue"}'
```

Returns matching tickets from your imported knowledge base.

---

## **6. View Statistics Dashboard (Proposed)**

To create a comprehensive stats view, you could:

### **Option 1: Add Stats Endpoint to Backend**
```javascript
// New endpoint (can be added to server.js)
app.get("/import-stats", (req, res) => {
  const autoImports = recentImports.filter(i => i.type === 'auto');
  const fileImports = recentImports.filter(i => i.type === 'file');
  
  const totalTickets = autoImports.reduce((sum, i) => sum + (i.metadata?.ticketsCount || 0), 0);
  const totalChunks = autoImports.reduce((sum, i) => sum + (i.metadata?.chunksCount || 0), 0);
  
  res.json({
    totalImports: recentImports.length,
    autoImports: autoImports.length,
    fileImports: fileImports.length,
    totalTicketsImported: totalTickets,
    totalChunksCreated: totalChunks,
    lastImport: recentImports[recentImports.length - 1] || null
  });
});
```

### **Option 2: Create HTML Stats Dashboard**
Create a `dashboard.html` file that displays:
- 📊 Total imports this week
- 📦 Total vectors in Pinecone
- ⏱️ Last import time
- 🎫 Total tickets imported
- ⚠️ Duplicate import attempts blocked

---

## **Summary: Where to Check Stats**

| Location | What You See | How to Access |
|----------|-------------|---------------|
| **Navbar Modal** | ✅ Success message + counts | Click "Import Tickets" button |
| **Backend Console** | 🔍 Detailed logs | `node server.js` logs |
| **API Endpoint** | 📋 Recent imports list | `curl /recent-imports` |
| **Pinecone Stats** | 📊 Vector count & index health | `curl /index-stats` |
| **Debug Search** | 🔎 Test imported data | `curl /debug-search` |
| **Zendesk Admin** | 🎯 Custom events (future) | Insights → Custom Reports |

---

## **Next Steps**

Would you like me to:
1. ✅ Add a `/import-stats` endpoint for comprehensive statistics?
2. ✅ Create a simple HTML dashboard to visualize import stats?
3. ✅ Set up Zendesk API integration to log events to Zendesk itself?
4. ✅ Add export functionality (CSV/PDF) for import reports?

**Let me know which you prefer!**
