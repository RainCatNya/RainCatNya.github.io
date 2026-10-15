/* totp.js 动态令牌 (TOTP) */
/*
  内容: 生成二维码 / 预校验 / 确认启用 / 敏感操作校验 (RFC 6238, 前后各容一个窗口)
  依赖: ../common.js(getSessionUser); 密钥经 AES-GCM 加密入库, 不存明文
*/

import { getSessionUser, issueVerifyPass } from '../common.js';

// Base32 字母表
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
// 二维码只活 2 分钟 (要让用户立即扫码)
const TOTP_PENDING_MS = 2 * 60 * 1000;
// 一个码的有效步长
const TOTP_PERIOD_MS = 30 * 1000;

// 字节数组 -> 十六进制串
function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 十六进制串 -> 字节数组
function hexToBytes(hex) {
  const s = String(hex || '');
  const out = new Uint8Array(Math.floor(s.length / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

// Base32 编码 (RFC 4648, 无填充)
function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

// Base32 解码 (忽略字母表外的字符)
function base32Decode(text) {
  const clean = String(text || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  const out = [];
  let bits = 0;
  let value = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const idx = B32.indexOf(clean[i]);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

// 密钥材料 = 服务端密钥 + 这一行的盐; 优先 TOTP_KEY, 没配就退到已有的服务端密钥
async function totpAesKey(env, saltHex) {
  const base = String(env.TOTP_KEY || env.OSS_ACCESS_KEY_SECRET || env.CF_API_TOKEN || 'foraine-totp');
  const material = new TextEncoder().encode(base + '|' + saltHex);
  const digest = await crypto.subtle.digest('SHA-256', material);
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// AES-GCM 加密, 返回 { 密文, iv }
async function encryptSecret(env, saltHex, plain) {
  const key = await totpAesKey(env, saltHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain));
  return { ct: bytesToHex(new Uint8Array(ct)), iv: bytesToHex(iv) };
}

// AES-GCM 解密
async function decryptSecret(env, saltHex, ivHex, ctHex) {
  const key = await totpAesKey(env, saltHex);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: hexToBytes(ivHex) }, key, hexToBytes(ctHex));
  return new TextDecoder().decode(plain);
}

/* RFC 6238: HMAC-SHA1(密钥, 计数器) -> 动态截断 -> 6 位 */
async function totpCode(secret, counter) {
  const key = await crypto.subtle.importKey(
    'raw', base32Decode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  );
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 1000000).padStart(6, '0');
}

// 当下这个 30 秒窗口的码
async function currentTotpCode(secret) {
  return totpCode(secret, Math.floor(Date.now() / TOTP_PERIOD_MS));
}

// asyfunc 生成二维码(每次换新密钥, 顺手覆盖上一次未确认的那行): POST /api/totp/setup
async function handleTotpSetup(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });

  const secret = base32Encode(crypto.getRandomValues(new Uint8Array(20)));
  const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const sealed = await encryptSecret(env, salt, secret);

  try {
    await env.DB.prepare(
      `INSERT INTO totp (user_id, secret_enc, iv, salt, enabled, created_at) VALUES (?, ?, ?, ?, 0, ?)
       ON CONFLICT(user_id) DO UPDATE SET secret_enc = excluded.secret_enc, iv = excluded.iv,
         salt = excluded.salt, enabled = 0, created_at = excluded.created_at`
    ).bind(user.id, sealed.ct, sealed.iv, salt, Date.now()).run();
  } catch (err) {
    console.error('TOTP 写入失败:', err && (err.message || err));
    return Response.json({ error: '统计表还没建（totp）' }, { status: 503 });
  }

  const label = encodeURIComponent('Foraine:' + user.username);
  const url = 'otpauth://totp/' + label + '?secret=' + secret
    + '&issuer=Foraine&algorithm=SHA1&digits=6&period=30';
  return Response.json({ ok: true, secret, url, pending_ms: TOTP_PENDING_MS });
}

/* 只验待确认的那一行 (enabled = 0): 输了码前端才让点「确认」 */
// asyfunc 预校验待绑定的码(只验不改状态): POST /api/totp/check
// 没做限流: 能调到这里的人已经有会话 Cookie, 真要防爆破再补 rate_limits
async function handleTotpCheck(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const code = String(body.code || '').trim();
  if (!/^\d{6}$/.test(code)) return Response.json({ error: '请输入 6 位数字' }, { status: 400 });

  try {
    const row = await env.DB.prepare(
      'SELECT secret_enc, iv, salt, enabled, created_at FROM totp WHERE user_id = ?'
    ).bind(user.id).first();
    if (!row) return Response.json({ error: '先点「动态令牌」生成二维码' }, { status: 400 });
    if (row.enabled) return Response.json({ error: '动态令牌已绑定' }, { status: 400 });
    if (Date.now() - (row.created_at || 0) > TOTP_PENDING_MS) {
      return Response.json({ error: '二维码已过期，请重新打开「动态令牌」' }, { status: 400 });
    }
    const secret = await decryptSecret(env, row.salt, row.iv, row.secret_enc);
    if (!(await totpCodeMatches(secret, code))) {
      return Response.json({ error: I18N.t('oast.error-WrongCode') }, { status: 403 });
    }
    return Response.json({ ok: true });
  } catch (err) {
    console.error('TOTP 预先校验失败:', err && (err.message || err));
    return Response.json({ error: '操作失败' }, { status: 500 });
  }
}

/* 容忍前后各一个 30 秒窗口的时钟偏差 */
async function totpCodeMatches(secret, code) {
  const step = Math.floor(Date.now() / TOTP_PERIOD_MS);
  for (let d = -1; d <= 1; d += 1) {
    if (await totpCode(secret, step + d) === String(code || '').trim()) return true;
  }
  return false;
}

// asyfunc 确认启用(必须带码, 不然等于把用不了的钥匙钉死在账号上): POST /api/totp/enable
async function handleTotpEnable(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const code = String(body.code || '').trim();

  try {
    const row = await env.DB.prepare('SELECT secret_enc, iv, salt, created_at FROM totp WHERE user_id = ?')
      .bind(user.id).first();
    if (!row) return Response.json({ error: '先点「动态令牌」生成二维码' }, { status: 400 });
    if (Date.now() - (row.created_at || 0) > TOTP_PENDING_MS) {
      return Response.json({ error: '二维码已过期，请重新打开「动态令牌」' }, { status: 400 });
    }
    if (code) {
      const secret = await decryptSecret(env, row.salt, row.iv, row.secret_enc);
      const step = Math.floor(Date.now() / TOTP_PERIOD_MS);
      let matched = false;
      for (let d = -1; d <= 1; d += 1) {
        if (await totpCode(secret, step + d) === code) { matched = true; break; }
      }
      if (!matched) return Response.json({ error: I18N.t('oast.error-WrongCode') }, { status: 403 });
    } else {
      // 不带码 = 没验过就绑 -> 一律挡下
      return Response.json({ error: '请输入验证码后再绑定' }, { status: 400 });
    }
    await env.DB.prepare('UPDATE totp SET enabled = 1 WHERE user_id = ?').bind(user.id).run();
    return Response.json({ ok: true, enabled: true });
  } catch (err) {
    console.error('TOTP 启用失败:', err && (err.message || err));
    return Response.json({ error: '操作失败' }, { status: 500 });
  }
}

// 「敏感操作验证」与「注销」共用: 这个号当下的码对不对 (没启用直接 false)
async function verifyTotpForUser(env, userId, code) {
  const row = await env.DB.prepare('SELECT secret_enc, iv, salt, enabled FROM totp WHERE user_id = ?')
    .bind(userId).first();
  if (!row || !row.enabled) return false;
  const secret = await decryptSecret(env, row.salt, row.iv, row.secret_enc);
  return totpCodeMatches(secret, code);
}

// asyfunc 敏感操作前验令牌(只验不改状态): POST /api/totp/verify
// 没做限流: 能调到这里的人已经有会话 Cookie, 真要防爆破再补 rate_limits
async function handleTotpVerify(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: '未登录' }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const code = String(body.code || '').trim();
  if (!/^\d{6}$/.test(code)) return Response.json({ error: '请输入 6 位数字' }, { status: 400 });
  try {
    const ok = await verifyTotpForUser(env, user.id, code);
    if (!ok) return Response.json({ error: I18N.t('oast.error-WrongCode') }, { status: 403 });
    return Response.json({ ok: true, pass: await issueVerifyPass(env, user.id, 'totp') });
  } catch (err) {
    console.error('TOTP 校验失败:', err && (err.message || err));
    return Response.json({ error: '操作失败' }, { status: 500 });
  }
}

// 给 /api/me 用: 有没有启用动态令牌 (表没建就当没有, 绝不能连累登录)
async function totpEnabled(env, userId) {
  try {
    const row = await env.DB.prepare('SELECT enabled FROM totp WHERE user_id = ?').bind(userId).first();
    return !!(row && row.enabled);
  } catch (err) {
    return false;
  }
}

export { handleTotpSetup, handleTotpEnable, handleTotpVerify, handleTotpCheck, verifyTotpForUser, totpEnabled, totpCode, currentTotpCode, base32Encode, base32Decode };
