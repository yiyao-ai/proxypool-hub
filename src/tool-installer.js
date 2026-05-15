/**
 * Tool Installer
 * Detects and installs CLI tools (Node.js, Claude Code, Codex CLI, Gemini CLI, OpenClaw).
 * Strategy: use official install paths first, then fall back to mirrored transport only
 * when the failure looks network-related. The installed package identity stays unchanged.
 */

import { execSync, spawn } from 'child_process';
import { platform } from 'os';

// Version cache: { [toolId]: { latestVersion: string, checkedAt: number } }
const versionCache = {};
const VERSION_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

const OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org/';
const FALLBACK_NPM_REGISTRY = process.env.CLIGATE_FALLBACK_NPM_REGISTRY || 'https://registry.npmmirror.com/';
const NPM_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const NODE_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const OFFICIAL_INSTALL_RETRY_LIMIT = 2;
const OFFICIAL_VIEW_RETRY_LIMIT = 2;

const TOOLS = {
    node: {
        name: 'Node.js',
        command: 'node',
        versionFlag: '--version',
        npmPackage: null,
        description: 'JavaScript runtime (required for all CLI tools)',
        color: 'green'
    },
    claude: {
        name: 'Claude Code',
        command: 'claude',
        versionFlag: '--version',
        npmPackage: '@anthropic-ai/claude-code',
        description: 'Anthropic\'s CLI for Claude',
        color: 'purple'
    },
    codex: {
        name: 'Codex CLI',
        command: 'codex',
        versionFlag: '--version',
        npmPackage: '@openai/codex',
        description: 'OpenAI\'s CLI coding agent',
        color: 'green'
    },
    gemini: {
        name: 'Gemini CLI',
        command: 'gemini',
        versionFlag: '--version',
        npmPackage: '@google/gemini-cli',
        description: 'Google\'s CLI for Gemini',
        color: 'blue'
    },
    openclaw: {
        name: 'OpenClaw',
        command: 'openclaw',
        versionFlag: '--version',
        npmPackage: 'openclaw',
        description: 'Open-source multi-provider coding agent',
        color: 'orange'
    }
};

const DEFAULT_EXECUTION_ADAPTER = {
    runCommand(command) {
        try {
            return execSync(command, {
                encoding: 'utf8',
                timeout: 15000,
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: true
            }).trim();
        } catch {
            return null;
        }
    },
    spawnCommand(command, args, options) {
        return spawn(command, args, options);
    }
};

let executionAdapter = DEFAULT_EXECUTION_ADAPTER;

function getOS() {
    const p = platform();
    if (p === 'win32') return 'windows';
    if (p === 'darwin') return 'macos';
    return 'linux';
}

function runCommand(cmd) {
    return executionAdapter.runCommand(cmd);
}

function extractVersion(raw) {
    if (!raw) return null;
    const firstLine = raw.split('\n')[0].trim();
    const match = firstLine.match(/(\d+\.\d+(?:\.\d+)*)/);
    return match ? match[1] : firstLine.replace(/^v/, '').trim();
}

function detectTool(toolId) {
    const tool = TOOLS[toolId];
    if (!tool) return { installed: false, error: 'Unknown tool' };

    const version = runCommand(`${tool.command} ${tool.versionFlag}`);
    if (version) {
        const cleanVersion = extractVersion(version);
        return { installed: true, version: cleanVersion };
    }
    return { installed: false };
}

function normalizeRegistryUrl(url) {
    return url.endsWith('/') ? url : `${url}/`;
}

function isNetworkRelatedFailure(text) {
    if (!text) return false;
    return [
        'econnreset',
        'econntimedout',
        'etimedout',
        'network request',
        'network timeout',
        'socket hang up',
        'getaddrinfo',
        'enotfound',
        'eai_again',
        'fetch failed',
        'unable to connect',
        'connection reset',
        'connection timed out',
        'proxy error',
        'self signed certificate in certificate chain',
        'tunneling socket could not be established',
        'read timed out'
    ].some((marker) => text.toLowerCase().includes(marker));
}

function buildAttemptLabel(source) {
    return source === 'official' ? 'official source' : 'fallback source';
}

function formatFailureMessage({ actionLabel, attemptResults, fallbackTriggered }) {
    const details = attemptResults
        .map((attempt, index) => {
            const reason = attempt.error || `Exited with code ${attempt.code ?? 'unknown'}`;
            return `Attempt ${index + 1} (${buildAttemptLabel(attempt.source)}): ${reason}`;
        })
        .join('\n');

    if (fallbackTriggered) {
        return `${actionLabel} failed after trying the official source and the fallback source.\n${details}`;
    }

    return `${actionLabel} failed on the official source.\n${details}`;
}

function finalizeCommandResult(result, actionLabel) {
    if (result.success) {
        return result;
    }

    return {
        success: false,
        error: formatFailureMessage({
            actionLabel,
            attemptResults: result.attemptResults,
            fallbackTriggered: result.fallbackTriggered
        }),
        output: result.output || '',
        usedFallback: result.usedFallback || false,
        fallbackTriggered: result.fallbackTriggered || false,
        attempts: result.attemptResults
    };
}

function buildNpmEnv(registryUrl) {
    return {
        ...process.env,
        npm_config_registry: normalizeRegistryUrl(registryUrl)
    };
}

function spawnWithCapture(command, args, {
    shell = true,
    timeoutMs = NPM_COMMAND_TIMEOUT_MS,
    env = process.env
} = {}) {
    return new Promise((resolve) => {
        const proc = executionAdapter.spawnCommand(command, args, {
            shell,
            stdio: ['pipe', 'pipe', 'pipe'],
            env
        });

        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
            try {
                proc.kill();
            } catch {
                // ignore kill races
            }
            finish({
                success: false,
                code: null,
                error: `Command timed out (${Math.round(timeoutMs / 1000)} seconds)`
            });
        }, timeoutMs);

        if (typeof timer.unref === 'function') {
            timer.unref();
        }

        const finish = (payload) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({
                stdout,
                stderr,
                ...payload
            });
        };

        proc.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        proc.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        proc.on('close', (code) => {
            finish({
                success: code === 0,
                code,
                error: code === 0 ? null : (stderr || `Command exited with code ${code}`)
            });
        });

        proc.on('error', (err) => {
            finish({
                success: false,
                code: null,
                error: err.message
            });
        });
    });
}

async function runOfficialThenFallback({
    command,
    officialArgs,
    fallbackArgs = null,
    actionLabel,
    officialEnv = process.env,
    fallbackEnv = null,
    timeoutMs = NPM_COMMAND_TIMEOUT_MS,
    officialRetryLimit = OFFICIAL_INSTALL_RETRY_LIMIT
}) {
    const attemptResults = [];

    for (let attempt = 0; attempt < officialRetryLimit; attempt += 1) {
        const result = await spawnWithCapture(command, officialArgs, {
            env: officialEnv,
            timeoutMs
        });

        attemptResults.push({
            source: 'official',
            success: result.success,
            code: result.code,
            error: result.error
        });

        if (result.success) {
            return {
                success: true,
                output: result.stdout,
                stderr: result.stderr,
                usedFallback: false,
                fallbackTriggered: false,
                attemptResults
            };
        }

        const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
        if (!isNetworkRelatedFailure(combinedOutput)) {
            return {
                success: false,
                output: result.stdout,
                stderr: result.stderr,
                usedFallback: false,
                fallbackTriggered: false,
                attemptResults
            };
        }
    }

    if (!fallbackEnv) {
        return {
            success: false,
            output: '',
            stderr: '',
            usedFallback: false,
            fallbackTriggered: false,
            attemptResults
        };
    }

    const fallbackResult = await spawnWithCapture(command, fallbackArgs || officialArgs, {
        env: fallbackEnv,
        timeoutMs
    });

    attemptResults.push({
        source: 'fallback',
        success: fallbackResult.success,
        code: fallbackResult.code,
        error: fallbackResult.error
    });

    return {
        success: fallbackResult.success,
        output: fallbackResult.stdout,
        stderr: fallbackResult.stderr,
        usedFallback: true,
        fallbackTriggered: true,
        attemptResults
    };
}

function buildNodeInstallInfoForOS(os) {
    switch (os) {
        case 'windows':
            return {
                os,
                method: 'installer',
                downloadUrl: 'https://nodejs.org/en/download/',
                instructions: [
                    'Download the Windows Installer (.msi) from nodejs.org',
                    'Run the installer and follow the prompts',
                    'Restart your terminal after installation',
                    'Verify with: node --version'
                ],
                autoInstallSupported: true,
                autoCommand: 'winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements',
                fallbackCommand: null
            };
        case 'macos':
            return {
                os,
                method: 'installer',
                downloadUrl: 'https://nodejs.org/en/download/',
                instructions: [
                    'Download the macOS Installer (.pkg) from nodejs.org',
                    'Or install via Homebrew: brew install node',
                    'Verify with: node --version'
                ],
                autoInstallSupported: true,
                autoCommand: 'brew install node',
                fallbackCommand: null
            };
        case 'linux':
            return {
                os,
                method: 'package-manager',
                downloadUrl: 'https://nodejs.org/en/download/',
                instructions: [
                    'Ubuntu/Debian: curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs',
                    'Fedora/RHEL: sudo dnf install nodejs',
                    'Or use nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash',
                    'Verify with: node --version'
                ],
                autoInstallSupported: true,
                autoCommand: 'curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs',
                fallbackCommand: null
            };
        default:
            return {
                os,
                method: 'manual',
                downloadUrl: 'https://nodejs.org/en/download/',
                instructions: ['Download from nodejs.org'],
                autoInstallSupported: false,
                autoCommand: null,
                fallbackCommand: null
            };
    }
}

export function detectAllTools() {
    const os = getOS();
    const results = {};

    for (const [id, tool] of Object.entries(TOOLS)) {
        const status = detectTool(id);
        results[id] = {
            ...tool,
            id,
            ...status
        };
    }

    const npmVersion = runCommand('npm --version');
    results.node.npmInstalled = !!npmVersion;
    results.node.npmVersion = npmVersion || null;

    for (const [id, tool] of Object.entries(results)) {
        const cached = versionCache[id];
        if (cached && (Date.now() - cached.checkedAt) < VERSION_CACHE_TTL) {
            tool.latestVersion = cached.latestVersion;
            tool.updateAvailable = tool.installed && cached.latestVersion
                ? compareVersions(tool.version, cached.latestVersion) < 0
                : false;
        } else {
            tool.latestVersion = null;
            tool.updateAvailable = false;
        }
    }

    return { os, tools: results };
}

export function getNodeInstallInfo() {
    return buildNodeInstallInfoForOS(getOS());
}

async function installOrUpdateTool(toolId, packageSpecifier, actionLabel) {
    const tool = TOOLS[toolId];
    if (!tool) return { success: false, error: 'Unknown tool' };
    if (!tool.npmPackage) return { success: false, error: 'This tool cannot be installed via npm' };

    const npmCheck = runCommand('npm --version');
    if (!npmCheck) {
        return { success: false, error: 'npm is not available. Please install Node.js first.' };
    }

    const result = await runOfficialThenFallback({
        command: 'npm',
        officialArgs: ['install', '-g', packageSpecifier, '--registry', OFFICIAL_NPM_REGISTRY],
        fallbackArgs: ['install', '-g', packageSpecifier, '--registry', FALLBACK_NPM_REGISTRY],
        actionLabel,
        officialEnv: buildNpmEnv(OFFICIAL_NPM_REGISTRY),
        fallbackEnv: normalizeRegistryUrl(FALLBACK_NPM_REGISTRY) === normalizeRegistryUrl(OFFICIAL_NPM_REGISTRY)
            ? null
            : buildNpmEnv(FALLBACK_NPM_REGISTRY),
        timeoutMs: NPM_COMMAND_TIMEOUT_MS,
        officialRetryLimit: OFFICIAL_INSTALL_RETRY_LIMIT
    });

    if (!result.success) {
        return finalizeCommandResult(result, actionLabel);
    }

    const status = detectTool(toolId);
    const output = result.usedFallback
        ? `${result.output}\nInstalled via fallback registry after official source failure.`.trim()
        : result.output;

    return {
        success: true,
        version: status.version || 'installed',
        output,
        usedFallback: result.usedFallback,
        fallbackTriggered: result.fallbackTriggered,
        installedPackage: packageSpecifier
    };
}

export function installTool(toolId) {
    const tool = TOOLS[toolId];
    if (!tool) return Promise.resolve({ success: false, error: 'Unknown tool' });
    return installOrUpdateTool(toolId, tool.npmPackage, `Installing ${tool.name}`);
}

export async function installNode() {
    const info = getNodeInstallInfo();
    if (!info.autoInstallSupported) {
        return { success: false, error: 'Automatic installation not supported on this platform' };
    }

    const official = await spawnWithCapture(info.autoCommand, [], {
        timeoutMs: NODE_COMMAND_TIMEOUT_MS
    });

    if (!official.success) {
        return {
            success: false,
            error: `Node.js installation failed on the official source.\nAttempt 1 (official source): ${official.error}`,
            output: official.stdout,
            command: info.autoCommand
        };
    }

    const status = detectTool('node');
    return {
        success: true,
        version: status.version || 'installed',
        output: official.stdout,
        usedFallback: false,
        fallbackTriggered: false
    };
}

export function compareVersions(a, b) {
    if (!a || !b) return 0;
    const pa = a.replace(/^v/, '').split('.').map(Number);
    const pb = b.replace(/^v/, '').split('.').map(Number);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const na = pa[i] || 0;
        const nb = pb[i] || 0;
        if (na < nb) return -1;
        if (na > nb) return 1;
    }
    return 0;
}

export function checkLatestVersion(toolId) {
    const tool = TOOLS[toolId];
    if (!tool || !tool.npmPackage) return null;

    const cached = versionCache[toolId];
    if (cached && (Date.now() - cached.checkedAt) < VERSION_CACHE_TTL) {
        return cached.latestVersion;
    }

    const official = runCommand(`npm view ${tool.npmPackage} version --registry=${OFFICIAL_NPM_REGISTRY}`);
    if (official) {
        const latestVersion = official.split('\n')[0].replace(/^v/, '').trim();
        versionCache[toolId] = { latestVersion, checkedAt: Date.now() };
        return latestVersion;
    }

    for (let attempt = 1; attempt < OFFICIAL_VIEW_RETRY_LIMIT; attempt += 1) {
        const retry = runCommand(`npm view ${tool.npmPackage} version --registry=${OFFICIAL_NPM_REGISTRY}`);
        if (retry) {
            const latestVersion = retry.split('\n')[0].replace(/^v/, '').trim();
            versionCache[toolId] = { latestVersion, checkedAt: Date.now() };
            return latestVersion;
        }
    }

    if (normalizeRegistryUrl(FALLBACK_NPM_REGISTRY) === normalizeRegistryUrl(OFFICIAL_NPM_REGISTRY)) {
        return null;
    }

    const fallback = runCommand(`npm view ${tool.npmPackage} version --registry=${FALLBACK_NPM_REGISTRY}`);
    if (fallback) {
        const latestVersion = fallback.split('\n')[0].replace(/^v/, '').trim();
        versionCache[toolId] = { latestVersion, checkedAt: Date.now() };
        return latestVersion;
    }

    return null;
}

export function checkAllLatestVersions() {
    const results = {};
    for (const toolId of Object.keys(TOOLS)) {
        if (TOOLS[toolId].npmPackage) {
            const latest = checkLatestVersion(toolId);
            if (latest) {
                results[toolId] = latest;
            }
        }
    }
    return results;
}

export async function updateTool(toolId) {
    const tool = TOOLS[toolId];
    if (!tool) return { success: false, error: 'Unknown tool' };

    const result = await installOrUpdateTool(toolId, `${tool.npmPackage}@latest`, `Updating ${tool.name}`);
    delete versionCache[toolId];

    if (!result.success) {
        return result;
    }

    return {
        ...result,
        version: result.version || 'updated'
    };
}

export function __setToolInstallerExecutionAdapterForTests(adapter) {
    executionAdapter = {
        ...DEFAULT_EXECUTION_ADAPTER,
        ...adapter
    };
}

export function __resetToolInstallerExecutionAdapterForTests() {
    executionAdapter = DEFAULT_EXECUTION_ADAPTER;
}

export function __clearToolInstallerVersionCacheForTests() {
    for (const key of Object.keys(versionCache)) {
        delete versionCache[key];
    }
}

export { TOOLS, OFFICIAL_NPM_REGISTRY, FALLBACK_NPM_REGISTRY, isNetworkRelatedFailure };
