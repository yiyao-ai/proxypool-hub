import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const MANUAL_FILES = {
  'zh-CN': join(process.cwd(), 'docs', 'product-manual.zh-CN.md'),
  en: join(process.cwd(), 'docs', 'product-manual.en.md')
};

const cache = new Map();

function getManualPath(language) {
  return MANUAL_FILES[language] || MANUAL_FILES.en;
}

function loadManual(language) {
  const normalizedLanguage = language === 'zh' ? 'zh-CN' : language;
  const filePath = getManualPath(normalizedLanguage);

  if (!existsSync(filePath)) {
    return {
      language: normalizedLanguage,
      filePath,
      title: normalizedLanguage === 'zh-CN' ? '产品使用说明书' : 'Product Manual',
      content: '',
      sections: []
    };
  }

  const stats = statSync(filePath);
  const cached = cache.get(normalizedLanguage);
  if (cached && cached.mtimeMs === stats.mtimeMs) {
    return cached.value;
  }

  const content = readFileSync(filePath, 'utf8');
  const value = {
    language: normalizedLanguage,
    filePath,
    title: normalizedLanguage === 'zh-CN' ? '产品使用说明书' : 'Product Manual',
    content,
    sections: splitSections(content)
  };

  cache.set(normalizedLanguage, {
    mtimeMs: stats.mtimeMs,
    value
  });

  return value;
}

export function getManualDocument(language = 'en') {
  return loadManual(language);
}

function splitSections(content) {
  const lines = String(content || '').split(/\r?\n/);
  const sections = [];
  let current = null;
  let currentPath = [];

  for (const line of lines) {
    const headingMatch = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (headingMatch) {
      if (current && current.lines.length > 0) {
        sections.push(finalizeSection(current));
      }

      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();
      currentPath = [...currentPath.slice(0, level - 1), title];
      current = {
        title,
        level,
        titlePath: [...currentPath],
        lines: []
      };
      continue;
    }

    if (!current) {
      current = {
        title: 'Overview',
        level: 1,
        titlePath: ['Overview'],
        lines: []
      };
      currentPath = ['Overview'];
    }

    current.lines.push(line);
  }

  if (current && current.lines.length > 0) {
    sections.push(finalizeSection(current));
  }

  return sections.filter((section) => section.content);
}

function finalizeSection(section) {
  const content = section.lines.join('\n').trim();
  return {
    id: section.titlePath.join(' > ').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-'),
    title: section.title,
    titlePath: section.titlePath,
    content
  };
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function scoreSection(section, queryTokens) {
  if (queryTokens.length === 0) return 0;

  const titleText = section.titlePath.join(' ').toLowerCase();
  const bodyText = section.content.toLowerCase();
  let score = 0;

  for (const token of queryTokens) {
    if (titleText.includes(token)) score += 5;
    if (bodyText.includes(token)) score += 2;
  }

  return score;
}

function getFallbackSections(sections, language) {
  const preferredTitles = language === 'zh-CN'
    ? ['简介', '快速开始', 'Claude Code', '使用']
    : ['Overview', 'Quick Start', 'Claude Code', 'Usage'];

  const ranked = sections
    .map((section) => ({
      section,
      score: preferredTitles.reduce((total, keyword) => {
        const titleText = section.titlePath.join(' ');
        return total + (titleText.includes(keyword) ? 3 : 0);
      }, 0)
    }))
    .sort((left, right) => right.score - left.score);

  return ranked
    .map((item) => item.section)
    .filter((section) => section.content)
    .slice(0, 3);
}

export function getManualContext({ language = 'en', query = '' } = {}) {
  const manual = loadManual(language);
  const queryTokens = tokenize(query);

  let selectedSections = manual.sections
    .map((section) => ({
      section,
      score: scoreSection(section, queryTokens)
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((item) => item.section)
    .slice(0, 4);

  if (selectedSections.length === 0) {
    selectedSections = getFallbackSections(manual.sections, manual.language);
  }

  const contextText = selectedSections.length > 0
    ? selectedSections
        .map((section) => `## ${section.titlePath.join(' > ')}\n${section.content}`)
        .join('\n\n')
    : manual.content;

  return {
    language: manual.language,
    filePath: manual.filePath,
    title: manual.title,
    contextText,
    citations: selectedSections.map((section) => ({
      id: section.id,
      title: section.title,
      titlePath: section.titlePath
    }))
  };
}

export default {
  getManualContext,
  getManualDocument
};
