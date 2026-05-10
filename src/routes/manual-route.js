import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getManualDocument } from '../assistant/manual-service.js';

const DOC_FILE_MAP = Object.freeze({
  'README.md': join(process.cwd(), 'docs', 'README.md'),
  'API.md': join(process.cwd(), 'docs', 'API.md'),
  'ARCHITECTURE.md': join(process.cwd(), 'docs', 'ARCHITECTURE.md'),
  'product-manual.en.md': join(process.cwd(), 'docs', 'product-manual.en.md'),
  'product-manual.zh-CN.md': join(process.cwd(), 'docs', 'product-manual.zh-CN.md')
});

function extractTitle(content, fallbackTitle) {
  const match = String(content || '').match(/^#\s+(.+?)\s*$/m);
  return match?.[1]?.trim() || fallbackTitle;
}

export function handleGetManualDocument(req, res) {
  try {
    const language = typeof req.query?.lang === 'string' ? req.query.lang : 'en';
    const manual = getManualDocument(language);
    return res.json({
      success: true,
      manual: {
        language: manual.language,
        title: manual.title,
        content: manual.content,
        sections: manual.sections
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

export function handleGetManualDocFile(req, res) {
  try {
    const name = typeof req.query?.name === 'string' ? req.query.name : '';
    const filePath = DOC_FILE_MAP[name];
    if (!filePath) {
      return res.status(404).json({ success: false, error: `Document not found: ${name}` });
    }
    if (!existsSync(filePath)) {
      return res.status(404).json({ success: false, error: `Document file missing: ${name}` });
    }
    const content = readFileSync(filePath, 'utf8');
    return res.json({
      success: true,
      document: {
        name,
        title: extractTitle(content, name),
        content
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

export default {
  handleGetManualDocument,
  handleGetManualDocFile
};
