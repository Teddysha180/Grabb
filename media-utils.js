const path = require('path');

const formats = [
  { category: 'video', name: 'MP4 video', extensions: ['.mp4'], mimeTypes: ['video/mp4'] },
  { category: 'video', name: 'QuickTime video', extensions: ['.mov', '.qt'], mimeTypes: ['video/quicktime'] },
  { category: 'video', name: 'WebM video', extensions: ['.webm'], mimeTypes: ['video/webm'] },
  { category: 'video', name: 'Matroska video', extensions: ['.mkv'], mimeTypes: ['video/x-matroska'] },
  { category: 'video', name: 'AVI video', extensions: ['.avi'], mimeTypes: ['video/x-msvideo', 'video/avi'] },
  { category: 'video', name: 'Windows Media video', extensions: ['.wmv'], mimeTypes: ['video/x-ms-wmv'] },
  { category: 'video', name: 'M4V video', extensions: ['.m4v'], mimeTypes: ['video/x-m4v'] },
  { category: 'video', name: 'Flash video', extensions: ['.flv'], mimeTypes: ['video/x-flv'] },
  { category: 'video', name: '3GPP video', extensions: ['.3gp', '.3g2'], mimeTypes: ['video/3gpp', 'video/3gpp2'] },
  { category: 'video', name: 'MPEG video', extensions: ['.mpg', '.mpeg', '.mpe', '.m2v'], mimeTypes: ['video/mpeg'] },
  { category: 'video', name: 'DVD video object', extensions: ['.vob'], mimeTypes: ['video/dvd'] },
  { category: 'video', name: 'MPEG transport stream', extensions: ['.ts', '.m2ts', '.mts', '.m2t'], mimeTypes: ['video/mp2t', 'video/mpegts'] },
  { category: 'video', name: 'Ogg video', extensions: ['.ogv'], mimeTypes: ['video/ogg'] },
  { category: 'video', name: 'Flash MP4 video', extensions: ['.f4v'], mimeTypes: ['video/x-f4v'] },
  { category: 'video', name: 'DivX video', extensions: ['.divx'], mimeTypes: ['video/divx'] },
  { category: 'video', name: 'MPEG-1 video', extensions: ['.m1v'], mimeTypes: ['video/mpeg'] },
  { category: 'video', name: 'Material eXchange Format video', extensions: ['.mxf'], mimeTypes: ['application/mxf'] },
  { category: 'video', name: 'RealMedia video', extensions: ['.rm', '.rmvb'], mimeTypes: ['application/vnd.rn-realmedia'] },
  { category: 'video', name: 'ASF video', extensions: ['.asf'], mimeTypes: ['video/x-ms-asf'] },
  { category: 'video', name: 'MPEG-DASH playlist', extensions: ['.mpd'], mimeTypes: ['application/dash+xml'] },
  { category: 'video', name: 'HLS playlist', extensions: ['.m3u8', '.m3u'], mimeTypes: ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'] },
  { category: 'video segment', name: 'Fragmented MP4 segment', extensions: ['.m4s', '.cmfv', '.cmfa', '.ismv', '.isma'], mimeTypes: ['video/iso.segment', 'audio/iso.segment'] },
  { category: 'audio', name: 'MP3 audio', extensions: ['.mp3'], mimeTypes: ['audio/mpeg', 'audio/mp3'] },
  { category: 'audio', name: 'AAC audio', extensions: ['.aac'], mimeTypes: ['audio/aac', 'audio/aacp'] },
  { category: 'audio', name: 'M4A audio', extensions: ['.m4a'], mimeTypes: ['audio/mp4', 'audio/x-m4a'] },
  { category: 'audio', name: 'WAV audio', extensions: ['.wav'], mimeTypes: ['audio/wav', 'audio/wave', 'audio/x-wav'] },
  { category: 'audio', name: 'Ogg audio', extensions: ['.ogg', '.oga', '.opus'], mimeTypes: ['audio/ogg', 'audio/opus'] },
  { category: 'audio', name: 'FLAC audio', extensions: ['.flac'], mimeTypes: ['audio/flac', 'audio/x-flac'] },
  { category: 'subtitle', name: 'WebVTT subtitles', extensions: ['.vtt'], mimeTypes: ['text/vtt'] },
  { category: 'subtitle', name: 'SubRip subtitles', extensions: ['.srt'], mimeTypes: ['application/x-subrip', 'text/srt'] }
];

const byExtension = new Map(formats.flatMap(format => format.extensions.map(extension => [extension, format])));
const byMimeType = new Map(formats.flatMap(format => format.mimeTypes.map(mimeType => [mimeType, format])));

function dispositionFilename(value = '') {
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(value);
  if (encoded) {
    try { return decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, '')); } catch {}
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;]+))/i.exec(value);
  return plain ? (plain[1] || plain[2] || plain[3] || '').trim() : '';
}

function signatureFormat(body) {
  if (!body || body.length < 4) return null;
  if (body.length >= 12 && body.toString('ascii', 4, 8) === 'ftyp') {
    const brand = body.toString('ascii', 8, 12).trim().toLowerCase();
    if (brand === 'qt') return byExtension.get('.mov');
    if (/^m4[abp]$/.test(brand)) return byExtension.get('.m4a');
    if (/^3g/.test(brand)) return byExtension.get('.3gp');
    return byExtension.get('.mp4');
  }
  if (body.toString('ascii', 0, 4) === 'OggS') return byExtension.get('.ogg');
  if (body.toString('ascii', 0, 4) === 'fLaC') return byExtension.get('.flac');
  if (body.toString('ascii', 0, 4) === 'RIFF') {
    if (body.toString('ascii', 8, 12) === 'WAVE') return byExtension.get('.wav');
    if (body.toString('ascii', 8, 12) === 'AVI ') return byExtension.get('.avi');
  }
  if (body.toString('ascii', 0, 3) === 'ID3' || (body[0] === 0xff && (body[1] & 0xe0) === 0xe0)) return byExtension.get('.mp3');
  if (body.length >= 4 && body[0] === 0x1a && body[1] === 0x45 && body[2] === 0xdf && body[3] === 0xa3) {
    if (body.includes(Buffer.from('webm'))) return byExtension.get('.webm');
    if (body.includes(Buffer.from('matroska'))) return byExtension.get('.mkv');
    return null;
  }

  const text = body.toString('utf8', 0, Math.min(body.length, 4096)).trimStart();
  if (text.startsWith('#EXTM3U')) return byExtension.get('.m3u8');
  if (/^<\?xml[\s\S]*<MPD\b|^<MPD\b/i.test(text)) return byExtension.get('.mpd');
  return null;
}

function identifyMedia({ url = '', contentType = '', contentDisposition = '', body } = {}) {
  const pathname = (() => {
    try { return new URL(url).pathname; } catch { return url.split(/[?#]/, 1)[0]; }
  })();
  const filename = dispositionFilename(contentDisposition);
  const extension = path.extname(filename || pathname).toLowerCase();
  const mimeType = contentType.split(';', 1)[0].trim().toLowerCase();
  const signature = signatureFormat(body);
  const mimeFormat = byMimeType.get(mimeType);
  const declaredNonMedia = /^(?:text\/|image\/|application\/(?:javascript|x-javascript|json|xml|wasm))/i.test(mimeType);
  const extensionFormat = declaredNonMedia && !mimeFormat ? null : byExtension.get(extension);
  const format = signature || mimeFormat || extensionFormat;
  if (!format) return null;
  return { category: format.category, format: format.name, extension: format.extensions[0], mimeType: format.mimeTypes[0] };
}

function mimeTypeForExtension(extension) {
  return byExtension.get(extension.toLowerCase())?.mimeTypes[0] || '';
}

module.exports = { identifyMedia, mimeTypeForExtension };