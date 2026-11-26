'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const HOSTNAME = 'my-first-website-2026-bwbrhja8dnfuf9ab.eastasia-01.azurewebsites.net';
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const GEMINI_MODEL = 'gemini-3.8-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const rateBuckets = new Map();
const MAX_BODY_BYTES = 16 * 1024;
const MAX_MESSAGE_CHARS = 2000;
const MAX_HISTORY_ITEMS = 8;
const RATE_LIMIT = 8;
const RATE_WINDOW_MS = 10 * 60 * 1000;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function getClientIp(req) {
  // Azure App Service supplies X-Forwarded-For; use only the first address.
  const forwarded = req.headers['x-forwarded-for'];
  return (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
    bucket = { startedAt: now, count: 0 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;

  // Opportunistic cleanup so this in-memory map does not grow indefinitely.
  if (rateBuckets.size > 2000) {
    for (const [key, value] of rateBuckets) {
      if (now - value.startedAt >= RATE_WINDOW_MS) rateBuckets.delete(key);
    }
  }
  return bucket.count <= RATE_LIMIT;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求内容过大。'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('请求格式无效。'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) throw new Error('服务器尚未配置 Turnstile 密钥。');
  const form = new URLSearchParams({ secret, response: token, remoteip: ip });
  const response = await fetch(TURNSTILE_VERIFY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error('Cloudflare 验证服务暂时不可用。');
  const result = await response.json();
  return result.success === true && result.hostname === HOSTNAME;
}

async function askGemini(message, history) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('服务器尚未配置 Gemini API Key。');

  const contents = [];
  for (const item of history) {
    if (!item || !['user', 'model'].includes(item.role) || typeof item.text !== 'string') continue;
    const text = item.text.trim().slice(0, MAX_MESSAGE_CHARS);
    if (text) contents.push({ role: item.role, parts: [{ text }] });
  }
  contents.push({ role: 'user', parts: [{ text: message }] });

  const response = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: '你是 DIGITAL SPACE 网站的中文 AI 助手。请友好、清晰、准确地回答访客问题。默认使用中文；如果用户使用其他语言，则跟随用户语言。不要声称能访问网站服务器、用户设备或实时网络，除非确实有相应工具。' }]
      },
      contents,
      generationConfig: {
        maxOutputTokens: 700,
        temperature: 0.7
      }
    }),
    signal: AbortSignal.timeout(30000)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data && data.error && data.error.message;
    throw new Error(detail ? `Gemini API 暂时无法响应：${detail}` : 'Gemini API 暂时无法响应，请稍后重试。');
  }
  const reply = data?.candidates?.[0]?.content?.parts
    ?.map(part => part.text || '')
    .join('')
    .trim();
  if (!reply) throw new Error('AI 暂时没有生成回复，请换个问题试试。');
  return reply;
}


async function askCloudflareWorkersAI(message, history) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new Error('Cloudflare Account ID 未配置正确。');
  }
  if (!apiToken) {
    throw new Error('服务器尚未配置 Cloudflare Workers AI 凭据。');
  }

  // Use a fixed server-side model; the visitor cannot supply a model ID.
  const model = '@cf/meta/llama-3.1-8b-instruct';
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;

  const transcript = [
    'System: 你是 DIGITAL SPACE 网站的中文 AI 助手。请友好、清晰、准确地回答访客问题。默认使用中文；如果用户使用其他语言，则跟随用户语言。不要声称能访问网站服务器、用户设备或实时网络，除非确实有相应工具。'
  ];

  for (const item of history) {
    if (!item || !['user', 'model'].includes(item.role) || typeof item.text !== 'string') continue;
    const text = item.text.trim().slice(0, MAX_MESSAGE_CHARS);
    if (!text) continue;
    transcript.push(`${item.role === 'user' ? 'User' : 'Assistant'}: ${text}`);
  }
  transcript.push(`User: ${message}`);
  transcript.push('Assistant:');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      prompt: transcript.join('\n\n'),
      max_tokens: 700,
      temperature: 0.7
    }),
    signal: AbortSignal.timeout(30000)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    const detail = Array.isArray(data.errors) && data.errors[0]?.message;
    throw new Error(detail ? `Cloudflare Workers AI 暂时无法响应：${detail}` : 'Cloudflare Workers AI 暂时无法响应，请稍后重试。');
  }

  const reply = data?.result?.response;
  if (typeof reply !== 'string' || !reply.trim()) {
    throw new Error('Cloudflare Workers AI 暂时没有生成回复，请换个问题试试。');
  }
  return reply.trim();
}

async function handleChat(req, res) {
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  const origin = req.headers.origin;
  let originHost = '';
  try {
    originHost = origin ? new URL(origin).host.toLowerCase() : '';
  } catch {
    return sendJson(res, 403, { error: '请求来源不受允许。' });
  }
  if (host !== HOSTNAME || (origin && originHost !== HOSTNAME)) {
    return sendJson(res, 403, { error: '请求来源不受允许。' });
  }

  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    return sendJson(res, 429, { error: '发送太频繁了，请 10 分钟后再试。' });
  }

  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, error.statusCode || 400, { error: error.message || '请求格式无效。' });
  }

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const token = typeof body.turnstileToken === 'string' ? body.turnstileToken : '';
  if (!message || message.length > MAX_MESSAGE_CHARS) {
    return sendJson(res, 400, { error: `请输入 1 到 ${MAX_MESSAGE_CHARS} 个字符的问题。` });
  }
  if (!token || token.length > 2048) {
    return sendJson(res, 400, { error: '安全验证已过期，请重新验证后发送。' });
  }

  const rawHistory = Array.isArray(body.history) ? body.history.slice(-MAX_HISTORY_ITEMS) : [];
  const history = rawHistory.filter(item =>
    item && ['user', 'model'].includes(item.role) &&
    typeof item.text === 'string' && item.text.trim().length > 0
  );

  try {
    const verified = await verifyTurnstile(token, ip);
    if (!verified) return sendJson(res, 403, { error: 'Cloudflare 安全验证未通过或已过期，请重新验证。' });
    const provider = body.provider === 'cloudflare' ? 'cloudflare' : 'gemini';
    const reply = provider === 'cloudflare'
      ? await askCloudflareWorkersAI(message, history)
      : await askGemini(message, history);
    return sendJson(res, 200, { reply, provider });
  } catch (error) {
    console.error('Chat API error:', error.message);
    return sendJson(res, 502, { error: error.message || 'AI 服务暂时不可用，请稍后重试。' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    return handleChat(req, res);
  }
  if (url.pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: '接口不存在。' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end('Method Not Allowed');
  }

  const filePath = path.join(__dirname, 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Website loading error');
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    if (req.method === 'HEAD') return res.end();
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Website running on port ${PORT}`);
});
