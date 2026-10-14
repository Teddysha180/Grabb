const test = require('node:test');
const assert = require('node:assert/strict');
const { identifyMedia, mimeTypeForExtension } = require('../media-utils');

test('recognizes common video, audio, playlist, segment, and subtitle extensions', () => {
  const cases = [
    ['https://media.example/video.mp4', 'video', '.mp4'],
    ['https://media.example/video.webm', 'video', '.webm'],
    ['https://media.example/video.mkv', 'video', '.mkv'],
    ['https://media.example/video.avi', 'video', '.avi'],
    ['https://media.example/live/index.m3u8', 'video', '.m3u8'],
    ['https://media.example/live/manifest.mpd', 'video', '.mpd'],
    ['https://media.example/live/chunk.m4s', 'video segment', '.m4s'],
    ['https://media.example/audio.flac', 'audio', '.flac'],
    ['https://media.example/captions.vtt', 'subtitle', '.vtt']
  ];

  for (const [url, category, extension] of cases) {
    const media = identifyMedia({ url });
    assert.equal(media.category, category, url);
    assert.equal(media.extension, extension, url);
  }
});

test('uses MIME type or Content-Disposition for signed extensionless media URLs', () => {
  const byMime = identifyMedia({ url: 'https://media.example/file?id=123', contentType: 'video/webm; codecs=vp9' });
  const byName = identifyMedia({ url: 'https://media.example/file?id=123', contentDisposition: "attachment; filename*=UTF-8''clip%20final.mp4" });

  assert.equal(byMime.extension, '.webm');
  assert.equal(byName.extension, '.mp4');
});

test('sniffs a media signature when the URL and response headers omit the format', () => {
  const mp4 = Buffer.alloc(12);
  mp4.write('ftyp', 4, 'ascii');
  mp4.write('isom', 8, 'ascii');
  const media = identifyMedia({ url: 'https://media.example/download?id=123', contentType: 'application/octet-stream', body: mp4 });

  assert.equal(media.format, 'MP4 video');
  assert.equal(media.extension, '.mp4');
});

test('does not classify TypeScript assets as MPEG transport streams', () => {
  assert.equal(identifyMedia({ url: 'https://cdn.example/app.ts', contentType: 'text/plain' }), null);
});

test('does not classify image responses as video or audio', () => {
  assert.equal(identifyMedia({ url: 'https://cdn.example/poster.png', contentType: 'image/png' }), null);
});

test('returns the matching MIME type for downloaded media extensions', () => {
  assert.equal(mimeTypeForExtension('.m3u8'), 'application/vnd.apple.mpegurl');
  assert.equal(mimeTypeForExtension('.mkv'), 'video/x-matroska');
});