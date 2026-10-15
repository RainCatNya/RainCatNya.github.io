/* qr.js 极简 QR 码生成器 */
/*
  内容: 字节模式 + 纠错等级 M + 版本 1~10, 对外只暴露 qrSvg(text, opts) → 白底黑块的 SVG 字符串
  依赖: 无 (TOTP 密钥不能发给第三方二维码服务, 所以自己写)
*/
// 纠错等级 M 在规范里的编号是 0, 所以格式信息里那两位就是 0

/* 每块的纠错码字数 (等级 M) */
const QR_EC_M = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
/* 分块表 (等级 M): 版本 → [[块数, 每块数据码字数], ...] */
const QR_BLOCKS_M = [
  [[1, 16]], [[1, 28]], [[1, 44]], [[2, 32]], [[2, 43]],
  [[4, 27]], [[4, 31]], [[2, 38], [2, 39]], [[3, 36], [2, 37]], [[4, 43], [1, 44]]
];
/* 校正图案的中心坐标 (版本 1 没有) */
const QR_ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

/* GF(256) 有限域 */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
// 建指数与对数表 (0x11d 是本原多项式)
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
}());

// 有限域乘法 (查表)
function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

// 多项式乘法
function polyMul(a, b) {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) out[i + j] ^= gfMul(a[i], b[j]);
  }
  return out;
}

// 生成多项式
function rsGenerator(n) {
  let poly = [1];
  for (let i = 0; i < n; i += 1) poly = polyMul(poly, [1, GF_EXP[i]]);
  return poly;
}

/* 数据码字 → 纠错码字 (多项式除法取余) */
function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Array(data.length + ecLen).fill(0);
  data.forEach((v, i) => { res[i] = v; });
  for (let i = 0; i < data.length; i += 1) {
    const coef = res[i];
    if (coef === 0) continue;
    for (let j = 0; j < gen.length; j += 1) res[i + j] ^= gfMul(gen[j], coef);
  }
  return res.slice(data.length);
}

/* 数据编码 */
// 该版本能装多少数据码字
function dataCapacity(version) {
  return QR_BLOCKS_M[version - 1].reduce((n, [count, len]) => n + count * len, 0);
}

// 文本 → 位流 → 数据码字 (字节模式)
function encodeBits(text, version) {
  const bytes = new TextEncoder().encode(text);
  const bits = [];
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i -= 1) bits.push((val >> i) & 1);
  };
  push(4, 4);                                        // 模式指示符: 字节模式
  push(bytes.length, version >= 10 ? 16 : 8);        // 字符计数
  bytes.forEach((b) => push(b, 8));

  const cap = dataCapacity(version) * 8;
  push(0, Math.min(4, Math.max(0, cap - bits.length)));   // 结束符
  while (bits.length % 8 !== 0) bits.push(0);
  const pads = [0xec, 0x11];
  let pi = 0;
  while (bits.length < cap) { push(pads[pi % 2], 8); pi += 1; }

  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j += 1) v = (v << 1) | bits[i + j];
    out.push(v);
  }
  return out;
}

/* 分块 + 纠错 + 交错 (规范里最绕的一步) */
function makeCodewords(text, version) {
  const data = encodeBits(text, version);
  const ecLen = QR_EC_M[version - 1];
  const blocks = [];
  let off = 0;
  QR_BLOCKS_M[version - 1].forEach(([count, dLen]) => {
    for (let i = 0; i < count; i += 1) {
      const chunk = data.slice(off, off + dLen);
      off += dLen;
      blocks.push({ data: chunk, ec: rsEncode(chunk, ecLen) });
    }
  });
  const maxData = Math.max.apply(null, blocks.map((b) => b.data.length));
  const out = [];
  for (let i = 0; i < maxData; i += 1) blocks.forEach((b) => { if (i < b.data.length) out.push(b.data[i]); });
  for (let i = 0; i < ecLen; i += 1) blocks.forEach((b) => out.push(b.ec[i]));
  return out;
}

/* 矩阵 */
// 8 种掩码图案, 返回该格是否翻转
function maskAt(mask, r, c) {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return (((r * c) % 3) + ((r + c) % 2)) % 2 === 0;
  }
}

// BCH 校验 (格式信息 / 版本信息用)
function bch(data, g, gBits) {
  let d = data << (gBits - 1);
  const digit = (n) => { let i = 0; while (n !== 0) { i += 1; n >>>= 1; } return i; };
  while (digit(d) - digit(g) >= 0) d ^= g << (digit(d) - digit(g));
  return ((data << (gBits - 1)) | d);
}

// 建矩阵: 定位/定时/校正图案 → 占位 → 数据 (右下角起蛇形)
function buildMatrix(version, codewords, mask) {
  const size = version * 4 + 17;
  const m = [];
  const reserved = [];
  for (let i = 0; i < size; i += 1) {
    m.push(new Array(size).fill(0));
    reserved.push(new Array(size).fill(false));
  }
  const setF = (r, c, v) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    m[r][c] = v ? 1 : 0;
    reserved[r][c] = true;
  };

  // 定位图案 (含分隔符)
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const ring = (r === 0 || r === 6 || c === 0 || c === 6) && r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        setF(r0 + r, c0 + c, ring || core);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // 定时图案
  for (let i = 8; i < size - 8; i += 1) {
    setF(6, i, i % 2 === 0);
    setF(i, 6, i % 2 === 0);
  }

  // 校正图案
  const centers = QR_ALIGN[version - 1];
  centers.forEach((r) => {
    centers.forEach((c) => {
      const overlaps = (r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8);
      if (overlaps) return;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          setF(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    });
  });

  // 格式信息 / 版本信息先占位 (值等 mask 定了再写), 免得数据流占掉这些格子;
  // 必须跳过已占用的格子 —— (6,8) 与 (8,6) 是时序图案而不是格式信息位, 无条件 setF 会把这两个模块清零
  for (let i = 0; i <= 8; i += 1) {
    if (!reserved[8][i]) setF(8, i, 0);
    if (!reserved[i][8]) setF(i, 8, 0);
  }
  for (let i = 0; i < 8; i += 1) {
    if (!reserved[8][size - 1 - i]) setF(8, size - 1 - i, 0);
    if (!reserved[size - 1 - i][8]) setF(size - 1 - i, 8, 0);
  }
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      setF(Math.floor(i / 3), size - 11 + (i % 3), 0);
      setF(size - 11 + (i % 3), Math.floor(i / 3), 0);
    }
  }

  // 数据: 从右下角起, 两列一组蛇形往上/往下
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  const nextBit = () => {
    if (bitIdx >= totalBits) return 0;
    const b = codewords[bitIdx >> 3];
    const v = (b >> (7 - (bitIdx & 7))) & 1;
    bitIdx += 1;
    return v;
  };
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (let i = 0; i < size; i += 1) {
      const row = upward ? size - 1 - i : i;
      for (let k = 0; k < 2; k += 1) {
        const c = col - k;
        if (reserved[row][c]) continue;
        const v = nextBit();
        m[row][c] = maskAt(mask, row, c) ? (v ^ 1) : v;
      }
    }
    upward = !upward;
  }
  return { m, size };
}

// 写格式信息 (纠错等级 M + 掩码编号)
function placeFormat(m, size, mask) {
  const bits = bch(mask, 0b10100110111, 11) ^ 0b101010000010010;   // 等级 M(0) + mask
  for (let i = 0; i < 15; i += 1) {
    const bit = (bits >> i) & 1;
    if (i < 6) m[i][8] = bit;
    else if (i < 8) m[i + 1][8] = bit;
    else m[size - 15 + i][8] = bit;

    if (i < 8) m[8][size - i - 1] = bit;
    else if (i < 9) m[8][15 - i] = bit;
    else m[8][15 - i - 1] = bit;
  }
  m[size - 8][8] = 1;   // 固定黑点
}

// 写版本信息 (版本 ≥ 7 才有)
function placeVersion(m, size, version) {
  const bits = bch(version, 0b1111100100101, 13);
  for (let i = 0; i < 18; i += 1) {
    const bit = (bits >> i) & 1;
    m[Math.floor(i / 3)][size - 11 + (i % 3)] = bit;
    m[size - 11 + (i % 3)][Math.floor(i / 3)] = bit;
  }
}

/* 掩码选优用的「罚分」—— 分高低只影响观感, 挑哪个都是合法二维码 */
function penalty(m, size) {
  let p = 0;
  const run = (get) => {
    for (let a = 0; a < size; a += 1) {
      let len = 1;
      for (let b = 1; b < size; b += 1) {
        if (get(a, b) === get(a, b - 1)) len += 1;
        else { if (len >= 5) p += 3 + (len - 5); len = 1; }
      }
      if (len >= 5) p += 3 + (len - 5);
    }
  };
  run((a, b) => m[a][b]);
  run((a, b) => m[b][a]);
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) p += 3;
    }
  }
  const pat = [1, 0, 1, 1, 1, 0, 1];
  const seq = (get) => {
    for (let a = 0; a < size; a += 1) {
      for (let b = 0; b + 11 <= size; b += 1) {
        let hit = 0;
        for (let k = 0; k < 7; k += 1) {
          if (get(a, b + k) !== pat[k]) { hit = -1; break; }
        }
        if (hit === -1) continue;
        let ok = true;
        for (let k = 7; k <= 10; k += 1) if (get(a, b + k) !== 0) ok = false;
        if (ok) { p += 40; continue; }
        let ok2 = true;
        for (let k = 0; k <= 3; k += 1) if (get(a, b + k) !== 0) ok2 = false;
        if (ok2) p += 40;
      }
    }
  };
  seq((a, b) => m[a][b]);
  seq((a, b) => m[b][a]);
  let dark = 0;
  for (let r = 0; r < size; r += 1) for (let c = 0; c < size; c += 1) if (m[r][c]) dark += 1;
  p += Math.floor(Math.abs(dark / (size * size) * 100 - 50) / 5) * 10;
  return p;
}

// 选版本 → 分块纠错 → 8 个掩码挑罚分最低的
function qrMatrix(text) {
  const len = new TextEncoder().encode(text).length;
  let version = 0;
  for (let v = 1; v <= 10; v += 1) {
    const need = 4 + (v >= 10 ? 16 : 8) + len * 8;
    if (need <= dataCapacity(v) * 8) { version = v; break; }
  }
  if (!version) return null;   // 太长 (v10 上限 216 字节, otpauth 链接远够)

  const codewords = makeCodewords(text, version);
  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const built = buildMatrix(version, codewords, mask);
    placeFormat(built.m, built.size, mask);
    if (version >= 7) placeVersion(built.m, built.size, version);
    const score = penalty(built.m, built.size);
    if (!best || score < best.score) best = { m: built.m, score };
  }
  return best.m;
}

/* 对外: 文本 → 一段 SVG (白底黑块 + 2 格静默区) */
function qrSvg(text, opts) {
  const m = qrMatrix(String(text));
  if (!m) return '';
  const size = m.length;
  const quiet = 2;
  const scale = (opts && opts.scale) || 5;
  const total = (size + quiet * 2) * scale;
  let path = '';
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (!m[r][c]) continue;
      path += 'M' + ((c + quiet) * scale) + ' ' + ((r + quiet) * scale) + 'h' + scale + 'v' + scale + 'h-' + scale + 'z';
    }
  }
  return '<svg class="totp-qr-svg" viewBox="0 0 ' + total + ' ' + total + '" width="' + total + '" height="' + total
    + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="动态令牌二维码">'
    + '<rect width="' + total + '" height="' + total + '" fill="#ffffff"/>'
    + '<path d="' + path + '" fill="#000000"/></svg>';
}
