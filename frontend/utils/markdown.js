/**
 * Lightweight Markdown Parser for WeChat Mini Program
 * Supports:
 * - Bold (**text**)
 * - List (- item, 1. item)
 * - Table (standard markdown table)
 * - Headers (#, ##, ###)
 */

function parseMarkdown(text) {
  if (!text) return [];

  const lines = text.split('\n');
  const result = [];
  let currentList = null;
  let currentTable = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();

    // 1. Handle Tables
    // Start condition: Line contains pipes AND next line is a separator line (---)
    const hasPipe = trimmedLine.includes('|');
    if (hasPipe) {
      // Check if next line is separator (e.g., "---|---" or "|---|")
      const nextLine = (i + 1 < lines.length) ? lines[i + 1].trim() : '';
      const isHeader = !currentTable &&
        (nextLine.startsWith('|') || nextLine.startsWith('-')) &&
        nextLine.includes('-');

      const isBodyRow = currentTable && hasPipe;

      if (isHeader) {
        currentTable = {
          type: 'table',
          header: parseTableRow(line),
          rows: []
        };
        // Skip the separator row
        i++;
        continue;
      } else if (isBodyRow) {
        currentTable.rows.push(parseTableRow(line));
        continue;
      }
    }

    // If not a table row, but we were in a table, close it
    if (currentTable) {
      result.push(currentTable);
      currentTable = null;
    }

    // 2. Handle Lists
    // Supports: "- ", "* ", "1. ", "1. ", "1、" (Chinese markers)
    const listMatch = line.match(/^(\s*)([-*]|\d+[\.\．、])\s+(.+)/);
    if (listMatch) {
      if (currentTable) { result.push(currentTable); currentTable = null; }

      const indent = listMatch[1].length;
      const marker = listMatch[2];
      // Ordered if it contains dot or comma
      const type = (marker.includes('.') || marker.includes('．') || marker.includes('、')) ? 'ordered' : 'unordered';
      const content = parseInline(listMatch[3]);

      if (!currentList || currentList.type !== 'list') {
        if (currentList) result.push(currentList);
        currentList = {
          type: 'list',
          items: []
        };
      }

      currentList.items.push({
        type: type,
        indent: indent,
        content: content
      });
      continue;
    } else if (currentList) {
      result.push(currentList);
      currentList = null;
    }

    // 3. Handle Headers
    const headerMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headerMatch) {
      if (currentTable) { result.push(currentTable); currentTable = null; }

      result.push({
        type: 'header',
        level: headerMatch[1].length,
        content: parseInline(headerMatch[2])
      });
      continue;
    }

    // 4. Handle Paragraph/Text
    if (trimmedLine.length > 0) {
      result.push({
        type: 'paragraph',
        content: parseInline(line)
      });
    }
  }

  // Flush any remaining blocks
  if (currentList) result.push(currentList);
  if (currentTable) result.push(currentTable);

  return result;
}

function parseTableRow(line) {
  let content = line.trim();

  // Strip optional outer pipes if they exist
  if (content.startsWith('|')) content = content.substring(1);
  if (content.endsWith('|')) content = content.substring(0, content.length - 1);

  const cells = content.split('|');
  return cells.map(cell => parseInline(cell.trim()));
}

function parseInline(text) {
  const segments = [];
  let currentIndex = 0;

  // Bold parser: **text** OR 【text】(User preference)
  // Matching (**...**) OR (【...】)
  const regex = /(\*\*(.+?)\*\*)|(【(.+?)】)/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    // Add text before the bold match
    if (match.index > currentIndex) {
      segments.push({
        type: 'text',
        text: text.substring(currentIndex, match.index)
      });
    }

    // Add the bold text
    // match[2] is for **, match[4] is for 【】
    const boldText = match[2] || match[4];
    segments.push({
      type: 'bold',
      text: boldText
    });

    currentIndex = regex.lastIndex;
  }

  // Add remaining text
  if (currentIndex < text.length) {
    segments.push({
      type: 'text',
      text: text.substring(currentIndex)
    });
  }

  return segments;
}

module.exports = {
  parse: parseMarkdown
};
