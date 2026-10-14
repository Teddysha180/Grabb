const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');
const { URL } = require('url');
const { identifyMedia, mimeTypeForExtension } = require('./media-utils');

const app = express();
const PORT = process.env.PORT || 3000;
const EXPORTS_DIR = path.join(__dirname, 'exports');

const USER_AGENT = 'Grabb-OfflineArchiver/2.0 (public offline copy; no access bypass)';
const REQUEST_TIMEOUT_MS = 15000;
const MEDIA_REQUEST_TIMEOUT_MS = 120000;
const HTML_MAX_BYTES = 10 * 1024 * 1024;
const RESOURCE_MAX_BYTES = 25 * 1024 * 1024;
const MEDIA_MAX_BYTES = 250 * 1024 * 1024;
const TOTAL_DOWNLOAD_MAX_BYTES = 1024 * 1024 * 1024;
const MAX_MEDIA_FILES = 500;       // media-only limit (independent of other resources)
const MAX_RESOURCES = 3500;        // raised: Apple pages have thousands of assets
const MAX_NON_MEDIA_RESOURCES = 1500; // cap for non-media assets
const MAX_PAGES = 20;
const MAX_CSS_DEPTH = 4;

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname)));
app.use('/downloads', express.static(EXPORTS_DIR, {
  fallthrough: true,
  setHeaders(res, filePath) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.zip') {
      const fileName = path.basename(filePath);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    } else {
      const mediaType = mimeTypeForExtension(ext);
      if (mediaType) res.setHeader('Content-Type', mediaType);
    }
  }
}));

function findChromeExecutable() {
  const candidates = [
    process.env.CHROME_BIN,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft\\Edge\\Application\\msedge.exe') : null,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];
  for (const c of candidates) {
    if (c) {
      try {
        const stats = require('fs').statSync(c);
        if (stats.isFile()) return c;
      } catch {}
    }
  }
  return null;
}

function isPrivateIp(value) {
  const ip = value.toLowerCase();
  if (net.isIP(ip) === 4) {
    const parts = ip.split('.').map(Number);
    return parts[0] === 0 ||
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      parts[0] >= 224;
  }
  if (net.isIP(ip) === 6) {
    return ip === '::' ||
      ip === '::1' ||
      ip.startsWith('fc') ||
      ip.startsWith('fd') ||
      ip.startsWith('fe80:') ||
      ip.startsWith('ff');
  }
  return false;
}

function looksPrivateHostname(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h.endsWith('.lan') ||
    h.endsWith('.home') ||
    isPrivateIp(h);
}

async function validateUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Enter a valid full URL, such as https://example.com');
  }

  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported.');
  if (url.username || url.password) throw new Error('URLs containing credentials are not allowed.');
  if (looksPrivateHostname(url.hostname)) throw new Error('Local and private network hosts are blocked.');

  const literal = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(literal)) {
    if (isPrivateIp(literal)) throw new Error('Local and private network IPs are blocked.');
    return url;
  }

  let records;
  try {
    records = await dns.lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new Error(`Could not resolve ${url.hostname}.`);
  }
  if (!records.length || records.some(record => isPrivateIp(record.address))) {
    throw new Error('This hostname resolves to a private or blocked network address.');
  }
  return url;
}

function decodeHtmlEntities(value) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#39|#x27);/gi, entity => ({
    '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&#39;': "'", '&#x27;': "'"
  })[entity.toLowerCase()] || entity);
}

function resolveUrl(raw, base) {
  if (!raw) return null;
  let trimmed = decodeHtmlEntities(raw.trim());
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  if (!trimmed || trimmed.startsWith('#')) return null;
  if (/^(data|blob|javascript|mailto|tel):/i.test(trimmed)) return null;
  if (/^[a-z0-9+/]{256,}={0,2}$/i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed, base);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

async function safeFetch(raw, base, manifest, kind = 'resource') {
  let current = await validateUrl(new URL(raw, base).href);
  const redirects = [];

  for (let i = 0; i < 8; i++) {
    const response = await fetch(current.href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(kind === 'media' || kind === 'media segment' || kind === 'media playlist'
        ? MEDIA_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS),
      headers: {
        'user-agent': USER_AGENT,
        accept: '*/*'
      }
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) return { response, finalUrl: current.href, redirects };
      const next = await validateUrl(new URL(location, current).href);
      redirects.push({ from: current.href, to: next.href, status: response.status });
      current = next;
      continue;
    }

    return { response, finalUrl: current.href, redirects };
  }

  if (manifest) manifest.redirects.push({ url: raw, kind, reason: 'too many redirects' });
  throw new Error('Too many redirects.');
}

async function readLimited(response, limit) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error(`File exceeded the ${Math.round(limit / 1024 / 1024)} MB limit.`);
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks);
}

function headersToObject(headers) {
  const out = {};
  headers.forEach((value, key) => { out[key] = value; });
  return out;
}

function contentTypeExt(contentType) {
  const type = (contentType || '').split(';')[0].trim().toLowerCase();
  const mediaTypeExtension = identifyMedia({ contentType: type })?.extension;
  if (mediaTypeExtension) return mediaTypeExtension;
  return {
    'text/css': '.css',
    'text/javascript': '.js',
    'application/javascript': '.js',
    'application/x-javascript': '.js',
    'application/json': '.json',
    'application/manifest+json': '.webmanifest',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/x-icon': '.ico',
    'font/woff': '.woff',
    'font/woff2': '.woff2',
    'font/ttf': '.ttf',
    'font/otf': '.otf',
    'application/pdf': '.pdf'
  }[type] || '';
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sanitizeSegment(segment) {
  const decoded = safeDecode(segment);
  return decoded.replace(/[<>:"\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_').slice(0, 120) || '_';
}

function localAssetPath(url, contentType = '', preferredExtension = '') {
  const u = new URL(url);
  const host = sanitizeSegment(u.hostname);
  const parts = u.pathname.split('/').filter(Boolean).map(sanitizeSegment);
  if (!parts.length || u.pathname.endsWith('/')) parts.push('index');

  let file = parts.pop();
  const hasExt = /\.[a-z0-9]{1,12}$/i.test(file);
  const currentExtension = hasExt ? path.posix.extname(file).toLowerCase() : '';
  if (preferredExtension && currentExtension !== preferredExtension.toLowerCase()) {
    file = hasExt ? file.slice(0, -currentExtension.length) : file;
    file += preferredExtension.toLowerCase();
  }
  const hasFinalExtension = /\.[a-z0-9]{1,12}$/i.test(file);
  const ext = hasFinalExtension ? '' : contentTypeExt(contentType);
  const queryHash = u.search ? `.${crypto.createHash('sha1').update(u.search).digest('hex').slice(0, 10)}` : '';
  file = `${file}${queryHash}${ext || (hasFinalExtension ? '' : '.bin')}`;
  return path.posix.join('assets', host, ...parts, file);
}

function localPagePath(url) {
  const u = new URL(url);
  const parts = u.pathname.split('/').filter(Boolean).map(sanitizeSegment).filter(part => part !== '.' && part !== '..');
  const last = parts[parts.length - 1] || '';
  if (!last || !/\.[a-z0-9]{1,12}$/i.test(last)) {
    const queryHash = u.search ? `.${crypto.createHash('sha1').update(u.search).digest('hex').slice(0, 10)}` : '';
    parts.push(`index${queryHash}.html`);
  } else if (u.search) {
    parts[parts.length - 1] = last.replace(/(\.[^.]+)$/, `.${crypto.createHash('sha1').update(u.search).digest('hex').slice(0, 10)}$1`);
  }
  return path.posix.join('pages', ...parts);
}

function classifyHtmlAttr(tag, attr, attrsText, value) {
  const rel = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrsText || '');
  const as = /\bas\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrsText || '');
  const relValue = ((rel && (rel[1] || rel[2] || rel[3])) || '').toLowerCase();
  const asValue = ((as && (as[1] || as[2] || as[3])) || '').toLowerCase();
  const lowerTag = tag.toLowerCase();
  const lowerAttr = attr.toLowerCase();

  if (lowerTag === 'script' && lowerAttr === 'src') return 'script';
  if (lowerTag === 'link' && relValue.includes('stylesheet')) return 'stylesheet';
  if (lowerTag === 'link' && /(icon|apple-touch-icon|manifest|preload|modulepreload|prefetch|mask-icon)/.test(relValue)) {
    return asValue || (relValue.includes('manifest') ? 'manifest' : 'linked resource');
  }
  if (['poster', 'srcset', 'data-poster', 'data-srcset'].includes(lowerAttr)) return 'image/media';
  if (['video', 'audio', 'source', 'track', 'embed', 'object'].includes(lowerTag)) return 'media';
  if (['img', 'picture'].includes(lowerTag)) return 'image/media';
  if (identifyMedia({ url: value })) return 'media';
  if (/\.(css|js|mjs|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|mp4|m4v|m4a|m4s|mov|mkv|webm|weba|mp3|wav|ogg|oga|opus|aac|flac|mpeg|mpg|ts|m2ts|m3u8|mpd|vtt|srt|pdf)(?:[?#]|$)/i.test(value)) return 'linked resource';
  return 'external dependency';
}

function parseSrcset(value, base) {
  return value.split(',')
    .map(part => part.trim().split(/\s+/)[0])
    .map(candidate => resolveUrl(candidate, base))
    .filter(Boolean);
}

function discoverCssResources(css, baseUrl, origin, depth) {
  const resources = [];
  const urlRe = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]+))\s*\)/gi;
  const importRe = /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^)'";\s]+))/gi;
  let match;

  while ((match = urlRe.exec(css))) {
    const url = resolveUrl(match[1] || match[2] || match[3], baseUrl);
    if (url) resources.push({ url, kind: 'css referenced asset', origin, depth });
  }
  while ((match = importRe.exec(css))) {
    const url = resolveUrl(match[1] || match[2] || match[3], baseUrl);
    if (url) resources.push({ url, kind: 'stylesheet', origin, depth: depth + 1 });
  }
  return resources;
}

function discoverHtmlResources(html, baseUrl, origin) {
  const resources = [];
  const pages = [];
  const external = [];
  const attrRe = /<([a-zA-Z][\w:-]*)([^>]*?)\s(src|href|data|poster|action|srcset|data-src|data-original|data-lazy-src|data-srcset|data-poster|data-video|data-video-src|data-hls|data-dash|data-url|data-file)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let match;

  while ((match = attrRe.exec(html))) {
    const [, tag, attrsText, attr, , v1, v2, v3] = match;
    const rawValue = v1 || v2 || v3 || '';
    const lowerAttr = attr.toLowerCase();
    const kind = classifyHtmlAttr(tag, attr, attrsText, rawValue);
    const urls = ['srcset', 'data-srcset'].includes(lowerAttr) ? parseSrcset(rawValue, baseUrl) : [resolveUrl(rawValue, baseUrl)].filter(Boolean);
    for (const url of urls) {
      const isPageLink = ['a', 'area'].includes(tag.toLowerCase()) && lowerAttr === 'href' &&
        new URL(url).origin === new URL(baseUrl).origin &&
        !/\.(css|js|mjs|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|mp4|m4v|m4a|m4s|mov|mkv|webm|weba|mp3|wav|ogg|oga|opus|aac|flac|mpeg|mpg|ts|m2ts|m3u8|mpd|vtt|srt|pdf)(?:[?#]|$)/i.test(url);
      if (isPageLink) pages.push({ url, kind: 'page', origin });
      else if (kind === 'external dependency') external.push({ url, kind, origin, reason: 'linked page, form action, or non-asset reference' });
      else resources.push({ url, kind, origin });
    }
  }

  const styleAttrRe = /\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi;
  while ((match = styleAttrRe.exec(html))) {
    for (const url of discoverCssResources(match[2] || match[3] || '', baseUrl, origin, 0)) resources.push(url);
  }

  const styleTagRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  while ((match = styleTagRe.exec(html))) {
    for (const url of discoverCssResources(match[1] || '', baseUrl, origin, 0)) resources.push(url);
  }

  const apiRe = /\b(?:fetch|axios\.(?:get|post|put|patch|delete)|XMLHttpRequest|navigator\.sendBeacon)\s*\(/g;
  const dynamicHints = [];
  while ((match = apiRe.exec(html))) dynamicHints.push({ origin, hint: match[0].trim(), index: match.index });

  // Apple and modern scroll-driven video basepaths (data-inline-media-basepath, data-video-basepath, etc.)
  const appleBasepathRe = /data-(?:inline-media-basepath|video-basepath|basepath|anim-basepath|media-basepath)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let bpMatch;
  while ((bpMatch = appleBasepathRe.exec(html))) {
    const rawBp = bpMatch[1] || bpMatch[2] || bpMatch[3] || '';
    if (!rawBp) continue;
    const resolvedBp = resolveUrl(rawBp, baseUrl);
    if (!resolvedBp) continue;
    const normBp = resolvedBp.endsWith('/') ? resolvedBp : resolvedBp + '/';

    const variants = ['large.mp4', 'large.mov', 'large.webm', 'medium.mp4'];
    for (const v of variants) {
      resources.push({
        url: normBp + v,
        kind: 'media',
        origin: `${origin} (apple-video-basepath: ${rawBp})`,
        appleBasepath: rawBp,
        appleVariant: v
      });
    }
  }

  resources.push(...detectMediaUrls(html, baseUrl, origin));
  return { resources, pages, external, dynamicHints };
}

function detectApiRequests(source, baseUrl, origin) {
  const out = [];
  const literalRe = /\b(?:fetch|axios\.(?:get|post|put|patch|delete)|open|sendBeacon)\s*\(\s*(['"])(.*?)\1/gi;
  let match;
  while ((match = literalRe.exec(source))) {
    const url = resolveUrl(match[2], baseUrl);
    out.push({ origin, expression: match[0].slice(0, 80), url: url || match[2] });
  }
  return out;
}

function detectMediaUrls(source, baseUrl, origin) {
  const out = [];
  const seen = new Set();
  const mediaExt = /\.(mp4|m4v|m4a|m4s|mov|mkv|webm|weba|mp3|wav|ogg|oga|opus|aac|flac|mpeg|mpg|ts|m2ts|m3u8|mpd|vtt|srt)(?:[?#]|$)/i;

  function tryAdd(raw) {
    if (!raw || raw.length < 4 || raw.length > 2048) return;
    const clean = raw.split('\\/').join('/').split('\\n').join('').split('\\t').join('').split('\\r').join('');
    const url = resolveUrl(clean, baseUrl);
    if (!url) return;
    const u = new URL(url);
    if (!mediaExt.test(u.pathname + u.search) || seen.has(url)) return;
    seen.add(url);
    out.push({ url, kind: 'media', origin });
  }

  // Standard string literals (single, double, backtick)
  const literalRe = /(["'`])([^"'`\r\n]{4,2048})\1/g;
  let match;
  while ((match = literalRe.exec(source))) tryAdd(match[2]);

  // JSON-style: "src":"url" or "url":"url" or "file":"url"
  const jsonKeyRe = /"(?:src|url|file|video|source|href|path|asset|media|poster|mp4|webm|hls|dash|stream)"\s*:\s*"([^"]{4,2048})"/gi;
  while ((match = jsonKeyRe.exec(source))) tryAdd(match[1]);

  // data-* attributes embedded in JS: data-src="url"
  const dataAttrRe = /data-(?:src|video|url|file|hls|dash|mp4)=["']([^"']{4,2048})["']/gi;
  while ((match = dataAttrRe.exec(source))) tryAdd(match[1]);

  // Template literals with media extensions: `...something.mp4...`
  const tplRe = /`([^`\r\n]{4,2048})`/g;
  while ((match = tplRe.exec(source))) {
    // Check if this template literal itself contains a media URL segment
    const raw = match[1];
    if (mediaExt.test(raw)) {
      // Extract path-like segments from template strings
      const pathRe = /([a-zA-Z0-9/_.-]{4,512}\.(mp4|m4v|webm|mov|m3u8|mpd|mkv|m4s|ts|flac|mp3|aac|wav|ogg))/gi;
      let pm;
      while ((pm = pathRe.exec(raw))) tryAdd(pm[1]);
    }
  }

  // Concatenated URL fragments: "/videos/" + name + ".mp4"
  const concatRe = /["'](\/[a-zA-Z0-9/_-]{1,200})["']\s*\+\s*[^+;,)\]]{1,80}\s*\+\s*["'](\.(?:mp4|webm|mov|m4v|m3u8|mpd|mkv))["']/gi;
  while ((match = concatRe.exec(source))) {
    // We can only capture the base path; mark it as a potential fragment
    // but try to resolve known static parts
    const base = match[1] + match[2];
    tryAdd(base);
  }

  // Apple animation basepaths embedded in JS
  const appleAnimRe = /["'](\/[0-9]+\/media\/[a-zA-Z0-9/_-]+\/anim\/[a-zA-Z0-9/_-]+\/?)["']/gi;
  while ((match = appleAnimRe.exec(source))) {
    const norm = match[1].endsWith('/') ? match[1] : match[1] + '/';
    ['large.mp4', 'medium.mp4', 'small.mp4', 'xlarge.mp4'].forEach(v => tryAdd(norm + v));
  }

  return out;
}

function uniqueKey(url) {
  const u = new URL(url);
  u.hash = '';
  return u.href;
}

function enqueue(queue, seen, item, manifest, mediaSeen) {
  const key = uniqueKey(item.url);
  if (seen.has(key)) return;
  const isMedia = item.kind === 'media' || item.kind === 'media segment' || item.kind === 'media playlist' || Boolean(identifyMedia({ url: key }));
  const isEssentialCode = item.kind === 'script' || item.kind === 'stylesheet' || /\.(js|mjs|css)(?:[?#]|$)/i.test(key);

  // Media has its own independent limit so it never gets blocked by images/CSS/JS
  if (isMedia) {
    if (mediaSeen) {
      if (mediaSeen.has(key)) return;
      if (mediaSeen.size >= MAX_MEDIA_FILES) {
        manifest.skipped.push({ url: item.url, kind: item.kind, origin: item.origin, reason: `media file limit of ${MAX_MEDIA_FILES} reached` });
        return;
      }
      mediaSeen.add(key);
    }
  } else if (!isEssentialCode) {
    // Non-media and non-code resources (images/fonts) have a separate cap
    const nonMediaCount = seen.size - (mediaSeen ? mediaSeen.size : 0);
    if (nonMediaCount >= MAX_NON_MEDIA_RESOURCES) {
      manifest.skipped.push({ url: item.url, kind: item.kind, origin: item.origin, reason: `asset limit of ${MAX_NON_MEDIA_RESOURCES} reached` });
      return;
    }
    if (seen.size >= MAX_RESOURCES) {
      manifest.skipped.push({ url: item.url, kind: item.kind, origin: item.origin, reason: `resource limit of ${MAX_RESOURCES} reached` });
      return;
    }
  }

  seen.add(key);
  const queued = { ...item, url: key };
  if (isMedia) {
    queue.unshift(queued); // media goes to the front
  } else if (isEssentialCode) {
    const insertIdx = queue.findIndex(q => q.kind !== 'media' && q.kind !== 'media segment' && q.kind !== 'media playlist');
    if (insertIdx === -1) queue.push(queued);
    else queue.splice(insertIdx, 0, queued);
  } else {
    queue.push(queued);
  }

  // HLS-to-MP4 fallback: when we find an .m3u8 playlist, also try the direct .mp4
  // Apple always provides a direct MP4 alongside their HLS streams
  if (isMedia && /\.m3u8(?:[?#]|$)/i.test(key)) {
    const mp4Fallback = key.replace(/\.m3u8(.*)/i, '.mp4');
    const mp4Key = uniqueKey(mp4Fallback);
    if (!seen.has(mp4Key) && (!mediaSeen || !mediaSeen.has(mp4Key))) {
      const mp4Item = { url: mp4Fallback, kind: 'media', origin: item.origin + ' (mp4-fallback)' };
      seen.add(mp4Key);
      if (mediaSeen) mediaSeen.add(mp4Key);
      queue.unshift({ ...mp4Item, url: mp4Key });
    }
    // Also try .m4v variant
    const m4vFallback = key.replace(/\.m3u8(.*)/i, '.m4v');
    const m4vKey = uniqueKey(m4vFallback);
    if (!seen.has(m4vKey) && (!mediaSeen || !mediaSeen.has(m4vKey))) {
      seen.add(m4vKey);
      if (mediaSeen) mediaSeen.add(m4vKey);
      queue.unshift({ url: m4vKey, kind: 'media', origin: item.origin + ' (m4v-fallback)' });
    }
  }
}

function enqueuePage(queue, seen, item, allowedOrigin, manifest) {
  const key = uniqueKey(item.url);
  if (new URL(key).origin !== allowedOrigin || seen.has(key)) return;
  if (seen.size >= MAX_PAGES) {
    manifest.skipped.push({ url: key, kind: 'page', origin: item.origin, reason: `page limit of ${MAX_PAGES} reached` });
    return;
  }
  seen.add(key);
  queue.push({ ...item, url: key });
}

function makeDirsForFile(filePath) {
  return fs.mkdir(path.dirname(filePath), { recursive: true });
}

function rewriteCss(css, baseUrl, urlMap) {
  const replaceOne = raw => {
    const resolved = resolveUrl(raw, baseUrl);
    if (!resolved) return raw;
    const key = uniqueKey(resolved);
    return urlMap.has(key) ? urlMap.get(key) : resolved;
  };

  return css
    .replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]+))\s*\)/gi, (full, a, b, c) => `url("${replaceOne(a || b || c)}")`)
    .replace(/@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^)'";\s]+))\s*\)?/gi, (full, a, b, c) => `@import "${replaceOne(a || b || c)}"`);
}

function rewriteSrcset(value, baseUrl, urlMap) {
  return value.split(',').map(part => {
    const trimmed = part.trim();
    if (!trimmed) return part;
    const pieces = trimmed.split(/\s+/);
    const resolved = resolveUrl(pieces[0], baseUrl);
    if (resolved) {
      const key = uniqueKey(resolved);
      pieces[0] = urlMap.has(key) ? urlMap.get(key) : resolved;
    }
    return pieces.join(' ');
  }).join(', ');
}

function rewriteHtml(html, baseUrl, urlMap) {
  let rewritten = html.replace(/<([a-zA-Z][\w:-]*)([^>]*?)\s(src|href|data|poster|action|srcset|data-src|data-original|data-lazy-src|data-srcset|data-poster|data-video|data-video-src|data-hls|data-dash|data-url|data-file|data-inline-media-basepath|data-video-basepath|data-basepath|data-anim-basepath|data-media-basepath)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (full, tag, before, attr, quoted, v1, v2, v3) => {
      const raw = v1 || v2 || v3 || '';
      let next = raw;
      if (['srcset', 'data-srcset'].includes(attr.toLowerCase())) {
        next = rewriteSrcset(raw, baseUrl, urlMap);
      } else {
        const resolved = resolveUrl(raw, baseUrl);
        if (resolved) {
          const key = uniqueKey(resolved);
          next = urlMap.has(key) ? urlMap.get(key) : (urlMap.has(raw) ? urlMap.get(raw) : resolved);
        } else if (urlMap.has(raw)) {
          next = urlMap.get(raw);
        }
      }
      const quote = quoted.startsWith("'") ? "'" : '"';
      return `<${tag}${before} ${attr}=${quote}${next}${quote}`;
    });

  rewritten = rewritten.replace(/\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi, (full, quoted, v1, v2) => {
    const quote = quoted.startsWith("'") ? "'" : '"';
    return ` style=${quote}${rewriteCss(v1 || v2 || '', baseUrl, urlMap)}${quote}`;
  });

  rewritten = rewritten.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (full, attrs, css) => {
    return `<style${attrs}>${rewriteCss(css, baseUrl, urlMap)}</style>`;
  });

  // Enhance all <video> elements with offline fallback <source> and attributes
  rewritten = rewritten.replace(/<video\b([^>]*?)>([\s\S]*?)<\/video>/gi, (fullVideo, attrs, inner) => {
    let newAttrs = attrs;
    let newInner = inner;

    const bpMatch = /data-(?:inline-media-basepath|video-basepath|basepath|media-basepath)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const bp = bpMatch ? (bpMatch[1] || bpMatch[2] || bpMatch[3]) : '';

    if (!inner.includes('<source')) {
      if (bp) {
        const cleanBp = bp.endsWith('/') ? bp : bp + '/';
        newInner = `\n  <source src="${cleanBp}large.mp4" type="video/mp4" data-offline-injected="true">` +
          `\n  <source src="${cleanBp}large.webm" type="video/webm" data-offline-injected="true">` +
          `\n  <source src="${cleanBp}large.mov" type="video/quicktime" data-offline-injected="true">\n` + inner;
      }
    }

    if (!/\bplaysinline\b/i.test(newAttrs)) newAttrs += ' playsinline';
    if (!/\bmuted\b/i.test(newAttrs)) newAttrs += ' muted';
    if (/\bpreload\s*=\s*["']none["']/i.test(newAttrs)) {
      newAttrs = newAttrs.replace(/\bpreload\s*=\s*["']none["']/gi, 'preload="metadata"');
    }

    return `<video${newAttrs}>${newInner}</video>`;
  });

  const helperScript = `
<script data-offline-vfx-helper="true">
(function() {
  function initOfflineMedia() {
    var videos = document.querySelectorAll('video');
    videos.forEach(function(video) {
      video.muted = true;
      video.playsInline = true;
      video.setAttribute('muted', '');
      video.setAttribute('playsinline', '');

      var bp = video.getAttribute('data-inline-media-basepath') || video.getAttribute('data-video-basepath') || video.getAttribute('data-basepath');
      if (!video.src && !video.querySelector('source') && bp) {
        var norm = bp.endsWith('/') ? bp : bp + '/';
        ['large.mp4', 'large.webm', 'large.mov'].forEach(function(fn) {
          var s = document.createElement('source');
          s.src = norm + fn;
          s.type = fn.endsWith('.mp4') ? 'video/mp4' : (fn.endsWith('.webm') ? 'video/webm' : 'video/quicktime');
          video.appendChild(s);
        });
      }

      var container = video.closest('.video-wrapper, .video-scrub-container, .inline-media-component-container, .media');
      function hideOverlays() {
        if (container) {
          var overlays = container.querySelectorAll('.end-frame, .start-frame, .overview-welcome-hero-endframe, .overview-design-design-endframe, .overview-welcome-hero-startframe, .overview-design-design-startframe');
          overlays.forEach(function(el) {
            el.style.opacity = '0';
            el.style.pointerEvents = 'none';
          });
        }
      }

      video.addEventListener('loadeddata', hideOverlays);
      video.addEventListener('canplay', hideOverlays);
      video.addEventListener('play', hideOverlays);
      video.addEventListener('timeupdate', function() {
        if (video.currentTime > 0.05) hideOverlays();
      });

      var isScrub = (video.id && video.id.toLowerCase().indexOf('scrub') !== -1) ||
                    video.getAttribute('data-video-load-kf') ||
                    video.getAttribute('data-video-progress-kf-l1') ||
                    video.getAttribute('data-video-progress-kf-1');

      if (isScrub) {
        video.pause();
        function updateScrub() {
          var targetEl = container || video;
          var rect = targetEl.getBoundingClientRect();
          var winH = window.innerHeight;
          var total = rect.height + winH;
          var current = winH - rect.top;
          var progress = Math.max(0, Math.min(1, current / total));
          if (video.duration && !isNaN(video.duration) && video.duration > 0) {
            video.currentTime = progress * video.duration;
            hideOverlays();
          }
        }
        window.addEventListener('scroll', updateScrub, { passive: true });
        window.addEventListener('resize', updateScrub, { passive: true });
        video.addEventListener('loadedmetadata', updateScrub);
      } else {
        if ('IntersectionObserver' in window) {
          var obs = new IntersectionObserver(function(entries) {
            entries.forEach(function(entry) {
              if (entry.isIntersecting) {
                video.play().catch(function() {});
                hideOverlays();
              } else {
                video.pause();
              }
            });
          }, { threshold: 0.1 });
          obs.observe(video);
        }
      }
    });

    // Cross-window sync scrolling listener
    window.addEventListener('message', function(e) {
      if (e.data && e.data.type === 'scroll' && e.data.from === 'live') {
        var max = document.documentElement.scrollHeight - window.innerHeight;
        if (max > 0) window.scrollTo(0, e.data.ratio * max);
      }
    });
    window.addEventListener('scroll', function() {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      var ratio = max > 0 ? window.scrollY / max : 0;
      window.parent.postMessage({ type: 'scroll', from: 'offline', ratio: ratio }, '*');
    }, { passive: true });

    // Offline Intro & Preloader Safety Shield
    function dismissStuckIntro() {
      var introSelectors = [
        '[class*="fixed"][class*="inset-0"]',
        '[data-component="intro"]',
        '.intro',
        '.loader',
        '.preloader',
        '.splash',
        '#preloader',
        '#loader',
        '[class*="preloader"]',
        '[class*="loader-overlay"]',
        '[class*="loading-overlay"]'
      ];
      introSelectors.forEach(function(sel) {
        document.querySelectorAll(sel).forEach(function(el) {
          var text = (el.innerText || '').toLowerCase();
          var isOverlay = el.classList.contains('intro') || 
                          el.getAttribute('data-component') === 'intro' || 
                          text.indexOf('loading') !== -1 ||
                          /^\s*\d+%\s*$/.test(text);
          if (isOverlay) {
            el.style.transition = 'opacity 0.5s ease';
            el.style.opacity = '0';
            el.style.pointerEvents = 'none';
            setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 600);
          }
        });
      });

      // Reveal content that starts hidden at opacity: 0 due to client-side animation libraries (e.g. Framer Motion, GSAP)
      document.querySelectorAll('*').forEach(function(el) {
        var s = el.getAttribute('style') || '';
        if (/opacity\s*:\s*0(?:\.0*)?(?:;|$)/i.test(s)) {
          el.style.opacity = '1';
          if (/transform\s*:\s*translateY/i.test(s)) {
            el.style.transform = 'none';
          }
        }
        if (/visibility\s*:\s*hidden/i.test(s)) {
          el.style.visibility = 'visible';
        }
      });
    }

    // Dismiss preloader after brief delay if JS animation hasn't finished
    setTimeout(dismissStuckIntro, 1800);

    // Floating Skip Intro / Show Content button for instant manual dismissal
    try {
      var btn = document.createElement('button');
      btn.setAttribute('data-offline-skip-intro', 'true');
      btn.textContent = '⚡ Skip Intro / Reveal Content';
      btn.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:999999;background:rgba(15,23,42,0.92);color:#38bdf8;border:1px solid #0284c7;padding:8px 14px;border-radius:20px;font-size:12px;font-weight:600;font-family:sans-serif;cursor:pointer;backdrop-filter:blur(8px);box-shadow:0 4px 14px rgba(0,0,0,0.5);transition:all .2s;';
      btn.onmouseover = function() { btn.style.background = '#0284c7'; btn.style.color = '#fff'; };
      btn.onmouseout = function() { btn.style.background = 'rgba(15,23,42,0.92)'; btn.style.color = '#38bdf8'; };
      btn.onclick = function() {
        dismissStuckIntro();
        btn.style.display = 'none';
      };
      document.body.appendChild(btn);
      setTimeout(function() { if (btn.parentNode) btn.style.opacity = '0.4'; }, 6000);
    } catch(e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initOfflineMedia);
  } else {
    initOfflineMedia();
  }
})();
</script>`;

  if (rewritten.includes('</body>')) {
    rewritten = rewritten.replace('</body>', helperScript + '\n</body>');
  } else {
    rewritten += helperScript;
  }

  return rewritten;
}

function discoverPlaylistResources(content, baseUrl, origin, isDash = false) {
  const resources = [];
  const add = (raw, kind) => {
    const url = resolveUrl(raw, baseUrl);
    if (url) resources.push({ url, kind, origin });
  };
  if (isDash) {
    for (const match of content.matchAll(/<BaseURL[^>]*>([^<]+)<\/BaseURL>|\b(?:media|initialization|sourceURL)\s*=\s*(["'])(.*?)\2/gi)) {
      add(match[1] || match[3], 'media segment');
    }
    return resources;
  }

  for (const match of content.matchAll(/\bURI\s*=\s*(["'])(.*?)\1/gi)) add(match[2], 'media segment');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) add(trimmed, /\.m3u8(?:[?#]|$)/i.test(trimmed) ? 'media playlist' : 'media segment');
  }
  return resources;
}

function rewritePlaylist(content, baseUrl, urlMap) {
  const replaceUrl = raw => {
    const resolved = resolveUrl(raw, baseUrl);
    if (!resolved) return raw;
    const key = uniqueKey(resolved);
    return urlMap.get(key) || resolved;
  };
  return content
    .replace(/(\bURI\s*=\s*)(["'])(.*?)\2/gi, (full, prefix, quote, raw) => `${prefix}${quote}${replaceUrl(raw)}${quote}`)
    .replace(/(<BaseURL[^>]*>)([^<]+)(<\/BaseURL>)/gi, (full, before, raw, after) => `${before}${replaceUrl(raw)}${after}`)
    .replace(/^(?!\s*#)(\s*)([^\r\n]+)(\s*)$/gm, (full, before, raw, after) => `${before}${replaceUrl(raw.trim())}${after}`);
}

function relativeUrlMap(fromLocalFile, urlMap) {
  const fromDir = path.posix.dirname(fromLocalFile);
  const adjusted = new Map();
  for (const [url, localPath] of urlMap.entries()) {
    let relative = path.posix.relative(fromDir, localPath);
    if (!relative) relative = path.posix.basename(localPath);
    adjusted.set(url, relative);
  }
  return adjusted;
}

async function tryRenderWithPlaywright(url, outputDir, manifest) {
  let chromium;
  try {
    chromium = require('playwright-core').chromium;
  } catch {
    try {
      chromium = require('playwright').chromium;
    } catch {
      manifest.skipped.push({
        url,
        kind: 'rendered DOM',
        reason: 'Playwright is not installed. Install playwright-core to enable JavaScript rendering.'
      });
      return null;
    }
  }

  const mediaExt = /\.(mp4|m4v|m4a|m4s|mov|mkv|webm|weba|mp3|wav|ogg|oga|opus|aac|flac|mpeg|mpg|ts|m2ts|m3u8|mpd|vtt|srt)(?:[?#]|$)/i;

  let browser;
  const apiRequests = [];
  const failedRequests = [];
  const interceptedMediaUrls = new Set();

  try {
    const chromePath = findChromeExecutable();
    const launchOpts = {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
    };
    if (chromePath) launchOpts.executablePath = chromePath;

    browser = await chromium.launch(launchOpts);
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 900 },
      extraHTTPHeaders: { 'Accept': '*/*' }
    });
    const page = await context.newPage();

    // Intercept ALL network requests to capture media/video URLs
    page.on('request', req => {
      const reqUrl = req.url();
      const resourceType = req.resourceType();

      if (resourceType === 'media' || resourceType === 'video' || resourceType === 'audio') {
        interceptedMediaUrls.add(reqUrl);
      } else if (['xhr', 'fetch', 'websocket', 'eventsource'].includes(resourceType)) {
        apiRequests.push({ url: reqUrl, method: req.method(), type: resourceType });
        if (mediaExt.test(new URL(reqUrl).pathname)) interceptedMediaUrls.add(reqUrl);
      } else if (resourceType === 'other' || resourceType === 'document') {
        if (mediaExt.test(new URL(reqUrl).pathname)) interceptedMediaUrls.add(reqUrl);
      }
    });

    page.on('requestfailed', req => {
      failedRequests.push({
        url: req.url(),
        method: req.method(),
        type: req.resourceType(),
        failure: req.failure() && req.failure().errorText
      });
    });

    // Navigate with domcontentloaded so long-running analytics/telemetry streams don't hang
    let response = null;
    try {
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    } catch (navErr) {
      // Continue even if navigation had a soft timeout
    }

    // Allow time for SPA hydration and intro animations to initiate
    await page.waitForTimeout(3000);

    // Auto-advance or skip intro animations if a skip button or preloader is present
    try {
      await page.evaluate(() => {
        const skipButtons = document.querySelectorAll('button, a, [role="button"]');
        for (const b of skipButtons) {
          const t = (b.textContent || '').trim().toLowerCase();
          if (t === 'skip' || t === 'skip intro' || t.includes('skip intro')) {
            b.click();
            break;
          }
        }
      });
    } catch {}

    // Auto-scroll the page to trigger lazy-loaded/scroll-driven animations and videos
    try {
      const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      const viewportHeight = await page.evaluate(() => window.innerHeight);
      const scrollStep = Math.max(300, Math.floor(viewportHeight * 0.6));
      let currentPos = 0;

      while (currentPos < pageHeight && currentPos < 15000) {
        currentPos += scrollStep;
        await page.evaluate(pos => window.scrollTo({ top: pos, behavior: 'smooth' }), currentPos);
        await page.waitForTimeout(250);
      }

      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await page.waitForTimeout(600);
    } catch (scrollError) {
      // Scrolling failed silently; continue
    }

    // Extract all <video>, <source>, and media-carrying elements from the live DOM
    const domMediaUrls = await page.evaluate(() => {
      const urls = new Set();

      document.querySelectorAll('video[src], audio[src]').forEach(el => {
        if (el.src) urls.add(el.src);
        if (el.currentSrc) urls.add(el.currentSrc);
        if (el.dataset.src) urls.add(el.dataset.src);
      });

      document.querySelectorAll('video source, audio source').forEach(el => {
        if (el.src) urls.add(el.src);
        if (el.dataset.src) urls.add(el.dataset.src);
      });

      const videoDataAttrs = [
        'data-src', 'data-video', 'data-video-src', 'data-hls', 'data-dash',
        'data-url', 'data-file', 'data-mp4', 'data-webm', 'data-poster'
      ];
      document.querySelectorAll('*').forEach(el => {
        videoDataAttrs.forEach(attr => {
          const val = el.getAttribute(attr);
          if (val && /https?:\/\/|^\//.test(val)) urls.add(val);
        });
      });

      document.querySelectorAll('[style]').forEach(el => {
        const style = el.getAttribute('style') || '';
        const urlMatch = /url\(["']?([^"')]+)["']?\)/g;
        let m;
        while ((m = urlMatch.exec(style))) urls.add(m[1]);
      });

      return Array.from(urls).filter(u => u && u.startsWith('http'));
    });

    const html = await page.content();
    manifest.apiRequests.push(...apiRequests);
    manifest.failedBrowserRequests.push(...failedRequests);
    const renderedUrl = page.url();
    await browser.close();

    domMediaUrls.forEach(u => interceptedMediaUrls.add(u));

    return {
      html,
      status: response ? response.status() : 200,
      finalUrl: renderedUrl,
      path: path.join(outputDir, 'rendered-dom', 'rendered.html'),
      interceptedMediaUrls: Array.from(interceptedMediaUrls)
    };
  } catch (error) {
    if (browser) await browser.close().catch(() => { });
    manifest.failed.push({ url, kind: 'rendered DOM', error: error.message });
    return null;
  }
}

function crc32(buffer) {
  const table = crc32.table || (crc32.table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    return c >>> 0;
  }));
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const year = Math.max(date.getFullYear() - 1980, 0);
  return { time, date: (year << 9) | (month << 5) | day };
}

async function listFiles(root, dir = root) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, full));
    else files.push(full);
  }
  return files;
}

async function createZip(sourceDir, zipPath) {
  const files = (await listFiles(sourceDir)).filter(file => !file.endsWith('.zip'));
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const stamp = dosDateTime();

  for (const file of files) {
    const name = path.relative(sourceDir, file).split(path.sep).join('/');
    const nameBuffer = Buffer.from(name);
    const data = await fs.readFile(file);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  await fs.writeFile(zipPath, Buffer.concat([...localParts, ...centralParts, end]));
}

function completenessReport({ target, finalUrl, manifest, downloadedCount, totalCandidates, rendered, interceptedMediaCount }) {
  const missing = manifest.failed.length + manifest.skipped.length;
  const externalCount = manifest.externalDependencies.length;
  const apiCount = manifest.apiRequests.length + manifest.detectedApiCalls.length;
  const authHints = manifest.responses.filter(r => [401, 403].includes(r.status));
  const browserCaptured = manifest.downloaded.filter(item => item.origin === 'playwright-intercepted').length;

  return [
    '# Grabb Completeness Report',
    '',
    `Target URL: ${target}`,
    `Final server-response URL: ${finalUrl}`,
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Summary',
    '',
    `Downloaded resources: ${downloadedCount}`,
    `Archived same-site pages: ${(manifest.archivedPages || []).length}`,
    `Downloaded media files: ${manifest.downloaded.filter(item => item.kind === 'media').length}`,
    `Video formats: ${manifest.downloaded.filter(item => item.mediaCategory === 'video').length}`,
    `Browser-intercepted media (JS/scroll-driven): ${browserCaptured}`,
    `Discovered resource candidates: ${totalCandidates}`,
    `Skipped or failed resources: ${missing}`,
    `External dependencies and navigational references: ${externalCount}`,
    `Detected API or runtime data requests: ${apiCount}`,
    `Rendered DOM saved: ${rendered ? 'yes' : 'no'}`,
    '',
    'This archive is not claimed to be a perfect copy. The original server response is preserved separately from modified offline-ready files.',
    '',
    '## Likely Offline Limitations',
    '',
    missing ? '- Some resources could not be downloaded or were skipped; inspect resource-manifest.json for details.' : '- No resource download failures were recorded within configured limits.',
    externalCount ? '- Some links or dependencies still point outside the archive.' : '- No external non-asset dependencies were recorded by the static scanner.',
    apiCount ? '- Runtime API/fetch/XHR calls were detected; dynamic data may not work offline.' : '- No obvious runtime API calls were detected by static/browser observation.',
    authHints.length ? '- One or more resources returned 401/403, indicating authentication, authorization, anti-bot, or access-control requirements.' : '- No fetched resource returned 401/403.',
    rendered ? `- A browser-rendered DOM snapshot is included. The page was auto-scrolled to trigger lazy-loaded and scroll-driven animations (${browserCaptured} browser-intercepted media URLs captured).` : '- JavaScript rendering was not available or failed; only the original server response was used for offline HTML.',
    `- Media transfers are limited to ${Math.round(MEDIA_MAX_BYTES / 1024 / 1024)} MB each, ${MAX_MEDIA_FILES} files, and ${Math.round(TOTAL_DOWNLOAD_MAX_BYTES / 1024 / 1024)} MB combined.`,
    '- Scroll-triggered animations that depend on continuous scrolling behavior may not replay identically offline without a live page environment.',
    '',
    '## Security and Access Notes',
    '',
    '- Localhost, private-network, credentialed, non-HTTP, and redirect destinations to blocked networks are rejected.',
    '- The extractor does not attempt to bypass logins, paywalls, bot protections, robots restrictions, or other access controls.',
    '- Size limits and request timeouts may intentionally omit very large or slow resources.'
  ].join('\n');
}

async function extractWebsite(targetUrl, onProgress = () => {}) {
  const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const outputDir = path.join(EXPORTS_DIR, id);
  const originalDir = path.join(outputDir, 'original-source');
  const offlineDir = path.join(outputDir, 'offline-ready-copy');
  const reportsDir = path.join(outputDir, 'reports');
  await fs.mkdir(originalDir, { recursive: true });
  await fs.mkdir(offlineDir, { recursive: true });
  await fs.mkdir(reportsDir, { recursive: true });

  const manifest = {
    targetUrl,
    generatedAt: new Date().toISOString(),
    limits: {
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      mediaRequestTimeoutMs: MEDIA_REQUEST_TIMEOUT_MS,
      htmlMaxBytes: HTML_MAX_BYTES,
      resourceMaxBytes: RESOURCE_MAX_BYTES,
      mediaMaxBytes: MEDIA_MAX_BYTES,
      totalDownloadMaxBytes: TOTAL_DOWNLOAD_MAX_BYTES,
      maxResources: MAX_RESOURCES,
      maxMediaFiles: MAX_MEDIA_FILES,
      maxPages: MAX_PAGES
    },
    archivedPages: [],
    downloaded: [],
    skipped: [],
    failed: [],
    externalDependencies: [],
    detectedApiCalls: [],
    apiRequests: [],
    failedBrowserRequests: [],
    redirects: [],
    responses: []
  };

  onProgress({ phase: 'connecting', message: 'Connecting to target website...' });
  const target = await validateUrl(targetUrl);
  const initial = await safeFetch(target.href, target.href, manifest, 'html');
  manifest.redirects.push(...initial.redirects);
  const response = initial.response;
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) throw new Error(`Target returned HTTP ${response.status} ${response.statusText}`);
  if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    throw new Error(`URL did not return HTML (content-type: ${contentType || 'unknown'}).`);
  }

  const htmlBuffer = await readLimited(response, HTML_MAX_BYTES);
  const html = htmlBuffer.toString('utf8');
  const finalUrl = initial.finalUrl;
  manifest.archivedPages.push({ url: target.href, finalUrl, localPath: 'offline-ready-copy/index.html', status: response.status });
  manifest.responses.push({ url: finalUrl, status: response.status, statusText: response.statusText, contentType, bytes: htmlBuffer.length });

  onProgress({ phase: 'fetched', message: `Fetched main page (${Math.round(htmlBuffer.length / 1024)} KB)`, bytes: htmlBuffer.length });
  await fs.writeFile(path.join(originalDir, 'index.html'), htmlBuffer);
  await fs.writeFile(path.join(originalDir, 'response-headers.json'), JSON.stringify({
    url: finalUrl,
    status: response.status,
    statusText: response.statusText,
    headers: headersToObject(response.headers)
  }, null, 2));

  onProgress({ phase: 'rendering', message: 'Attempting browser rendering (Playwright)...' });
  const rendered = await tryRenderWithPlaywright(finalUrl, outputDir, manifest);
  if (rendered) {
    await makeDirsForFile(rendered.path);
    await fs.writeFile(rendered.path, rendered.html, 'utf8');
    onProgress({ phase: 'rendered', message: 'Browser-rendered DOM captured' });
  } else {
    onProgress({ phase: 'rendered', message: 'Playwright not available, using static HTML' });
  }

  const queue = [];
  const seen = new Set();
  const mediaSeen = new Set(); // tracks media independently so images/CSS can't crowd out videos
  const pageQueue = [];
  const pageSeen = new Set([uniqueKey(finalUrl), uniqueKey(target.href)]);
  const pageContents = [{ html, baseUrl: finalUrl, localPath: 'index.html' }];
  const urlMap = new Map([[uniqueKey(finalUrl), 'index.html'], [uniqueKey(target.href), 'index.html']]);
  const rootOrigin = new URL(finalUrl).origin;
  const firstPass = discoverHtmlResources(html, finalUrl, 'original-source/index.html');
  firstPass.resources.forEach(item => enqueue(queue, seen, item, manifest, mediaSeen));
  firstPass.pages.forEach(item => enqueuePage(pageQueue, pageSeen, item, rootOrigin, manifest));
  manifest.externalDependencies.push(...firstPass.external);
  manifest.detectedApiCalls.push(...firstPass.dynamicHints);
  onProgress({ phase: 'discovered', message: `Discovered ${queue.length} resources and ${pageQueue.length} sub-pages`, resources: queue.length, pages: pageQueue.length });

  if (rendered) {
    const renderedPass = discoverHtmlResources(rendered.html, rendered.finalUrl || finalUrl, 'rendered-dom/rendered.html');
    renderedPass.resources.forEach(item => enqueue(queue, seen, item, manifest, mediaSeen));
    renderedPass.pages.forEach(item => enqueuePage(pageQueue, pageSeen, item, rootOrigin, manifest));
    manifest.externalDependencies.push(...renderedPass.external);
    manifest.detectedApiCalls.push(...renderedPass.dynamicHints);

    // Add all media URLs intercepted by the browser (network-level + DOM-scraped)
    // This captures scroll-triggered and JS-driven video animations (e.g. Apple-style)
    if (rendered.interceptedMediaUrls && rendered.interceptedMediaUrls.length) {
      for (const mediaUrl of rendered.interceptedMediaUrls) {
        try {
          const resolved = resolveUrl(mediaUrl, rendered.finalUrl || finalUrl);
          if (resolved) {
            enqueue(queue, seen, { url: resolved, kind: 'media', origin: 'playwright-intercepted' }, manifest, mediaSeen);
          }
        } catch {
          // skip unresolvable URLs
        }
      }
    }
  }

  onProgress({ phase: 'pages', message: `Downloading ${pageQueue.length} sub-pages...`, total: pageQueue.length });
  let pagesDone = 0;
  while (pageQueue.length) {
    const item = pageQueue.shift();
    try {
      const fetched = await safeFetch(item.url, finalUrl, manifest, 'page');
      manifest.redirects.push(...fetched.redirects);
      const pageResponse = fetched.response;
      const pageType = pageResponse.headers.get('content-type') || '';
      const pageRecord = { url: item.url, finalUrl: fetched.finalUrl, status: pageResponse.status, statusText: pageResponse.statusText, contentType: pageType, kind: 'page' };
      manifest.responses.push(pageRecord);
      if (!pageResponse.ok) {
        manifest.failed.push({ ...pageRecord, error: `HTTP ${pageResponse.status} ${pageResponse.statusText}` });
        continue;
      }
      if (!/text\/html|application\/xhtml\+xml/i.test(pageType)) {
        if (/^(video|audio)\//i.test(pageType) || /application\/octet-stream/i.test(pageType)) {
          enqueue(queue, seen, { url: item.url, kind: 'media', origin: item.origin }, manifest, mediaSeen);
        } else {
          manifest.externalDependencies.push({ url: item.url, kind: 'page', origin: item.origin, reason: `linked route returned ${pageType || 'a non-HTML response'}` });
        }
        continue;
      }

      const pageHtml = (await readLimited(pageResponse, HTML_MAX_BYTES)).toString('utf8');
      const localPath = localPagePath(item.url);
      urlMap.set(uniqueKey(item.url), localPath);
      urlMap.set(uniqueKey(fetched.finalUrl), localPath);
      pageContents.push({ html: pageHtml, baseUrl: fetched.finalUrl, localPath });
      manifest.archivedPages.push({ url: item.url, finalUrl: fetched.finalUrl, localPath: path.posix.join('offline-ready-copy', localPath), status: pageResponse.status });
      pagesDone++;
      onProgress({ phase: 'pages', message: `Downloaded page ${pagesDone}: ${new URL(item.url).pathname}`, done: pagesDone });

      const pagePass = discoverHtmlResources(pageHtml, fetched.finalUrl, localPath);
      pagePass.resources.forEach(resource => enqueue(queue, seen, resource, manifest, mediaSeen));
      pagePass.pages.forEach(page => enqueuePage(pageQueue, pageSeen, page, rootOrigin, manifest));
      manifest.externalDependencies.push(...pagePass.external);
      manifest.detectedApiCalls.push(...pagePass.dynamicHints);
    } catch (error) {
      manifest.failed.push({ url: item.url, kind: 'page', origin: item.origin, error: error.name === 'TimeoutError' ? 'request timed out' : error.message });
    }
  }

  let processed = 0;
  let downloadedMediaCount = 0;
  let downloadedBytes = 0;
  const CONCURRENCY = 10;
  let activeCount = 0;
  const totalResources = queue.length;
  let lastProgressTime = 0;
  onProgress({ phase: 'resources', message: `Downloading ${totalResources} resources...`, total: totalResources, done: 0 });

  async function downloadOne(item) {
    try {
      const fetched = await safeFetch(item.url, finalUrl, manifest, item.kind);
      manifest.redirects.push(...fetched.redirects);
      const resourceResponse = fetched.response;
      const finalResourceUrl = fetched.finalUrl;
      const resourceType = resourceResponse.headers.get('content-type') || '';
      const contentDisposition = resourceResponse.headers.get('content-disposition') || '';
      const initialMediaInfo = identifyMedia({ url: finalResourceUrl, contentType: resourceType, contentDisposition });
      const isImageResponse = /^image\//i.test(resourceType) && !initialMediaInfo;
      const isMediaDownload = !isImageResponse && (item.kind === 'media' || item.kind === 'media segment' || Boolean(initialMediaInfo));
      const statusRecord = {
        url: item.url,
        finalUrl: finalResourceUrl,
        status: resourceResponse.status,
        statusText: resourceResponse.statusText,
        contentType: resourceType,
        kind: item.kind,
        origin: item.origin
      };
      manifest.responses.push(statusRecord);

      if (!resourceResponse.ok) {
        manifest.failed.push({ ...statusRecord, error: `HTTP ${resourceResponse.status} ${resourceResponse.statusText}` });
        return;
      }

      if (isMediaDownload && downloadedMediaCount >= MAX_MEDIA_FILES) {
        manifest.skipped.push({ ...statusRecord, reason: `media file limit of ${MAX_MEDIA_FILES} reached` });
        return;
      }

      const body = await readLimited(resourceResponse, isMediaDownload ? MEDIA_MAX_BYTES : RESOURCE_MAX_BYTES);
      if (downloadedBytes + body.length > TOTAL_DOWNLOAD_MAX_BYTES) {
        manifest.skipped.push({ ...statusRecord, reason: `total downloaded-resource limit of ${Math.round(TOTAL_DOWNLOAD_MAX_BYTES / 1024 / 1024)} MB reached` });
        return;
      }
      const mediaInfo = identifyMedia({ url: finalResourceUrl, contentType: resourceType, contentDisposition, body });
      const localPath = localAssetPath(finalResourceUrl, resourceType, mediaInfo?.extension || '');
      const absolutePath = path.join(offlineDir, localPath);
      await makeDirsForFile(absolutePath);

      if (/text\/css/i.test(resourceType) || /\.css(?:[?#]|$)/i.test(finalResourceUrl)) {
        const cssText = body.toString('utf8');
        const cssResources = discoverCssResources(cssText, finalResourceUrl, localPath, item.depth || 0);
        if ((item.depth || 0) < MAX_CSS_DEPTH) {
          cssResources.forEach(next => enqueue(queue, seen, next, manifest, mediaSeen));
        } else {
          cssResources.forEach(next => manifest.skipped.push({ ...next, reason: `CSS import depth limit of ${MAX_CSS_DEPTH} reached` }));
        }
      }

      const isDash = /application\/dash\+xml/i.test(resourceType) || /\.mpd(?:[?#]|$)/i.test(finalResourceUrl);
      const isHls = /mpegurl/i.test(resourceType) || /\.m3u8(?:[?#]|$)/i.test(finalResourceUrl);
      if (isDash || isHls) {
        const playlistResources = discoverPlaylistResources(body.toString('utf8'), finalResourceUrl, localPath, isDash);
        playlistResources.forEach(next => enqueue(queue, seen, next, manifest, mediaSeen));
      }

      if (/javascript|ecmascript/i.test(resourceType) || /\.(mjs|js)(?:[?#]|$)/i.test(finalResourceUrl)) {
        const script = body.toString('utf8');
        manifest.detectedApiCalls.push(...detectApiRequests(script, finalResourceUrl, localPath));
        detectMediaUrls(script, finalResourceUrl, localPath).forEach(next => enqueue(queue, seen, next, manifest, mediaSeen));
      }

      if (isDash && /<SegmentTemplate\b/i.test(body.toString('utf8'))) {
        manifest.skipped.push({ url: finalResourceUrl, kind: 'media playlist', origin: item.origin, reason: 'DASH SegmentTemplate URLs require runtime substitution and are not expanded.' });
      }

      await fs.writeFile(absolutePath, body);
      downloadedBytes += body.length;
      if (isMediaDownload) downloadedMediaCount++;
      const key = uniqueKey(finalResourceUrl);
      urlMap.set(key, localPath);
      urlMap.set(uniqueKey(item.url), localPath);
      if (item.appleBasepath) {
        const baseDir = path.posix.dirname(localPath) + '/';
        urlMap.set(item.appleBasepath, baseDir);
        const resolvedBp = resolveUrl(item.appleBasepath, finalUrl || target.href);
        if (resolvedBp) {
          urlMap.set(uniqueKey(resolvedBp), baseDir);
          const normBp = resolvedBp.endsWith('/') ? resolvedBp : resolvedBp + '/';
          const exactVar = item.appleVariant || path.posix.basename(localPath);
          urlMap.set(uniqueKey(normBp + exactVar), localPath);
          const bpVariants = ['large.mp4', 'large_2x.mp4', 'medium.mp4', 'small.mp4', 'xlarge.mp4', 'xlarge_2x.mp4', 'medium_2x.mp4', 'small_2x.mp4', 'large.webm', 'large.mov'];
          for (const bv of bpVariants) {
            if (!urlMap.has(uniqueKey(normBp + bv))) {
              urlMap.set(uniqueKey(normBp + bv), localPath);
            }
          }
        }
      }
      manifest.downloaded.push({
        url: item.url,
        finalUrl: finalResourceUrl,
        localPath: path.posix.join('offline-ready-copy', localPath),
        kind: isImageResponse ? 'image' : mediaInfo || isMediaDownload ? 'media' : item.kind,
        mediaCategory: mediaInfo?.category || (isMediaDownload ? 'unknown' : undefined),
        mediaFormat: mediaInfo?.format,
        mediaMimeType: mediaInfo?.mimeType,
        origin: item.origin,
        contentType: resourceType,
        bytes: body.length
      });
      const now = Date.now();
      if (now - lastProgressTime > 500) {
        lastProgressTime = now;
        onProgress({ phase: 'resources', message: `Downloaded ${manifest.downloaded.length} of ~${totalResources} resources (${Math.round(downloadedBytes / 1024)} KB)`, done: manifest.downloaded.length, total: totalResources, bytes: downloadedBytes });
      }
    } catch (error) {
      manifest.failed.push({ url: item.url, kind: item.kind, origin: item.origin, error: error.name === 'TimeoutError' ? 'request timed out' : error.message });
    }
  }

  await new Promise((resolve) => {
    function schedule() {
      if (processed >= MAX_RESOURCES || (queue.length === 0 && activeCount === 0)) {
        if (activeCount === 0) resolve();
        return;
      }
      while (activeCount < CONCURRENCY && queue.length > 0 && processed < MAX_RESOURCES) {
        const nextItem = queue.shift();
        processed++;
        activeCount++;
        downloadOne(nextItem)
          .catch(() => { })
          .finally(() => {
            activeCount--;
            schedule();
          });
      }
    }
    schedule();
  });

  for (const entry of manifest.downloaded) {
    const absolutePath = path.join(outputDir, entry.localPath);
    const cssLocalPath = entry.localPath.replace(/^offline-ready-copy\//, '');
    if (/text\/css/i.test(entry.contentType || '') || /\.css(?:[./]|$)/i.test(entry.localPath)) {
      const css = await fs.readFile(absolutePath, 'utf8');
      await fs.writeFile(absolutePath, rewriteCss(css, entry.finalUrl || entry.url, relativeUrlMap(cssLocalPath, urlMap)), 'utf8');
    } else if (/mpegurl|dash\+xml/i.test(entry.contentType || '') || /\.(m3u8|mpd)(?:[./]|$)/i.test(entry.localPath)) {
      const playlist = await fs.readFile(absolutePath, 'utf8');
      await fs.writeFile(absolutePath, rewritePlaylist(playlist, entry.finalUrl || entry.url, relativeUrlMap(cssLocalPath, urlMap)), 'utf8');
    }
  }

  onProgress({ phase: 'rewriting', message: 'Rewriting HTML and CSS for offline use...' });
  let offlineHtml = '';
  for (const page of pageContents) {
    const rewrittenPage = rewriteHtml(page.html, page.baseUrl, relativeUrlMap(page.localPath, urlMap));
    const pagePath = path.join(offlineDir, page.localPath);
    await makeDirsForFile(pagePath);
    await fs.writeFile(pagePath, rewrittenPage, 'utf8');
    if (page.localPath === 'index.html') offlineHtml = rewrittenPage;
  }
  if (rendered) {
    const rewrittenRendered = rewriteHtml(rendered.html, rendered.finalUrl || finalUrl, relativeUrlMap('index.html', urlMap));
    await fs.writeFile(path.join(offlineDir, 'rendered-dom.html'), rewriteHtml(rendered.html, rendered.finalUrl || finalUrl, relativeUrlMap('rendered-dom.html', urlMap)), 'utf8');

    // If page is an SPA, has client-rendered intro, or has richer DOM content than the static response:
    const isSpaOrIntro = html.includes('id="__next"') ||
                         html.includes('id="root"') ||
                         html.includes('id="__nuxt"') ||
                         html.includes('id="app"') ||
                         html.includes('class="intro"') ||
                         html.includes('data-component="intro"') ||
                         (html.length < 60000 && rendered.html.length > html.length);

    if (isSpaOrIntro) {
      await fs.writeFile(path.join(offlineDir, 'static-shell.html'), offlineHtml, 'utf8');
      await fs.writeFile(path.join(offlineDir, 'index.html'), rewrittenRendered, 'utf8');
      offlineHtml = rewrittenRendered;
    }
  }

  const report = completenessReport({
    target: target.href,
    finalUrl,
    manifest,
    downloadedCount: manifest.downloaded.length,
    totalCandidates: seen.size,
    rendered: Boolean(rendered)
  });

  await fs.writeFile(path.join(reportsDir, 'resource-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await fs.writeFile(path.join(reportsDir, 'completeness-report.md'), report, 'utf8');

  onProgress({ phase: 'zipping', message: 'Creating ZIP archive...' });
  const zipName = `grabb-${new URL(finalUrl).hostname}-${id}.zip`.replace(/[^a-z0-9._-]+/gi, '_');
  const zipPath = path.join(EXPORTS_DIR, zipName);
  await createZip(outputDir, zipPath);

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  const mediaList = manifest.downloaded
    .filter(item => {
      const lp = (item.localPath || '').toLowerCase();
      const fn = path.posix.basename(lp);
      if (/\.(m3u8|m3u|vtt|srt|m4s|mpd)(?:[?#]|$)/.test(lp)) return false;
      if (/init[_\d]*\.mp4/i.test(fn) || /init[_\d]*\.mp4/i.test(lp)) return false;
      if (fn.startsWith('filesequence') || lp.includes('filesequence')) return false;
      if ((item.bytes || 0) < 50000) return false;
      return item.kind === 'media' || item.mediaCategory === 'video' || /\.(mp4|webm|mov|m4v|mkv)$/i.test(lp);
    })
    .sort((a, b) => {
      const aIsAnim = a.url.includes('/anim/');
      const bIsAnim = b.url.includes('/anim/');
      if (aIsAnim && !bIsAnim) return -1;
      if (!aIsAnim && bIsAnim) return 1;
      return (b.bytes || 0) - (a.bytes || 0);
    })
    .map(item => ({
      url: item.url,
      localPath: item.localPath,
      localUrl: `/downloads/${id}/${item.localPath.replace(/\\/g, '/')}`,
      fileName: path.posix.basename(item.localPath),
      mediaFormat: item.mediaFormat || (item.mediaCategory === 'video' ? 'MP4 video' : 'Media file'),
      bytes: item.bytes,
      sizeFormatted: formatBytes(item.bytes)
    }));

  const result = {
    id,
    targetUrl: target.href,
    finalUrl,
    status: response.status,
    statusText: response.statusText,
    originalHtml: html,
    offlineHtml,
    renderedHtml: rendered ? rendered.html : '',
    manifest,
    report,
    zipName,
    zipUrl: `/downloads/${zipName}`,
    zipDownloadUrl: `/api/download-zip/${zipName}`,
    previewUrl: `/downloads/${id}/offline-ready-copy/index.html`,
    originalHtmlUrl: `/downloads/${id}/original-source/index.html`,
    offlineHtmlUrl: `/downloads/${id}/offline-ready-copy/index.html`,
    manifestUrl: `/downloads/${id}/reports/resource-manifest.json`,
    reportUrl: `/downloads/${id}/reports/completeness-report.md`,
    liveProxyUrl: `/api/live-proxy?url=${encodeURIComponent(finalUrl)}`,
    mediaList,
    summary: {
      downloaded: manifest.downloaded.length,
      archivedPages: manifest.archivedPages.length,
      media: manifest.downloaded.filter(item => item.kind === 'media').length,
      videos: manifest.downloaded.filter(item => item.mediaCategory === 'video').length,
      audio: manifest.downloaded.filter(item => item.mediaCategory === 'audio').length,
      failed: manifest.failed.length,
      skipped: manifest.skipped.length,
      externalDependencies: manifest.externalDependencies.length,
      apiRequests: manifest.apiRequests.length + manifest.detectedApiCalls.length,
      browserCaptured: manifest.downloaded.filter(item => item.origin === 'playwright-intercepted').length,
      rendered: Boolean(rendered)
    }
  };
  onProgress({ phase: 'complete', message: 'Archive complete!' });
  return result;
}

app.get('/api/extract', async (req, res) => {
  const useSSE = req.query.stream === '1';

  if (!useSSE) {
    // Legacy JSON mode
    try {
      const result = await extractWebsite(req.query.url || '');
      // Strip large HTML fields to reduce payload
      const { originalHtml, offlineHtml, renderedHtml, manifest, ...light } = result;
      light.manifest = { downloaded: manifest.downloaded, failed: manifest.failed, skipped: manifest.skipped, archivedPages: manifest.archivedPages, externalDependencies: manifest.externalDependencies, apiRequests: manifest.apiRequests, detectedApiCalls: manifest.detectedApiCalls };
      light.report = result.report;
      res.json(light);
    } catch (error) {
      res.status(400).json({
        error: error.name === 'TimeoutError' ? 'The target website took too long to respond.' : error.message || 'Could not fetch this website.'
      });
    }
    return;
  }

  // SSE streaming mode
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let closed = false;
  req.on('close', () => { closed = true; });

  try {
    const result = await extractWebsite(req.query.url || '', (progress) => {
      if (!closed) sendEvent('progress', progress);
    });

    if (!closed) {
      // Send final result without huge HTML blobs
      const { originalHtml, offlineHtml, renderedHtml, manifest, ...light } = result;
      light.manifest = { downloaded: manifest.downloaded, failed: manifest.failed, skipped: manifest.skipped, archivedPages: manifest.archivedPages, externalDependencies: manifest.externalDependencies, apiRequests: manifest.apiRequests, detectedApiCalls: manifest.detectedApiCalls };
      light.report = result.report;
      sendEvent('result', light);
      res.end();
    }
  } catch (error) {
    if (!closed) {
      sendEvent('error', {
        error: error.name === 'TimeoutError' ? 'The target website took too long to respond.' : error.message || 'Could not fetch this website.'
      });
      res.end();
    }
  }
});

app.get('/api/download-zip/:zipName', (req, res) => {
  const safeName = path.basename(req.params.zipName);
  if (!safeName.endsWith('.zip')) {
    return res.status(400).send('Invalid file format');
  }
  const filePath = path.join(EXPORTS_DIR, safeName);
  res.setHeader('Content-Type', 'application/zip');
  res.download(filePath, safeName, err => {
    if (err && !res.headersSent) {
      res.status(404).send('ZIP archive not found');
    }
  });
});

app.get('/api/live-proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing url');
  try {
    const validated = await validateUrl(targetUrl);
    const fetched = await safeFetch(validated.href, validated.href, null, 'html');
    const response = fetched.response;

    const html = await response.text();
    const baseTag = `<base href="${validated.href}">
<script>
  window.addEventListener('scroll', function() {
    var max = document.documentElement.scrollHeight - window.innerHeight;
    var ratio = max > 0 ? window.scrollY / max : 0;
    window.parent.postMessage({ type: 'scroll', from: 'live', ratio: ratio }, '*');
  }, { passive: true });
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'scroll' && e.data.from === 'offline') {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      if (max > 0) window.scrollTo(0, e.data.ratio * max);
    }
  });
</script>`;

    let modified = html;
    if (modified.includes('<head>')) {
      modified = modified.replace('<head>', '<head>\n' + baseTag);
    } else {
      modified = baseTag + '\n' + modified;
    }

    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(modified);
  } catch (err) {
    res.status(500).send('Could not proxy live site: ' + (err.message || 'Error'));
  }
});

fs.mkdir(EXPORTS_DIR, { recursive: true })
  .then(() => app.listen(PORT, () => console.log(`Grabb running at http://localhost:${PORT}`)))
  .catch(error => {
    console.error('Could not create exports directory:', error);
    process.exit(1);
  });
