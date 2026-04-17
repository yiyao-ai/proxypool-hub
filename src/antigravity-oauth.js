import crypto from 'crypto';
import http from 'http';

const GOOGLE_OAUTH_CONFIG = {
    clientId: process.env.ANTIGRAVITY_GOOGLE_CLIENT_ID || '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
    clientSecret: process.env.ANTIGRAVITY_GOOGLE_CLIENT_SECRET || '',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    callbackPort: 36545,
    callbackFallbackPorts: [36546, 36547, 36548, 36549, 36550],
    callbackPath: '/callback',
    scopes: [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/cclog',
        'https://www.googleapis.com/auth/experimentsandconfigs'
    ]
};

export { GOOGLE_OAUTH_CONFIG };

export function generateState() {
    return crypto.randomBytes(16).toString('hex');
}

export function getAuthorizationUrl(state, port) {
    const redirectUri = `http://localhost:${port}${GOOGLE_OAUTH_CONFIG.callbackPath}`;
    const params = new URLSearchParams({
        client_id: GOOGLE_OAUTH_CONFIG.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GOOGLE_OAUTH_CONFIG.scopes.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state
    });
    return `${GOOGLE_OAUTH_CONFIG.authUrl}?${params.toString()}`;
}

function getSuccessHtml(message) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Antigravity Auth Success</title>
<style>body{font-family:system-ui;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.card{background:#1e293b;padding:3rem;border-radius:1rem;box-shadow:0 25px 50px -12px rgba(0,0,0,.5);text-align:center;max-width:420px;border:1px solid #334155}.icon{font-size:4rem;margin-bottom:1.5rem;display:block}h1{margin:0 0 1rem;color:#67e8f9;font-weight:700}p{color:#94a3b8;line-height:1.6;font-size:1.05rem}.footer{margin-top:2rem;font-size:.9rem;color:#64748b}</style></head>
<body><div class="card"><span class="icon">✅</span><h1>Success!</h1><p>${message}</p><div class="footer">You can close this window and return to the app.</div></div><script>if(window.opener)window.opener.postMessage({type:'antigravity-oauth-success'},'*');setTimeout(()=>window.close(),3000)</script></body></html>`;
}

function getErrorHtml(error) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Antigravity Auth Failed</title>
<style>body{font-family:system-ui;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.card{background:#1e293b;padding:3rem;border-radius:1rem;box-shadow:0 25px 50px -12px rgba(0,0,0,.5);text-align:center;max-width:420px;border:1px solid #334155}.icon{font-size:4rem;margin-bottom:1.5rem;display:block}h1{margin:0 0 1rem;color:#ef4444;font-weight:700}p{color:#94a3b8;line-height:1.6;font-size:1.05rem}</style></head>
<body><div class="card"><span class="icon">❌</span><h1>Failed</h1><p>Google authentication failed.</p><div style="background:rgba(239,68,68,.1);padding:1rem;border-radius:.5rem;color:#fca5a5;margin-top:1rem;font-family:monospace;font-size:.9rem">${error}</div></div></body></html>`;
}

function tryBindPort(server, port, host = '0.0.0.0') {
    return new Promise((resolve, reject) => {
        const onError = (err) => {
            server.removeListener('listening', onSuccess);
            reject(err);
        };
        const onSuccess = () => {
            server.removeListener('error', onError);
            resolve(port);
        };
        server.once('error', onError);
        server.once('listening', onSuccess);
        server.listen(port, host);
    });
}

export function startCallbackServer(expectedState, timeoutMs = 120000) {
    let server = null;
    let timeoutId = null;
    let isAborted = false;
    let actualPort = GOOGLE_OAUTH_CONFIG.callbackPort;
    const host = process.env.HOST || '0.0.0.0';

    const promise = new Promise(async (resolve, reject) => {
        const portsToTry = [GOOGLE_OAUTH_CONFIG.callbackPort, ...(GOOGLE_OAUTH_CONFIG.callbackFallbackPorts || [])];
        const errors = [];

        server = http.createServer((req, res) => {
            const url = new URL(req.url, `http://${host === '0.0.0.0' ? 'localhost' : host}:${actualPort}`);
            if (url.pathname !== GOOGLE_OAUTH_CONFIG.callbackPath) {
                res.writeHead(404);
                res.end('Not found');
                return;
            }

            const code = url.searchParams.get('code');
            const state = url.searchParams.get('state');
            const error = url.searchParams.get('error');

            if (error) {
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(getErrorHtml(error));
                server.close();
                reject(new Error(`Google OAuth error: ${error}`));
                return;
            }

            if (state !== expectedState) {
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(getErrorHtml('invalid_state'));
                server.close();
                reject(new Error('Google OAuth state mismatch'));
                return;
            }

            if (code) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(getSuccessHtml('Antigravity account connected successfully.'));
                setTimeout(() => {
                    server.close();
                    clearTimeout(timeoutId);
                    resolve(code);
                }, 1000);
                return;
            }

            res.writeHead(400);
            res.end('Waiting for authorization code...');
        });

        let boundSuccessfully = false;
        for (const port of portsToTry) {
            try {
                await tryBindPort(server, port, host);
                actualPort = port;
                boundSuccessfully = true;
                break;
            } catch (err) {
                errors.push(`Port ${port}: ${err.code || err.message}`);
            }
        }

        if (!boundSuccessfully) {
            reject(new Error(`Failed to start Antigravity OAuth callback server. Tried: ${portsToTry.join(', ')}\n${errors.join('\n')}`));
            return;
        }

        timeoutId = setTimeout(() => {
            if (!isAborted) {
                server.close();
                reject(new Error('Antigravity OAuth callback timeout'));
            }
        }, timeoutMs);
    });

    const abort = () => {
        if (isAborted) return;
        isAborted = true;
        if (timeoutId) clearTimeout(timeoutId);
        if (server) server.close();
    };

    return {
        promise,
        abort,
        getPort: () => actualPort
    };
}

export async function exchangeCodeForTokens(code, port) {
    const redirectUri = `http://localhost:${port}${GOOGLE_OAUTH_CONFIG.callbackPath}`;
    const tokenParams = new URLSearchParams({
        client_id: GOOGLE_OAUTH_CONFIG.clientId,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
    });

    // Antigravity accounts are persisted locally after login. A client secret is
    // optional and should only be supplied via environment, never hardcoded.
    if (GOOGLE_OAUTH_CONFIG.clientSecret) {
        tokenParams.set('client_secret', GOOGLE_OAUTH_CONFIG.clientSecret);
    }

    const response = await fetch(GOOGLE_OAUTH_CONFIG.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenParams.toString()
    });

    const responseText = await response.text();
    if (!response.ok) {
        throw new Error(`Google token exchange failed: ${response.status} - ${responseText}`);
    }

    const parsed = JSON.parse(responseText);
    if (!parsed.access_token) throw new Error('No access token returned by Google');
    if (!parsed.refresh_token) throw new Error('No refresh token returned by Google. Revoke prior consent and try again.');

    return {
        accessToken: parsed.access_token,
        refreshToken: parsed.refresh_token,
        expiresIn: parsed.expires_in || 3600,
        tokenType: parsed.token_type || 'Bearer',
        oauthClientKey: 'antigravity-enterprise'
    };
}

export function extractCodeFromInput(input) {
    if (!input) throw new Error('Code is required');
    if (input.startsWith('http://') || input.startsWith('https://')) {
        const url = new URL(input);
        return {
            code: url.searchParams.get('code'),
            state: url.searchParams.get('state')
        };
    }
    return { code: input.trim(), state: null };
}

export default {
    GOOGLE_OAUTH_CONFIG,
    generateState,
    getAuthorizationUrl,
    startCallbackServer,
    exchangeCodeForTokens,
    extractCodeFromInput
};
