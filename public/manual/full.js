const I18N = {
    en: {
        pageTitleText: 'Full Manual',
        brandTitle: 'Full Manual',
        topbarNote: 'Language and theme follow the main dashboard.',
        dashboard: 'Dashboard',
        manual: 'Manual',
        resources: 'Resources',
        pageEyebrow: 'Reference',
        pageTitle: 'Complete product manual',
        pageSubtle: 'This page renders the built-in product manual locally so it remains available without GitHub.',
        back: 'Back to Quick Manual',
        docOptionManual: 'Product Manual',
        docOptionReadme: 'Documentation Hub',
        docOptionApi: 'API Reference',
        docOptionArch: 'Architecture',
        tocLabel: 'Contents',
        docLabel: 'Document',
        currentDocLabel: 'Current file',
        copySectionLink: 'Copy section link',
        backToTop: 'Top',
        copySuccess: 'Section link copied',
        requestFailed: 'Failed to load manual'
    },
    zh: {
        pageTitleText: '完整手册',
        brandTitle: '完整手册',
        topbarNote: '语言和主题跟随主仪表盘设置。',
        dashboard: '仪表盘',
        manual: '手册',
        resources: '资源目录',
        pageEyebrow: '参考',
        pageTitle: '完整产品说明书',
        pageSubtle: '此页面在本地渲染内置说明书，因此即使不访问 GitHub 也可以直接阅读。',
        back: '返回快速手册',
        docOptionManual: '产品说明书',
        docOptionReadme: '文档总览',
        docOptionApi: 'API 参考',
        docOptionArch: '架构说明',
        tocLabel: '目录',
        docLabel: '文档',
        currentDocLabel: '当前文件',
        copySectionLink: '复制章节链接',
        backToTop: '顶部',
        copySuccess: '章节链接已复制',
        requestFailed: '加载手册失败'
    }
};

const state = {
    lang: localStorage.getItem('proxy-lang') || 'en',
    darkMode: localStorage.getItem('proxy-theme') !== 'light'
};

function resolvePreferredLang() {
    const urlLang = new URLSearchParams(window.location.search).get('lang');
    return urlLang || localStorage.getItem('proxy-lang') || 'en';
}

function resolvePreferredDoc() {
    return new URLSearchParams(window.location.search).get('doc') || '';
}

function t(key) {
    const lang = state.lang === 'zh' || state.lang === 'zh-CN' ? 'zh' : 'en';
    const dict = I18N[lang] || I18N.en;
    return dict[key] ?? I18N.en[key] ?? key;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function slugify(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-')
        .replace(/^-+|-+$/g, '');
}

function resolveDocHref(href) {
    const raw = String(href || '').trim();
    if (!raw) return '#';
    if (/^(https?:|mailto:|#)/i.test(raw)) return raw;

    const normalized = raw.replace(/^\.\//, '');
    if (normalized === 'product-manual.en.md') {
        return '/manual/full.html?lang=en';
    }
    if (normalized === 'product-manual.zh-CN.md') {
        return '/manual/full.html?lang=zh-CN';
    }
    if (/\.md$/i.test(normalized)) {
        return `/manual/full.html?doc=${encodeURIComponent(normalized)}`;
    }
    return raw;
}

function formatInline(text) {
    let html = escapeHtml(text);
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => {
        const resolved = resolveDocHref(href);
        const external = /^(https?:|mailto:)/i.test(resolved);
        return `<a href="${escapeHtml(resolved)}"${external ? ' target="_blank" rel="noreferrer"' : ''}>${escapeHtml(label)}</a>`;
    });
    return html;
}

function applyTheme() {
    document.documentElement.classList.toggle('light', !state.darkMode);
    document.documentElement.classList.toggle('dark', state.darkMode);
}

function markdownToHtml(markdown) {
    const lines = String(markdown || '').split(/\r?\n/);
    const out = [];
    const toc = [];
    let inList = false;
    let inCode = false;
    let codeBuffer = [];
    let paragraph = [];
    let tableRows = [];

    function flushParagraph() {
        if (!paragraph.length) return;
        out.push(`<p>${formatInline(paragraph.join(' '))}</p>`);
        paragraph = [];
    }

    function flushList() {
        if (!inList) return;
        out.push('</ul>');
        inList = false;
    }

    function flushCode() {
        if (!inCode) return;
        out.push(`<pre><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`);
        inCode = false;
        codeBuffer = [];
    }

    function flushTable() {
        if (!tableRows.length) return;
        const rows = [...tableRows];
        tableRows = [];
        if (rows.length < 2) return;
        const header = rows[0];
        const body = rows.slice(2);
        out.push('<table>');
        out.push('<thead><tr>' + header.map((cell) => `<th>${formatInline(cell)}</th>`).join('') + '</tr></thead>');
        if (body.length > 0) {
            out.push('<tbody>');
            for (const row of body) {
                out.push('<tr>' + row.map((cell) => `<td>${formatInline(cell)}</td>`).join('') + '</tr>');
            }
            out.push('</tbody>');
        }
        out.push('</table>');
    }

    for (const rawLine of lines) {
        const line = rawLine ?? '';

        if (line.trim().startsWith('```')) {
            flushParagraph();
            flushList();
            flushTable();
            if (inCode) {
                flushCode();
            } else {
                inCode = true;
                codeBuffer = [];
            }
            continue;
        }

        if (inCode) {
            codeBuffer.push(line);
            continue;
        }

        if (/^\s*---+\s*$/.test(line) || /^\s*\*\*\*+\s*$/.test(line)) {
            flushParagraph();
            flushList();
            flushTable();
            out.push('<hr>');
            continue;
        }

        const heading = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
        if (heading) {
            flushParagraph();
            flushList();
            flushTable();
            const level = Math.min(4, heading[1].length + 1);
            const id = slugify(heading[2]);
            toc.push({ id, title: heading[2], level: heading[1].length });
            out.push(`<h${level} id="${escapeHtml(id)}">${escapeHtml(heading[2])}</h${level}>`);
            continue;
        }

        const quote = /^\s*>\s?(.*)\s*$/.exec(line);
        if (quote) {
            flushParagraph();
            flushList();
            flushTable();
            out.push(`<blockquote>${formatInline(quote[1])}</blockquote>`);
            continue;
        }

        if (line.includes('|')) {
            const trimmed = line.trim();
            const cells = trimmed.split('|').slice(1, -1).map((cell) => cell.trim());
            const isDivider = cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
            if (cells.length > 0) {
                flushParagraph();
                flushList();
                tableRows.push(cells);
                if (isDivider) {
                    continue;
                }
                continue;
            }
        } else if (tableRows.length > 0) {
            flushTable();
        }

        const listItem = /^\s*-\s+(.+?)\s*$/.exec(line) || /^\s*\d+\.\s+(.+?)\s*$/.exec(line);
        if (listItem) {
            flushParagraph();
            flushTable();
            if (!inList) {
                out.push('<ul>');
                inList = true;
            }
            out.push(`<li>${formatInline(listItem[1])}</li>`);
            continue;
        }

        if (!line.trim()) {
            flushParagraph();
            flushList();
            flushTable();
            continue;
        }

        paragraph.push(line.trim());
    }

    flushParagraph();
    flushList();
    flushCode();
    flushTable();
    return { html: out.join('\n'), toc };
}

function applyI18nChrome() {
    const lang = state.lang === 'zh' || state.lang === 'zh-CN' ? 'zh' : 'en';
    document.documentElement.lang = lang === 'zh' ? 'zh' : 'en';
    document.title = `CliGate ${t('pageTitleText')}`;

    const mappings = {
        'brand-eyebrow': 'manual',
        'brand-title': 'brandTitle',
        'topbar-note': 'topbarNote',
        'nav-dashboard': 'dashboard',
        'nav-manual': 'manual',
        'nav-resources': 'resources',
        'page-eyebrow': 'pageEyebrow',
        'page-title': 'pageTitle',
        'page-subtle': 'pageSubtle',
        'back-link': 'back',
        'toc-label': 'tocLabel',
        'doc-label': 'docLabel',
        'copy-section-link': 'copySectionLink',
        'back-to-top': 'backToTop'
    };

    Object.entries(mappings).forEach(([id, key]) => {
        const node = document.getElementById(id);
        if (node) node.textContent = t(key);
    });

    const docSwitcher = document.getElementById('doc-switcher');
    if (docSwitcher) {
        const selected = resolvePreferredDoc();
        docSwitcher.innerHTML = `
            <option value="">${escapeHtml(t('docOptionManual'))}</option>
            <option value="README.md">${escapeHtml(t('docOptionReadme'))}</option>
            <option value="API.md">${escapeHtml(t('docOptionApi'))}</option>
            <option value="ARCHITECTURE.md">${escapeHtml(t('docOptionArch'))}</option>
        `;
        docSwitcher.value = selected;
    }
}

async function loadManual() {
    const lang = state.lang === 'zh' || state.lang === 'zh-CN' ? 'zh-CN' : 'en';
    const docName = resolvePreferredDoc();
    const endpoint = docName
        ? `/api/manual/doc-file?name=${encodeURIComponent(docName)}`
        : `/api/manual/document?lang=${encodeURIComponent(lang)}`;
    const response = await fetch(endpoint);
    const data = await response.json();
    const payload = data?.manual || data?.document;
    if (!response.ok || !payload) {
        throw new Error(data?.error || t('requestFailed'));
    }

    document.getElementById('doc-meta').textContent = payload.title || '';
    const rendered = markdownToHtml(payload.content || '');
    document.getElementById('manual-doc').innerHTML = rendered.html;
    renderToc(rendered.toc);
    bindTocSpy();
}

function renderToc(items) {
    const node = document.getElementById('manual-toc');
    if (!node) return;
    node.innerHTML = (items || [])
        .map((item) => `
            <a class="manual-toc-link level-${Math.min(item.level, 3)}"
               data-target="${escapeHtml(item.id)}"
               href="#${escapeHtml(item.id)}">${escapeHtml(item.title)}</a>
        `)
        .join('');
}

function bindTocSpy() {
    const links = [...document.querySelectorAll('.manual-toc-link')];
    const headings = [...document.querySelectorAll('.manual-doc-body h2, .manual-doc-body h3, .manual-doc-body h4')];
    if (!links.length || !headings.length) return;

    function refresh() {
        let currentId = headings[0]?.id || '';
        const offset = window.scrollY + 120;
        for (const heading of headings) {
            if (heading.offsetTop <= offset) currentId = heading.id;
        }
        links.forEach((link) => {
            link.classList.toggle('active', link.getAttribute('data-target') === currentId);
        });
    }

    refresh();
    window.addEventListener('scroll', refresh, { passive: true });
}

function bindChrome() {
    window.addEventListener('storage', async (event) => {
        if (event.key === 'proxy-lang') {
            state.lang = localStorage.getItem('proxy-lang') || 'en';
            applyI18nChrome();
            await loadManual().catch(showError);
        }
        if (event.key === 'proxy-theme') {
            state.darkMode = localStorage.getItem('proxy-theme') !== 'light';
            applyTheme();
        }
    });
}

function bindLanguageSwitch() {
    const enBtn = document.getElementById('lang-en');
    const zhBtn = document.getElementById('lang-zh');
    if (!enBtn || !zhBtn) return;

    function refreshActive() {
        const isZh = state.lang === 'zh' || state.lang === 'zh-CN';
        enBtn.classList.toggle('active', !isZh);
        zhBtn.classList.toggle('active', isZh);
    }

    enBtn.addEventListener('click', async () => {
        state.lang = 'en';
        localStorage.setItem('proxy-lang', 'en');
        const docName = resolvePreferredDoc();
        const query = docName ? `?lang=en&doc=${encodeURIComponent(docName)}` : '?lang=en';
        history.replaceState(null, '', `${window.location.pathname}${query}`);
        applyI18nChrome();
        refreshActive();
        await loadManual().catch(showError);
    });

    zhBtn.addEventListener('click', async () => {
        state.lang = 'zh-CN';
        localStorage.setItem('proxy-lang', 'zh-CN');
        const docName = resolvePreferredDoc();
        const query = docName ? `?lang=zh-CN&doc=${encodeURIComponent(docName)}` : '?lang=zh-CN';
        history.replaceState(null, '', `${window.location.pathname}${query}`);
        applyI18nChrome();
        refreshActive();
        await loadManual().catch(showError);
    });

    refreshActive();
}

function bindDocSwitcher() {
    const select = document.getElementById('doc-switcher');
    if (!select) return;

    select.addEventListener('change', async (event) => {
        const docName = event.target.value || '';
        const lang = state.lang === 'zh' || state.lang === 'zh-CN' ? 'zh-CN' : 'en';
        const query = docName
            ? `?lang=${encodeURIComponent(lang)}&doc=${encodeURIComponent(docName)}`
            : `?lang=${encodeURIComponent(lang)}`;
        history.replaceState(null, '', `${window.location.pathname}${query}`);
        await loadManual().catch(showError);
    });
}

function bindDocActions() {
    const copyBtn = document.getElementById('copy-section-link');
    if (!copyBtn) return;

    copyBtn.addEventListener('click', async () => {
        const active = document.querySelector('.manual-toc-link.active');
        const target = active?.getAttribute('data-target') || '';
        const url = new URL(window.location.href);
        url.hash = target ? `#${target}` : '';
        try {
            await navigator.clipboard.writeText(url.toString());
            copyBtn.textContent = t('copySuccess');
            window.setTimeout(() => {
                copyBtn.textContent = t('copySectionLink');
            }, 1200);
        } catch {
            copyBtn.textContent = t('copySuccess');
            window.setTimeout(() => {
                copyBtn.textContent = t('copySectionLink');
            }, 1200);
        }
    });
}

function showError(error) {
    document.getElementById('manual-doc').innerHTML = `<p>${escapeHtml(error?.message || t('requestFailed'))}</p>`;
}

async function main() {
    state.lang = resolvePreferredLang();
    state.darkMode = localStorage.getItem('proxy-theme') !== 'light';
    bindChrome();
    bindLanguageSwitch();
    bindDocSwitcher();
    bindDocActions();
    applyTheme();
    applyI18nChrome();
    await loadManual().catch(showError);
}

main();
