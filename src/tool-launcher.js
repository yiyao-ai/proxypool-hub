/**
 * Tool Launcher
 * Opens a new terminal window and launches a CLI tool.
 * Cross-platform support: Windows, macOS, Linux.
 */

import { spawn } from 'child_process';
import { platform } from 'os';

const ALLOWED_TOOLS = {
    claude: 'claude',
    codex: 'codex',
    gemini: 'gemini',
    openclaw: 'openclaw'
};

/**
 * Launch a CLI tool in a new terminal window.
 * @param {string} toolId - One of: claude, codex, gemini, openclaw
 * @returns {{ success: boolean, error?: string }}
 */
export function launchTool(toolId) {
    const cmd = ALLOWED_TOOLS[toolId];
    if (!cmd) {
        return { success: false, error: `Unknown tool: ${toolId}` };
    }

    const os = platform();

    try {
        if (os === 'win32') {
            // Windows: open a new cmd window with the tool command
            spawn('cmd', ['/c', 'start', 'cmd', '/k', cmd], {
                detached: true,
                shell: true,
                stdio: 'ignore'
            }).unref();
        } else if (os === 'darwin') {
            // macOS: open Terminal.app with the command
            spawn('osascript', ['-e', `tell app "Terminal" to do script "${cmd}"`], {
                detached: true,
                stdio: 'ignore'
            }).unref();
        } else {
            // Linux: try common terminal emulators in order
            const script = `x-terminal-emulator -e ${cmd} 2>/dev/null || gnome-terminal -- ${cmd} 2>/dev/null || konsole -e ${cmd} 2>/dev/null || xterm -e ${cmd}`;
            spawn('bash', ['-c', script], {
                detached: true,
                stdio: 'ignore'
            }).unref();
        }

        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}
