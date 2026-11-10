// Shared page pieces of the public (non-panel) side: the Google-style 404 page
// returned for every unknown or rejected request.
'use strict';

const HTML_TYPE = 'text/html; charset=utf-8';
const HTML_START = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">';
const VIEWPORT = '<meta name="viewport" content="width=device-width,initial-scale=1">';

const NOT_FOUND_HTML =
  HTML_START +
  '<title>Error 404 (Not Found)!!1</title>' +
  VIEWPORT +
  '<style>' +
  'body{margin:0;padding:24px;font:15px/1.5 arial,sans-serif;color:#222}p{margin:16px 0}b{font-size:1.1em}' +
  'ins{color:#777;text-decoration:none}.g{font-size:46px;letter-spacing:-2px;color:#4285f4;text-decoration:none}</style></head><body>' +
  '<a class="g" href="https://www.google.com/">Google</a>' +
  '<p><b>404.</b> <ins>That\u2019s an error.</ins></p>' +
  '<p>The requested URL was not found on this server. <ins>That\u2019s all we know.</ins></p></body></html>';

// Headers every public response carries: uncacheable and not content-sniffed.
const BASE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

function sendNotFound(res) {
  res.status(404).set({ ...BASE_HEADERS, 'Content-Type': HTML_TYPE }).send(NOT_FOUND_HTML);
}

module.exports = { HTML_TYPE, HTML_START, VIEWPORT, NOT_FOUND_HTML, BASE_HEADERS, sendNotFound };
