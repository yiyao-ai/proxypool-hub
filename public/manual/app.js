const I18N = {
    en: {
        pageTitleText: 'Quick Manual',
        brandEyebrow: 'CliGate',
        brandTitle: 'Quick Manual',
        topbarNote: 'Language and theme follow the main dashboard.',
        dashboard: 'Dashboard',
        manual: 'Manual',
        resources: 'Resources',
        pageEyebrow: 'Start Here',
        pageTitle: 'Understand, configure, and verify CliGate quickly',
        pageSubtle: 'This is the in-product quick manual. For full reference, use the complete product manuals.',
        back: 'Back to Dashboard',
        heroWhatLabel: 'What it is',
        heroWhatTitle: 'One local gateway for coding tools and runtime workflows',
        heroWhatText: 'CliGate connects Claude Code, Codex CLI, Gemini CLI, OpenClaw, dashboard chat, local runtimes, and channel workflows through one local control plane.',
        heroAddressLabel: 'Default address',
        heroAddressText: 'Start the service, open the dashboard, add one usable credential, and then configure the client you want to proxy.',
        quickstartLabel: 'Quick Start',
        quickstartTitle: 'Three-step setup',
        quickstartItems: [
            'Run `npx cligate@latest start` or `cligate start`.',
            'Add a ChatGPT account, Claude account, Antigravity account, API key, or local runtime.',
            'Use the dashboard to configure Claude Code, Codex CLI, Gemini CLI, or OpenClaw.'
        ],
        areasLabel: 'Core Areas',
        areasTitle: 'Where to go in the dashboard',
        areasItems: [
            '`Accounts / API Keys`: add credentials and check availability.',
            '`Routing / Settings`: set priority, app bindings, model mapping, and CLI config.',
            '`Chat / Assistant Tasks`: test prompts and inspect runtime execution.',
            '`Channels / Conversation Records`: operate Telegram or Feishu runtime workflows.',
            '`Usage / Logs / API Explorer`: verify behavior and debug issues.'
        ],
        configLabel: 'CLI Examples',
        configTitle: 'Common tool configuration',
        configCode: `Claude Code
ANTHROPIC_BASE_URL=http://localhost:8081
ANTHROPIC_API_KEY=any-key

Codex CLI
chatgpt_base_url = "http://localhost:8081/backend-api/"
openai_base_url = "http://localhost:8081"`,
        routingLabel: 'Routing Model',
        routingTitle: 'How requests are resolved',
        routingText: 'CliGate can route through account pools, API keys, or local runtimes. You can keep automatic routing or bind specific apps to specific credentials.',
        verifyLabel: 'Verify',
        verifyTitle: 'How to confirm it works',
        verifyItems: [
            'Open `Accounts`, `API Keys`, or `Local Models` and confirm at least one source is usable.',
            'Send a test request from `Chat` and confirm the response arrives.',
            'Use `Request Logs` or `Usage` to verify which source and model handled the request.'
        ],
        nextLabel: 'Need More Detail',
        nextTitle: 'Full documentation',
        nextText: 'Use the complete product manuals when you need setup details, route behavior, architecture, or operational notes.',
        docsHub: 'Documentation Hub',
        manualEn: 'Product Manual (EN)',
        manualZh: 'Product Manual (ZH)',
        apiRef: 'API Reference',
        architecture: 'Architecture'
    },
    zh: {
        pageTitleText: '快速手册',
        brandEyebrow: 'CliGate',
        brandTitle: '快速手册',
        topbarNote: '语言和主题跟随主仪表盘设置。',
        dashboard: '仪表盘',
        manual: '手册',
        resources: '资源目录',
        pageEyebrow: '从这里开始',
        pageTitle: '快速理解、配置并验证 CliGate',
        pageSubtle: '这是产品内快速手册。完整说明请查看正式产品说明书。',
        back: '返回仪表盘',
        heroWhatLabel: '它是什么',
        heroWhatTitle: '一个面向编码工具与运行时工作流的本地网关',
        heroWhatText: 'CliGate 把 Claude Code、Codex CLI、Gemini CLI、OpenClaw、网页聊天、本地运行时和频道工作流统一到一个本地控制平面里。',
        heroAddressLabel: '默认地址',
        heroAddressText: '启动服务，打开仪表盘，添加一个可用凭据，然后配置你要接入代理的客户端。',
        quickstartLabel: '快速开始',
        quickstartTitle: '三步完成初始配置',
        quickstartItems: [
            '运行 `npx cligate@latest start` 或 `cligate start`。',
            '添加 ChatGPT 账号、Claude 账号、Antigravity 账号、API Key 或本地模型运行时。',
            '在仪表盘中配置 Claude Code、Codex CLI、Gemini CLI 或 OpenClaw。'
        ],
        areasLabel: '核心区域',
        areasTitle: '仪表盘里该看哪里',
        areasItems: [
            '`账户 / API 密钥`：添加凭据并检查可用性。',
            '`路由 / 设置`：设置优先级、应用绑定、模型映射和 CLI 配置。',
            '`聊天 / Assistant Tasks`：测试请求并查看运行时执行情况。',
            '`频道 / 会话记录`：管理 Telegram 或飞书等运行时工作流。',
            '`用量 / 日志 / API Explorer`：验证行为并排查问题。'
        ],
        configLabel: 'CLI 示例',
        configTitle: '常见工具配置',
        configCode: `Claude Code
ANTHROPIC_BASE_URL=http://localhost:8081
ANTHROPIC_API_KEY=any-key

Codex CLI
chatgpt_base_url = "http://localhost:8081/backend-api/"
openai_base_url = "http://localhost:8081"`,
        routingLabel: '路由模型',
        routingTitle: '请求如何被解析',
        routingText: 'CliGate 可以通过账号池、API Key 或本地运行时进行路由。你可以保留自动路由，也可以把特定应用绑定到特定凭据。',
        verifyLabel: '验证',
        verifyTitle: '如何确认已经生效',
        verifyItems: [
            '打开 `账户`、`API 密钥` 或 `本地模型`，确认至少有一个来源可用。',
            '在 `聊天` 页面发送一次测试请求，确认能正常返回响应。',
            '在 `请求日志` 或 `用量` 页面确认实际命中了哪个来源和模型。'
        ],
        nextLabel: '需要更多细节',
        nextTitle: '完整文档',
        nextText: '当你需要更完整的配置步骤、路由行为、架构说明或运维说明时，请查看完整产品说明书。',
        docsHub: '文档总览',
        manualEn: '产品说明书（英文）',
        manualZh: '产品说明书（中文）',
        apiRef: 'API 参考',
        architecture: '架构说明'
    }
};

const state = {
    lang: localStorage.getItem('proxy-lang') || 'en',
    darkMode: localStorage.getItem('proxy-theme') !== 'light'
};

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

function applyTheme() {
    document.documentElement.classList.toggle('light', !state.darkMode);
    document.documentElement.classList.toggle('dark', state.darkMode);
}

function renderList(id, items) {
    const node = document.getElementById(id);
    if (!node) return;
    node.innerHTML = (items || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
}

function applyI18n() {
    const lang = state.lang === 'zh' || state.lang === 'zh-CN' ? 'zh' : 'en';
    document.documentElement.lang = lang === 'zh' ? 'zh' : 'en';
    document.title = `CliGate ${t('pageTitleText')}`;

    const mappings = {
        'brand-eyebrow': 'brandEyebrow',
        'brand-title': 'brandTitle',
        'topbar-note': 'topbarNote',
        'nav-dashboard': 'dashboard',
        'nav-manual': 'manual',
        'nav-resources': 'resources',
        'page-eyebrow': 'pageEyebrow',
        'page-title': 'pageTitle',
        'page-subtle': 'pageSubtle',
        'back-link': 'back',
        'hero-what-label': 'heroWhatLabel',
        'hero-what-title': 'heroWhatTitle',
        'hero-what-text': 'heroWhatText',
        'hero-address-label': 'heroAddressLabel',
        'hero-address-text': 'heroAddressText',
        'card-quickstart-label': 'quickstartLabel',
        'card-quickstart-title': 'quickstartTitle',
        'card-areas-label': 'areasLabel',
        'card-areas-title': 'areasTitle',
        'card-config-label': 'configLabel',
        'card-config-title': 'configTitle',
        'card-routing-label': 'routingLabel',
        'card-routing-title': 'routingTitle',
        'card-routing-text': 'routingText',
        'card-verify-label': 'verifyLabel',
        'card-verify-title': 'verifyTitle',
        'card-next-label': 'nextLabel',
        'card-next-title': 'nextTitle',
        'card-next-text': 'nextText',
        'link-docs': 'docsHub',
        'link-manual-en': 'manualEn',
        'link-manual-zh': 'manualZh',
        'link-api': 'apiRef',
        'link-arch': 'architecture'
    };

    Object.entries(mappings).forEach(([id, key]) => {
        const node = document.getElementById(id);
        if (node) node.textContent = t(key);
    });

    const code = document.getElementById('config-code');
    if (code) code.textContent = t('configCode');

    renderList('quickstart-list', t('quickstartItems'));
    renderList('areas-list', t('areasItems'));
    renderList('verify-list', t('verifyItems'));
}

function bindChrome() {
    window.addEventListener('storage', (event) => {
        if (event.key === 'proxy-lang') {
            state.lang = localStorage.getItem('proxy-lang') || 'en';
            applyI18n();
        }
        if (event.key === 'proxy-theme') {
            state.darkMode = localStorage.getItem('proxy-theme') !== 'light';
            applyTheme();
        }
    });
}

function main() {
    state.lang = localStorage.getItem('proxy-lang') || 'en';
    state.darkMode = localStorage.getItem('proxy-theme') !== 'light';
    bindChrome();
    applyTheme();
    applyI18n();
}

main();
