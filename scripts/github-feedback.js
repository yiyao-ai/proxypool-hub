#!/usr/bin/env node
/**
 * GitHub Feedback Collector
 * Fetches issues, discussions, and stargazer stats from the repo.
 *
 * Usage:
 *   node scripts/github-feedback.js                    # overview
 *   node scripts/github-feedback.js issues             # list open issues
 *   node scripts/github-feedback.js issues --label bug  # filter by label
 *   node scripts/github-feedback.js features            # feature requests only
 *   node scripts/github-feedback.js bugs                # bugs only
 *   node scripts/github-feedback.js stars               # stargazer stats
 *   node scripts/github-feedback.js summary             # AI-friendly summary
 *
 * Environment:
 *   GITHUB_TOKEN — optional, increases rate limit from 60 to 5000 req/hr
 */

const REPO = 'yiyao-ai/proxypool-hub';
const API = 'https://api.github.com';

async function ghFetch(path, params = {}) {
    const url = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) url.searchParams.set(k, v);
    }

    const headers = {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'proxypool-hub-feedback'
    };
    if (process.env.GITHUB_TOKEN) {
        headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    const res = await fetch(url.toString(), { headers });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`GitHub API ${res.status}: ${text}`);
    }
    return res.json();
}

// ─── Commands ───────────────────────────────────────────────────────────────

async function overview() {
    const [repo, issues, bugs, features] = await Promise.all([
        ghFetch(`/repos/${REPO}`),
        ghFetch(`/repos/${REPO}/issues`, { state: 'open', per_page: 100 }),
        ghFetch(`/repos/${REPO}/issues`, { state: 'open', labels: 'bug', per_page: 100 }),
        ghFetch(`/repos/${REPO}/issues`, { state: 'open', labels: 'enhancement', per_page: 100 })
    ]);

    const questions = issues.filter(i => i.labels.some(l => l.name === 'question'));

    console.log('');
    console.log('=== ProxyPool Hub - Feedback Overview ===');
    console.log('');
    console.log(`  Stars:           ${repo.stargazers_count}`);
    console.log(`  Forks:           ${repo.forks_count}`);
    console.log(`  Watchers:        ${repo.subscribers_count}`);
    console.log(`  Open Issues:     ${repo.open_issues_count}`);
    console.log('');
    console.log(`  Bugs:            ${bugs.length}`);
    console.log(`  Feature Requests: ${features.length}`);
    console.log(`  Questions:       ${questions.length}`);
    console.log('');

    if (issues.length > 0) {
        console.log('--- Latest Issues ---');
        for (const issue of issues.slice(0, 10)) {
            const labels = issue.labels.map(l => l.name).join(', ');
            const date = issue.created_at.slice(0, 10);
            console.log(`  #${issue.number} [${labels || 'none'}] ${issue.title}`);
            console.log(`     ${date} by @${issue.user.login} | ${issue.comments} comments`);
        }
    } else {
        console.log('  No open issues yet.');
    }
    console.log('');
}

async function listIssues(label) {
    const params = { state: 'open', per_page: 100, sort: 'created', direction: 'desc' };
    if (label) params.labels = label;

    const issues = await ghFetch(`/repos/${REPO}/issues`, params);
    // Filter out pull requests
    const filtered = issues.filter(i => !i.pull_request);

    if (filtered.length === 0) {
        console.log(label ? `No open issues with label "${label}".` : 'No open issues.');
        return;
    }

    console.log(`\n=== Open Issues${label ? ` [${label}]` : ''} (${filtered.length}) ===\n`);
    for (const issue of filtered) {
        const labels = issue.labels.map(l => l.name).join(', ');
        const date = issue.created_at.slice(0, 10);
        const reactions = issue.reactions?.total_count || 0;
        console.log(`#${issue.number} | ${date} | @${issue.user.login} | ${reactions} reactions | ${issue.comments} comments`);
        console.log(`  [${labels}] ${issue.title}`);
        if (issue.body) {
            const preview = issue.body.replace(/\r?\n/g, ' ').slice(0, 120);
            console.log(`  ${preview}${issue.body.length > 120 ? '...' : ''}`);
        }
        console.log('');
    }
}

async function starStats() {
    const repo = await ghFetch(`/repos/${REPO}`);
    const stargazers = await ghFetch(`/repos/${REPO}/stargazers`, {
        per_page: 100,
    });

    console.log(`\n=== Stargazer Stats ===\n`);
    console.log(`  Total Stars: ${repo.stargazers_count}`);
    console.log(`  Total Forks: ${repo.forks_count}`);
    console.log('');

    if (stargazers.length > 0) {
        console.log('--- Recent Stargazers ---');
        for (const user of stargazers.slice(-20).reverse()) {
            console.log(`  @${user.login}`);
        }
    }
    console.log('');
}

async function summary() {
    const [repo, issues] = await Promise.all([
        ghFetch(`/repos/${REPO}`),
        ghFetch(`/repos/${REPO}/issues`, { state: 'open', per_page: 100 })
    ]);

    const filtered = issues.filter(i => !i.pull_request);
    const bugs = filtered.filter(i => i.labels.some(l => l.name === 'bug'));
    const features = filtered.filter(i => i.labels.some(l => l.name === 'enhancement'));
    const questions = filtered.filter(i => i.labels.some(l => l.name === 'question'));

    const lines = [
        `# ProxyPool Hub Feedback Summary`,
        ``,
        `Stars: ${repo.stargazers_count} | Forks: ${repo.forks_count} | Open: ${filtered.length}`,
        `Bugs: ${bugs.length} | Features: ${features.length} | Questions: ${questions.length}`,
        ``
    ];

    if (bugs.length > 0) {
        lines.push('## Bugs');
        for (const b of bugs) {
            lines.push(`- #${b.number}: ${b.title} (${b.comments} comments, ${b.reactions?.total_count || 0} reactions)`);
        }
        lines.push('');
    }

    if (features.length > 0) {
        lines.push('## Feature Requests');
        for (const f of features) {
            lines.push(`- #${f.number}: ${f.title} (${f.comments} comments, ${f.reactions?.total_count || 0} reactions)`);
        }
        lines.push('');
    }

    if (questions.length > 0) {
        lines.push('## Questions');
        for (const q of questions) {
            lines.push(`- #${q.number}: ${q.title}`);
        }
        lines.push('');
    }

    // Top voted (by reactions)
    const topVoted = [...filtered].sort((a, b) => (b.reactions?.total_count || 0) - (a.reactions?.total_count || 0)).slice(0, 5);
    if (topVoted.length > 0 && topVoted[0].reactions?.total_count > 0) {
        lines.push('## Most Voted');
        for (const t of topVoted) {
            if ((t.reactions?.total_count || 0) === 0) break;
            lines.push(`- #${t.number}: ${t.title} (+${t.reactions.total_count})`);
        }
        lines.push('');
    }

    console.log(lines.join('\n'));
}

// ─── Main ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0] || 'overview';
const labelFlag = args.indexOf('--label');
const label = labelFlag >= 0 ? args[labelFlag + 1] : undefined;

(async () => {
    try {
        switch (command) {
            case 'overview':
                await overview();
                break;
            case 'issues':
                await listIssues(label);
                break;
            case 'bugs':
                await listIssues('bug');
                break;
            case 'features':
                await listIssues('enhancement');
                break;
            case 'stars':
                await starStats();
                break;
            case 'summary':
                await summary();
                break;
            default:
                console.log('Usage: node scripts/github-feedback.js [overview|issues|bugs|features|stars|summary]');
                console.log('  --label <name>   Filter issues by label');
        }
    } catch (err) {
        console.error('Error:', err.message);
        if (err.message.includes('403')) {
            console.error('Tip: Set GITHUB_TOKEN env var to increase rate limit.');
        }
        process.exit(1);
    }
})();
