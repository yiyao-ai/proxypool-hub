import EventEmitter from 'events';

const COLORS = {
    reset: '\x1b[0m',
    blue: '\x1b[34m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m',
    dim: '\x1b[2m'
};

const LEVEL_ICONS = {
    INFO: 'ℹ',
    SUCCESS: '✓',
    WARN: '⚠',
    ERROR: '✗',
    DEBUG: '•'
};

class Logger extends EventEmitter {
    constructor() {
        super();
        this.debugEnabled = false;
        this.history = [];
        this.maxHistory = 1000;
    }

    setDebug(enabled) {
        this.debugEnabled = enabled;
    }

    get isDebugEnabled() {
        return this.debugEnabled;
    }

    getHistory() {
        return [...this.history];
    }

    clear() {
        this.history = [];
    }

    _formatTimestamp() {
        return new Date().toISOString();
    }

    _formatMessage(args) {
        return args.map(arg => {
            if (arg === null) return 'null';
            if (arg === undefined) return 'undefined';
            if (typeof arg === 'object') {
                try {
                    return JSON.stringify(arg, null, 2);
                } catch (e) {
                    return String(arg);
                }
            }
            return String(arg);
        }).join(' ');
    }

    _log(level, ...args) {
        const timestamp = this._formatTimestamp();
        const icon = LEVEL_ICONS[level] || '•';
        const color = {
            INFO: COLORS.blue,
            SUCCESS: COLORS.green,
            WARN: COLORS.yellow,
            ERROR: COLORS.red,
            DEBUG: COLORS.magenta
        }[level] || COLORS.reset;

        const message = this._formatMessage(args);

        if (level === 'DEBUG' && !this.debugEnabled) {
            return;
        }

        const logEntry = {
            timestamp,
            level,
            message,
            icon
        };

        this.history.push(logEntry);
        if (this.history.length > this.maxHistory) {
            this.history.shift();
        }

        this.emit('log', logEntry);

        const consoleTime = timestamp.replace('T', ' ').slice(0, 19);
        const consoleMessage = `${COLORS.gray}${consoleTime}${COLORS.reset} ${color}${icon}${COLORS.reset} ${message}`;

        switch (level) {
            case 'ERROR':
                console.error(consoleMessage);
                break;
            case 'WARN':
                console.warn(consoleMessage);
                break;
            default:
                console.log(consoleMessage);
        }
    }

    info(...args) {
        this._log('INFO', ...args);
    }

    success(...args) {
        this._log('SUCCESS', ...args);
    }

    warn(...args) {
        this._log('WARN', ...args);
    }

    error(...args) {
        this._log('ERROR', ...args);
    }

    debug(...args) {
        this._log('DEBUG', ...args);
    }

    request(method, path, details = {}) {
        const parts = [`${method}`, path];
        if (details.model) parts.push(`model=${details.model}`);
        if (details.account) parts.push(`account=${details.account}`);
        if (details.stream !== undefined) parts.push(`stream=${details.stream}`);
        if (details.messages) parts.push(`messages=${details.messages}`);
        if (details.tools) parts.push(`tools=${details.tools}`);
        this.info(`[Request] ${parts.join(' | ')}`);
    }

    response(status, details = {}) {
        const parts = [`status=${status}`];
        if (details.model) parts.push(`model=${details.model}`);
        if (details.tokens) parts.push(`tokens=${details.tokens}`);
        if (details.duration) parts.push(`${details.duration}ms`);
        if (details.error) parts.push(`error=${details.error}`);
        
        if (status >= 400) {
            this.error(`[Response] ${parts.join(' | ')}`);
        } else {
            this.success(`[Response] ${parts.join(' | ')}`);
        }
    }
}

export const logger = new Logger();
