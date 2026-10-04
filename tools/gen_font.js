#!/usr/bin/env node
// Generates src/c/stroke_font_data.h (single-stroke glyph table) from
// fishdraw's embedded Hershey font + authored digit/colon glyphs.
// Also writes tools/font_preview.svg for eyeball verification.
//
// Usage: node tools/gen_font.js
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FISHDRAW = path.join(ROOT, 'src', 'pkjs', 'fishdraw.js');
const OUT_H = path.join(ROOT, 'src', 'c', 'stroke_font_data.h');
const OUT_SVG = path.join(__dirname, 'font_preview.svg');

const ORD_R = 82;
const PENUP = -128;

// ---- extract hershey_raw object literal from fishdraw.js ----
const src = fs.readFileSync(FISHDRAW, 'utf8');
const m = src.match(/let hershey_raw = \{[\s\S]*?\n\};/);
if (!m) throw new Error('hershey_raw not found in fishdraw.js');
const hershey_raw = eval('(' + m[0].slice('let hershey_raw = '.length, -1) + ')');

function compileHershey(entry) {
  const bound = entry.substring(3, 5);
  const xmin = bound.charCodeAt(0) - ORD_R;
  const xmax = bound.charCodeAt(1) - ORD_R;
  const content = entry.substring(5);
  const polylines = [[]];
  let j = 0;
  while (j < content.length) {
    const digit = content.substring(j, j + 2);
    if (digit === ' R') {
      polylines.push([]);
    } else {
      polylines[polylines.length - 1].push([
        digit.charCodeAt(0) - ORD_R,
        digit.charCodeAt(1) - ORD_R,
      ]);
    }
    j += 2;
  }
  return { xmin, xmax, polylines: polylines.filter(p => p.length) };
}

// ---- authored glyphs (not present in fishdraw's font subset) ----
// Coordinate space matches Hershey: x right, y DOWN, cap top ~ -12, baseline ~ 9.
const AUTHORED = {
  '0': [[[-5, -12], [0, -12], [5, -10], [7, -5], [7, 3], [5, 8], [0, 9], [-5, 8], [-7, 3], [-7, -5], [-5, -12]]],
  '1': [[[-4, -9], [1, -12], [1, 9]]],
  '2': [[[-6, -9], [-3, -12], [3, -12], [6, -9], [5, -4], [-6, 9], [6, 9]]],
  '3': [[[-5, -10], [2, -12], [6, -8], [3, -3], [7, 0], [6, 5], [2, 8], [-4, 9]]],
  '4': [[[4, -12], [-6, 3], [7, 3]], [[1, -5], [1, 9]]],
  '5': [[[6, -12], [-5, -12], [-6, -4], [-1, -6], [4, -3], [6, 2], [4, 7], [-1, 9], [-5, 7]]],
  '6': [[[5, -11], [0, -12], [-5, -6], [-6, 2], [-4, 7], [1, 9], [5, 6], [5, 2], [1, 0], [-4, 2]]],
  '7': [[[-6, -12], [7, -12], [-2, 9]]],
  '8': [[[-4, -12], [4, -12], [6, -8], [3, -4], [-3, -4], [-6, -8], [-4, -12]], [[-3, -4], [4, -4], [7, 1], [4, 7], [-3, 7], [-7, 1], [-3, -4]]],
  '9': [[[-5, -6], [-1, -12], [4, -11], [6, -6], [4, -1], [0, 1], [-5, 0]], [[6, -6], [5, 1], [2, 7], [-3, 9]]],
  ':': [[[-1, -8], [-1, -5]], [[-1, 2], [-1, 5]]],
};

function authoredToGlyph(polys, xmin, xmax) {
  if (xmin === undefined) {
    xmin = Infinity; xmax = -Infinity;
    for (const p of polys) for (const [x] of p) { if (x < xmin) xmin = x; if (x > xmax) xmax = x; }
  }
  return { xmin, xmax, polylines: polys };
}

// Clock digits live in a uniform 16-unit cell (advance 16), ink centered,
// bounds [0,16] so runtime advance matches and digits line up in columns.
const DIGIT_CELL = 16;
function cellGlyph(polys) {
  let xmin = Infinity, xmax = -Infinity;
  for (const p of polys) for (const [x] of p) { if (x < xmin) xmin = x; if (x > xmax) xmax = x; }
  const ink = xmax - xmin;
  const dx = Math.round((DIGIT_CELL - ink) / 2) - xmin;
  return {
    xmin: 0,
    xmax: DIGIT_CELL,
    polylines: polys.map(p => p.map(([x, y]) => [x + dx, y])),
  };
}

// ---- assemble glyph table in mapping order ----
// indices: 0-25 A-Z, 26-51 a-z, 52-61 0-9, 62 '.', 63 ':'
const glyphs = [];
const labels = [];
for (let i = 0; i < 26; i++) {
  const ch = String.fromCharCode(65 + i);
  glyphs.push(compileHershey(hershey_raw[String(501 + i)]));
  labels.push(ch);
}
for (let i = 0; i < 26; i++) {
  const ch = String.fromCharCode(97 + i);
  glyphs.push(compileHershey(hershey_raw[String(601 + i)]));
  labels.push(ch);
}
for (const ch of '0123456789') {
  glyphs.push(cellGlyph(AUTHORED[ch]));
  labels.push(ch);
}
glyphs.push(compileHershey(hershey_raw['710'])); // '.'
labels.push('.');
glyphs.push(cellGlyph(AUTHORED[':']));
labels.push(':');

// ---- flatten to point table ----
const points = [];
const records = [];
let totalPts = 0;
for (const g of glyphs) {
  const start = points.length;
  let n = 0;
  g.polylines.forEach((p, i) => {
    if (i > 0) { points.push(PENUP, PENUP); n += 2; }
    for (const [x, y] of p) {
      if (x < -127 || x > 127 || y < -127 || y > 127) throw new Error('coord out of int8 range');
      points.push(x, y);
      n += 2;
    }
  });
  if (n === 0) throw new Error('empty glyph');
  const advance = g.xmax - g.xmin;
  records.push({ offset: start, npts: n, xmin: g.xmin, advance });
  totalPts += n;
}
if (totalPts !== points.length) throw new Error('point count mismatch');

// ---- emit C header ----
function cArray(name, type, vals, perLine) {
  let out = `static const ${type} ${name}[] = {\n  `;
  let line = 0;
  for (let i = 0; i < vals.length; i++) {
    out += vals[i] + ', ';
    if (++line >= perLine) { out += '\n  '; line = 0; }
  }
  return out + '\n};\n';
}

let h = `// GENERATED by tools/gen_font.js -- do not edit.
// Glyphs ported from fishdraw's Hershey font subset (MIT) + authored digits.
// Encoding: Hershey coordinate space, x right, y DOWN, cap top ~-12, baseline ~9.
#pragma once
#include <stdint.h>

#define SF_PENUP        ((int8_t)-128)
#define SF_NGLYPHS      64
#define SF_SPACE_ADV    10

// glyph index: 0-25 A-Z, 26-51 a-z, 52-61 '0'-'9', 62 '.', 63 ':'
typedef struct {
  uint16_t pt_offset;  // into sf_points (int8 pairs)
  uint8_t  npts;       // number of int8 values (2 per point)
  int8_t   xmin;
  int8_t   advance;
} StrokeGlyph;

`;
h += cArray('sf_points', 'int8_t', points, 20);
h += `
static const StrokeGlyph sf_glyphs[SF_NGLYPHS] = {
`;
for (let i = 0; i < records.length; i++) {
  const r = records[i];
  h += `  {${r.offset}, ${r.npts}, ${r.xmin}, ${r.advance}}, // ${labels[i]}\n`;
}
h += `};

static const char sf_labels[SF_NGLYPHS + 1] = "${labels.join('')}";
`;
fs.writeFileSync(OUT_H, h);

// ---- preview svg ----
function layoutString(str, scale) {
  let x = 0;
  const polys = [];
  for (const ch of str) {
    if (ch === ' ') { x += 10; continue; }
    let idx = -1;
    if (ch >= 'A' && ch <= 'Z') idx = ch.charCodeAt(0) - 65;
    else if (ch >= 'a' && ch <= 'z') idx = 26 + ch.charCodeAt(0) - 97;
    else if (ch >= '0' && ch <= '9') idx = 52 + ch.charCodeAt(0) - 48;
    else if (ch === '.') idx = 62;
    else if (ch === ':') idx = 63;
    if (idx < 0) continue;
    const g = glyphs[idx];
    let cur = [];
    for (const p of g.polylines) {
      polys.push(p.map(([px, py]) => [(px - g.xmin + x) * scale, (py + 12) * scale]));
    }
    x += g.xmax - g.xmin;
  }
  return { polys, width: x * scale };
}

const strings = ['10:45 AM', '12:34:56', '7890', 'Pothys calomira.', 'TUE 2 OCT', 'Selistehus marpinteris.'];
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="white"/>`;
let y = 30;
for (const s of strings) {
  const { polys } = layoutString(s, 2);
  svg += `<g transform="translate(10,${y})" fill="none" stroke="black" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">`;
  for (const p of polys) {
    svg += `<polyline points="${p.map(pt => pt.join(',')).join(' ')}"/>`;
  }
  svg += `</g>`;
  y += 55;
}
svg += `</svg>`;
fs.writeFileSync(OUT_SVG, svg);

console.log(`wrote ${path.relative(ROOT, OUT_H)} (${points.length} int8 values, ${glyphs.length} glyphs)`);
console.log(`wrote ${path.relative(ROOT, OUT_SVG)}`);
