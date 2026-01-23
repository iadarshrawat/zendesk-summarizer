import fs from "fs";

/**
 * Extract text or data from uploaded file
 * @param {string} filePath - Path to uploaded file
 * @param {string} mimetype - MIME type of file
 * @param {string} originalName - Original filename
 * @returns {Promise<{type: string, data: any}>} Extracted data
 */
export async function extractTextFromFile(filePath, mimetype, originalName) {
  console.log(`🔍 Reading file: ${filePath}`);
  
  const stats = fs.statSync(filePath);
  console.log(`📄 File size: ${stats.size} bytes`);
  
  if (stats.size > 5 * 1024 * 1024) {
    throw new Error('File too large. Maximum size is 5MB.');
  }
  
  const fileContent = fs.readFileSync(filePath, 'utf8');
  
  // Handle JSON files (ticket data)
  if (mimetype === 'application/json' || originalName.endsWith('.json')) {
    console.log(`🔄 Parsing JSON file as ticket data...`);
    try {
      const jsonData = JSON.parse(fileContent);
      console.log(`✓ JSON parsed successfully`);
      
      return { type: 'tickets', data: jsonData };
    } catch (err) {
      console.error("❌ Failed to parse JSON:", err.message);
      throw new Error(`Invalid JSON file: ${err.message}`);
    }
  }
  
  // Handle text files
  if (mimetype === 'text/plain' || mimetype === 'text/markdown' || mimetype === 'text/csv') {
    return { type: 'text', data: fileContent.slice(0, 10000) };
  }
  
  // Default to text
  return { type: 'text', data: fileContent.slice(0, 10000) };
}

/**
 * Clean up uploaded file
 * @param {string} filePath - Path to file
 */
export function cleanupFile(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      console.log(`🗑️ Cleaned up temporary file`);
    } catch (cleanupError) {
      console.error("⚠️ Failed to clean up file:", cleanupError);
    }
  }
}