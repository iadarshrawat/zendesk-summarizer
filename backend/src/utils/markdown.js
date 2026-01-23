/**
 * Clean markdown formatting from text
 * @param {string} text - Text with markdown
 * @returns {string} Cleaned text
 */
export function cleanMarkdown(text) {
  if (!text) return "";

  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")        // Bold
    .replace(/__(.*?)__/g, "$1")            // Bold (underscore)
    .replace(/\*(.*?)\*/g, "$1")            // Italic
    .replace(/_(.*?)_/g, "$1")              // Italic (underscore)
    .replace(/^#{1,6}\s+/gm, "")            // Headers
    .replace(/```[\s\S]*?```/g, "")         // Code blocks
    .replace(/`(.*?)`/g, "$1")              // Inline code
    .replace(/^\s*[-*+]\s+/gm, "")          // Unordered lists
    .replace(/^\s*(\d+)\.\s+/gm, "$1. ")    // Ordered lists
    .replace(/\n{3,}/g, "\n\n")             // Multiple newlines
    .trim();
}