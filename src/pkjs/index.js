// ReelTime watchface -- PebbleKit JS side.
// Runs fishdraw on the phone, streams polylines to the watch.
'use strict';

var fd = require('./fishdraw.js');

var CHUNK_DATA_BYTES = 600; // payload bytes per FISH_CHUNK (excl. 2-byte idx)
var MAX_FISH_BYTES = 16384;
var SIMPLIFY_EPS = [0.45, 0.7, 1.1, 1.6, 2.4, 3.5, 5, 7, 10, 14];
var VALID_INTERVALS = [60, 3600, 43200];

var s_cache = null; // { key, name, chunks, checksum, npolys }
var s_prefetch = null; // next bucket, prepared after a successful send
var s_prefetch_key = null;

// ---- generation ---------------------------------------------------------

function dpSimplify(pts, eps) {
  if (pts.length < 3) return pts;
  var d = function (p, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var len = Math.sqrt(dx * dx + dy * dy);
    var t = 0;
    if (len) t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (len * len);
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    var ex = p[0] - a[0] - t * dx;
    var ey = p[1] - a[1] - t * dy;
    return Math.sqrt(ex * ex + ey * ey);
  };
  var keep = new Array(pts.length);
  keep[0] = keep[pts.length - 1] = true;
  var stack = [[0, pts.length - 1]];
  while (stack.length) {
    var seg = stack.pop();
    var s = seg[0], e = seg[1];
    var mi = -1, md = 0;
    for (var i = s + 1; i < e; i++) {
      var dd = d(pts[i], pts[s], pts[e]);
      if (dd > md) { md = dd; mi = i; }
    }
    if (md > eps && mi >= 0) {
      keep[mi] = true;
      stack.push([s, mi], [mi, e]);
    }
  }
  var out = [];
  for (var j = 0; j < pts.length; j++) if (keep[j]) out.push(pts[j]);
  return out;
}

function fitRect(polys, w, h) {
  var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  polys.forEach(function (p) {
    p.forEach(function (pt) {
      if (pt[0] < minX) minX = pt[0];
      if (pt[0] > maxX) maxX = pt[0];
      if (pt[1] < minY) minY = pt[1];
      if (pt[1] > maxY) maxY = pt[1];
    });
  });
  var bw = maxX - minX, bh = maxY - minY;
  var s = Math.min(w / bw, h / bh);
  var ox = (w - bw * s) / 2 - minX * s;
  var oy = (h - bh * s) / 2 - minY * s;
  return { s: s, ox: ox, oy: oy };
}

// Serialize polylines as int16 LE pairs, polylines separated by
// (0x8000, 0x8000) sentinels. Returns {bytes, npolys} or null.
function toWire(polys, w, h, eps) {
  var tr = fitRect(polys, w, h);
  var out = [];
  var npolys = 0;
  for (var i = 0; i < polys.length; i++) {
    var scaled = polys[i].map(function (pt) {
      return [pt[0] * tr.s + tr.ox, pt[1] * tr.s + tr.oy];
    });
    if (eps > 0) scaled = dpSimplify(scaled, eps);
    var q = [];
    for (var j = 0; j < scaled.length; j++) {
      var px = Math.round(scaled[j][0]);
      var py = Math.round(scaled[j][1]);
      if (!q.length || q[q.length - 1][0] !== px || q[q.length - 1][1] !== py) {
        q.push([px, py]);
      }
    }
    if (q.length < 2) continue;
    if (npolys > 0) {
      push16(out, -32768);
      push16(out, -32768);
    }
    for (var k = 0; k < q.length; k++) {
      push16(out, q[k][0]);
      push16(out, q[k][1]);
    }
    npolys++;
  }
  if (npolys === 0) return null;
  return { bytes: out, npolys: npolys };
}

function push16(arr, v) {
  arr.push(v & 0xff, (v >> 8) & 0xff);
}

function checksum(bytes) {
  var sum = 0;
  for (var i = 0; i < bytes.length; i++) sum += bytes[i];
  return sum;
}

function chunkify(bytes) {
  var chunks = [];
  for (var i = 0; i < bytes.length; i += CHUNK_DATA_BYTES) {
    chunks.push(bytes.slice(i, i + CHUNK_DATA_BYTES));
  }
  return chunks;
}

// Deterministic fish for a key like "3600:12345" (seed mode: "T3600:12345").
function generateFish(key, w, h, seed, mode) {
  var t0 = Date.now();
  fd.set_seed(seed);
  var name = '';
  if (!mode) {
    name = fd.binomen();
    fd.set_seed(name);
  }
  var drawing = fd.fish(fd.generate_params());
  var polys = fd.cleanup(fd.reframe(drawing, 20, ''));

  var wire = null;
  var epsUsed = null;
  for (var i = 0; i < SIMPLIFY_EPS.length; i++) {
    var attempt = toWire(polys, w, h, SIMPLIFY_EPS[i]);
    if (attempt && attempt.bytes.length <= MAX_FISH_BYTES) {
      wire = attempt;
      epsUsed = SIMPLIFY_EPS[i];
      break;
    }
  }
  if (!wire) return null;

  var fish = {
    key: key,
    name: name,
    chunks: chunkify(wire.bytes),
    checksum: checksum(wire.bytes),
    npolys: wire.npolys,
    bytes: wire.bytes.length,
    genMs: Date.now() - t0,
  };
  console.log('fish ' + key + ' "' + name + '"' +
      (mode ? ' seed "' + seed + '"' : '') + ': ' + fish.bytes + 'B, ' +
      wire.npolys + ' polys, ' + fish.chunks.length + ' chunks, eps ' +
      epsUsed + ', ' + fish.genMs + 'ms');
  return fish;
}

function getFish(key, w, h, seed, mode) {
  if (s_cache && s_cache.key === key) return s_cache;
  if (s_prefetch && s_prefetch.key === key) {
    s_cache = s_prefetch;
    s_prefetch = null;
    return s_cache;
  }
  s_cache = generateFish(key, w, h, seed, mode);
  return s_cache;
}

// ---- sending -----------------------------------------------------------

function sendFish(fish, done) {
  var meta = fish.bytes + ',' + fish.npolys + ',' + fish.name;
  var i = 0;
  var failed = false;

  function fail(e) {
    if (failed) return;
    failed = true;
    console.log('send failed at chunk ' + i + ': ' + JSON.stringify(e));
  }

  function step() {
    if (failed) return;
    if (i === 0) {
      Pebble.sendAppMessage({ FISH_META: meta }, next, fail);
      return;
    }
    if (i > fish.chunks.length) {
      Pebble.sendAppMessage({ FISH_END: fish.checksum }, function () {
        if (done) done();
      }, fail);
      return;
    }
    var idx = i - 1;
    var payload = [idx & 0xff, (idx >> 8) & 0xff].concat(fish.chunks[idx]);
    i++;
    Pebble.sendAppMessage({ FISH_CHUNK: payload }, step, fail);
  }

  function next() {
    i = 1;
    step();
  }

  step();
}

// ---- bucket math -------------------------------------------------------

function bucketKey(intervalS, bucket) {
  return intervalS + ':' + bucket;
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

// Seed in time mode: wall-clock moment the bucket started, e.g. "2026-10-03 14:00".
// UTC so the same bucket always yields the same fish regardless of process TZ.
function timeKey(intervalS, bucket) {
  var d = new Date(bucket * intervalS * 1000);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) +
      ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
}

function cacheKey(intervalS, bucket, mode) {
  return mode ? 'T' + bucketKey(intervalS, bucket)
              : bucketKey(intervalS, bucket);
}

function seedFor(intervalS, bucket, mode) {
  return mode ? timeKey(intervalS, bucket)
              : bucketKey(intervalS, bucket);
}

function prefetchNext(intervalS, w, h, mode) {
  var bucket = Math.floor(Date.now() / 1000 / intervalS) + 1;
  var key = cacheKey(intervalS, bucket, mode);
  if (s_prefetch_key === key) return;
  s_prefetch_key = key;
  setTimeout(function () {
    try {
      s_prefetch = generateFish(key, w, h, seedFor(intervalS, bucket, mode),
                                mode);
    } catch (e) {
      console.log('prefetch error: ' + e);
    }
  }, 1500);
}

// ---- AppMessage from watch --------------------------------------------

Pebble.addEventListener('appmessage', function (e) {
  var p = e.payload;
  if (p.REQUEST_FISH !== undefined) {
    try {
      handleRequest(String(p.REQUEST_FISH));
    } catch (err) {
      console.log('request error: ' + err);
    }
    return;
  }
  if (p.SETTINGS !== undefined || p.BGCOLOR !== undefined) {
    cacheSettings(p);
    console.log('settings from watch: interval=' + s_settings.interval +
        ' border=' + s_settings.border + ' seedmode=' + s_settings.seedmode +
        ' bg=' + s_settings.bgcolor + ' fish=' + s_settings.fgcolor +
        ' text=' + s_settings.textcolor + ' lw=' + s_settings.lw);
    if (s_config_opener) {
      var o = s_config_opener;
      s_config_opener = null;
      o();
    }
  }
});

function handleRequest(req) {
  // format: "<bucket>,<interval_s>,<fish_w>,<fish_h>[,<seed_mode>]"
  var parts = req.split(',');
  var bucket = parseInt(parts[0], 10);
  var intervalS = parseInt(parts[1], 10);
  var w = parseInt(parts[2], 10);
  var h = parseInt(parts[3], 10);
  var mode = parts.length > 4 ? (parseInt(parts[4], 10) || 0) : 0;
  if (!isFinite(bucket) || !isFinite(intervalS) || !isFinite(w) || !isFinite(h)) {
    console.log('bad request: ' + req);
    return;
  }
  if (w <= 0 || w > 400 || h <= 0 || h > 400) {
    w = 192; h = 116;
  }
  console.log('REQUEST_FISH bucket=' + bucket + ' interval=' + intervalS +
      ' rect=' + w + 'x' + h + ' seedmode=' + mode);
  var fish = getFish(cacheKey(intervalS, bucket, mode), w, h,
                     seedFor(intervalS, bucket, mode), mode);
  if (!fish) {
    console.log('generation failed');
    return;
  }
  sendFish(fish, function () {
    prefetchNext(intervalS, w, h, mode);
  });
}

// ---- configuration page ------------------------------------------------

// ---- settings (phone cache; watch is source of truth) ------------------

var s_settings = {
  interval: 3600, border: 0, seedmode: 1,
  bgcolor: 255, fgcolor: 192, textcolor: 192, lw: 1,
};
var s_config_opener = null;

// Pebble 64-colour palette subset (GColor ARGB8 values).
var PALETTE = [192, 193, 195, 197, 201, 204, 207, 213, 214, 226, 234, 240,
               243, 244, 247, 248, 252, 254, 255];

function c8v(v, dflt) {
  var n = parseInt(v, 10);
  if (!isFinite(n)) return dflt;
  return 192 | (n & 63); // force opaque
}

function lwv(v, dflt) {
  var n = parseInt(v, 10);
  if (n !== 1 && n !== 2 && n !== 3) return dflt;
  return n;
}

function cacheSettings(p) {
  if (p.SETTINGS !== undefined && VALID_INTERVALS.indexOf(p.SETTINGS) >= 0) {
    s_settings.interval = p.SETTINGS;
  }
  if (p.BORDER !== undefined) s_settings.border = p.BORDER ? 1 : 0;
  if (p.SEEDMODE !== undefined) s_settings.seedmode = p.SEEDMODE ? 1 : 0;
  if (p.BGCOLOR !== undefined) s_settings.bgcolor = c8v(p.BGCOLOR, s_settings.bgcolor);
  if (p.FGCOLOR !== undefined) s_settings.fgcolor = c8v(p.FGCOLOR, s_settings.fgcolor);
  if (p.TEXTCOLOR !== undefined) s_settings.textcolor = c8v(p.TEXTCOLOR, s_settings.textcolor);
  if (p.LINEWIDTH !== undefined) s_settings.lw = lwv(p.LINEWIDTH, s_settings.lw);
}

// ---- configuration page ------------------------------------------------

function gcss(v) {
  return 'rgb(' + (((v >> 4) & 3) * 85) + ',' + (((v >> 2) & 3) * 85) + ',' +
      ((v & 3) * 85) + ')';
}

function swatches(id, sel) {
  var h = '<div class="srow" id="' + id + '">';
  for (var i = 0; i < PALETTE.length; i++) {
    var v = PALETTE[i];
    h += '<i class="sw' + (v === sel ? ' sel' : '') + '" data-v="' + v +
        '" style="background:' + gcss(v) + '" onclick="pick(this)"></i>';
  }
  return h + '</div>';
}

function buildConfigHtml(s) {
  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>ReelTime Settings</title><style>',
    'body{font-family:-apple-system,Helvetica,Arial,sans-serif;margin:0;padding:24px;background:#111;color:#eee}',
    'h1{font-size:20px;margin:0 0 4px}p.sub{color:#999;margin:0 0 20px;font-size:13px}',
    '.opt{display:block;border:1px solid #333;border-radius:10px;padding:14px 16px;margin-bottom:10px;cursor:pointer}',
    '.opt input{margin-right:10px;transform:scale(1.2)}',
    '.opt small{display:block;color:#999;margin-left:26px;margin-top:4px;font-size:12px}',
    '.chk{display:block;border:1px solid #333;border-radius:10px;padding:14px 16px;margin-bottom:10px;cursor:pointer}',
    '.chk input{margin-right:10px;transform:scale(1.2)}',
    '.chk small{display:block;color:#999;margin-left:26px;margin-top:4px;font-size:12px}',
    '.crow{border:1px solid #333;border-radius:10px;padding:12px 14px;margin-bottom:10px}',
    '.crow span{display:block;color:#999;font-size:13px;margin-bottom:8px}',
    '.seg{display:flex;gap:8px}',
    '.sg{flex:1;text-align:center;padding:10px 0;border:1px solid #333;border-radius:8px;cursor:pointer;color:#ccc}',
    '.sg.on{background:#2ecc71;color:#041;border-color:#2ecc71}',
    '.srow{display:flex;flex-wrap:wrap;gap:8px}',
    '.sw{width:30px;height:30px;border-radius:8px;cursor:pointer}',
    '.sw.sel{outline:3px solid #2ecc71;outline-offset:2px}',
    'button{width:100%;padding:14px;font-size:16px;border:0;border-radius:10px;background:#2ecc71;color:#041;border:none;font-weight:bold;margin-top:10px}',
    'button.alt{background:#444;color:#eee;font-weight:normal}',
    '</style></head><body>',
    '<h1>&#x1F41F; ReelTime</h1>',
    '<p class="sub">How often should a new fish be drawn?</p>',
    '<label class="opt"><input type="radio" name="iv" value="60"' +
        (s.interval === 60 ? ' checked' : '') +
        '>Every minute<small>A new fish every 60 seconds &mdash; rapid switching</small></label>',
    '<label class="opt"><input type="radio" name="iv" value="3600"' +
        (s.interval === 3600 ? ' checked' : '') +
        '>Every hour<small>A new fish every 3600 seconds</small></label>',
    '<label class="opt"><input type="radio" name="iv" value="43200"' +
        (s.interval === 43200 ? ' checked' : '') +
        '>Every 12 hours<small>A new fish twice a day</small></label>',
    '<label class="chk"><input type="checkbox" id="bd"' + (s.border ? ' checked' : '') +
        '> Draw a border around the fish<small>Borderless mode lets the fish fill the whole screen</small></label>',
    '<label class="chk"><input type="checkbox" id="tsm"' + (s.seedmode ? ' checked' : '') +
        '> Seed fish with time &amp; date<small>The clock decides each fish; no Latin name is shown and the fish gets the extra space</small></label>',
    '<p class="sub">Colours</p>',
    '<div class="crow"><span>Line thickness</span><div class="seg" id="lwseg">',
    '<b class="sg' + (s.lw === 1 ? ' on' : '') + '" data-v="1" onclick="segpick(this)">Thin</b>',
    '<b class="sg' + (s.lw === 2 ? ' on' : '') + '" data-v="2" onclick="segpick(this)">Normal</b>',
    '<b class="sg' + (s.lw === 3 ? ' on' : '') + '" data-v="3" onclick="segpick(this)">Bold</b>',
    '</div></div>',
    '<div class="crow"><span>Background</span>' + swatches('bgs', s.bgcolor) + '</div>',
    '<div class="crow"><span>Fish</span>' + swatches('fgs', s.fgcolor) + '</div>',
    '<div class="crow"><span>Text</span>' + swatches('txs', s.textcolor) + '</div>',
    '<button class="alt" onclick="rand()">Random colours</button>',
    '<button onclick="save()">Save</button>',
    '<script>',
    'var PALETTE=' + JSON.stringify(PALETTE) + ';',
    'function pick(el){var r=el.parentNode,k=r.getElementsByClassName("sw");',
    'for(var i=0;i<k.length;i++)k[i].className="sw";el.className="sw sel";}',
    'function segpick(el){var k=el.parentNode.getElementsByClassName("sg");',
    'for(var i=0;i<k.length;i++)k[i].className="sg";el.className="sg on";}',
    'function pickv(id,v){var r=document.getElementById(id),k=r.getElementsByClassName("sw");',
    'for(var i=0;i<k.length;i++)k[i].className=k[i].getAttribute("data-v")==String(v)?"sw sel":"sw";}',
    'function rand(){var out=[];while(out.length<3){var v=PALETTE[Math.floor(Math.random()*PALETTE.length)];',
    'if(out.indexOf(v)<0)out.push(v);}',
    'pickv("bgs",out[0]);pickv("fgs",out[1]);pickv("txs",out[2]);}',
    'function sel(id){var e=document.getElementById(id).getElementsByClassName("sel")[0];',
    'return e?parseInt(e.getAttribute("data-v"),10):192;}',
    'function save(){',
    'var v=document.querySelector("input[name=iv]:checked").value;',
    'var lw=document.querySelector("#lwseg .sg.on").getAttribute("data-v");',
    'var p={interval:parseInt(v,10),',
    'border:document.getElementById("bd").checked?1:0,',
    'seedmode:document.getElementById("tsm").checked?1:0,',
    'lw:parseInt(lw,10),',
    'bgcolor:sel("bgs"),fgcolor:sel("fgs"),textcolor:sel("txs")};',
    'var r=encodeURIComponent(JSON.stringify(p));',
    'var m=location.href.match(/[?&]return_to=([^&]*)/);',
    'location.href=m?decodeURIComponent(m[1])+r:"pebblejs://close#"+r;',
    '}',
    '</script></body></html>',
  ].join('');
}

Pebble.addEventListener('showConfiguration', function () {
  console.log('showConfiguration -> opening config page');
  var opened = false;
  function open() {
    if (opened) return;
    opened = true;
    s_config_opener = null;
    Pebble.openURL('data:text/html;charset=utf-8,' +
        encodeURIComponent(buildConfigHtml(s_settings)));
  }
  s_config_opener = open;
  try {
    Pebble.sendAppMessage({ GET_SETTINGS: 1 }, function () {},
        function () { open(); });
  } catch (err) {
    open();
  }
  setTimeout(open, 700);
});

Pebble.addEventListener('webviewclosed', function (e) {
  if (e && e.response) {
    try {
      var settings = JSON.parse(decodeURIComponent(e.response));
      if (VALID_INTERVALS.indexOf(settings.interval) < 0) return;
      var upd = {
        SETTINGS: settings.interval,
        BORDER: settings.border ? 1 : 0,
        SEEDMODE: settings.seedmode ? 1 : 0,
        BGCOLOR: c8v(settings.bgcolor, s_settings.bgcolor),
        FGCOLOR: c8v(settings.fgcolor, s_settings.fgcolor),
        TEXTCOLOR: c8v(settings.textcolor, s_settings.textcolor),
        LINEWIDTH: lwv(settings.lw, s_settings.lw),
      };
      cacheSettings(upd);
      console.log('settings: interval=' + s_settings.interval +
          ' border=' + s_settings.border + ' seedmode=' + s_settings.seedmode +
          ' bg=' + s_settings.bgcolor + ' fish=' + s_settings.fgcolor +
          ' text=' + s_settings.textcolor + ' lw=' + s_settings.lw);
      Pebble.sendAppMessage(upd,
          function () { console.log('settings sent'); },
          function (err) { console.log('settings send failed: ' + JSON.stringify(err)); });
    } catch (err) {
      console.log('config parse error: ' + err);
    }
  }
});

Pebble.addEventListener('ready', function () {
  console.log('fishdraw pkjs ready');
});
