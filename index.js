/**
 * ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
 * ┃  MEGH X-MINI  ·  Premium Mini WhatsApp Bot  ·  Owner-Only  ┃
 * ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
 *
 * Single-file ESM bot. Uses official @whiskeysockets/baileys (ESM).
 * Chrome browser fingerprint. SQLite for settings. Session ID decode.
 * createFakeContact on all replies. Owner-only command enforcement.
 *
 * Boot flow:
 *  1. Print premium banner
 *  2. Read SESSION_ID from env OR prompt via TTY
 *  3. Decode + write auth state
 *  4. Connect Baileys with Chrome fingerprint
 *  5. Send CONNECTED banner to owner
 *  6. Listen for commands (owner-only)
 */

'use strict';

// Suppress noisy deprecation warnings from better-sqlite3
process.removeAllListeners('warning');
process.env.NODE_NO_WARNINGS = '1';
const _origEmit = process.emit;
process.emit = function (name, ...args) {
  if (name === 'warning' && args[0]?.name === 'DeprecationWarning') return false;
  return _origEmit.apply(process, [name, ...args]);
};

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import P from 'pino';
import Database from 'better-sqlite3';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  proto
} from '@whiskeysockets/baileys';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── CONFIG ─────────────────────────────────────────────────────────
const CONFIG = {
  botName: process.env.BOT_NAME || 'MEGH X-MINI',
  botVersion: '1.0.0',
  ownerName: process.env.OWNER_NAME || '®killer',
  ownerNumber: process.env.OWNER_NUMBER || '254795314221',
  prefix: process.env.PREFIX || '.',
  mode: 'private', // 'private' = owner-only, 'public' = everyone
  sessionId: process.env.SESSION_ID || '',
  supportUrl: 'https://wa.me/message/25495314221',
  pairingUrl: process.env.PAIRING_URL || 'https://megh-ultrax.onrender.com/',
  repoUrl: 'https://github.com/yobbyking/megh-x-mini',
  menuImageUrl: 'https://raw.githubusercontent.com/yobbyking/tool/main/IMG-20260918-WA0025.png',
  dataDir: path.resolve(process.cwd(), 'data'),
  authDir: path.resolve(process.cwd(), 'auth'),
  dbPath: path.resolve(process.cwd(), 'data', 'bot.db'),
  baileysLogLevel: 'warn',
  browser: Browsers.appropriate('Chrome')
};

// ─── ANSI ──────────────────────────────────────────────────────────
const ANSI = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[38;2;0;229;255m', violet: '\x1b[38;2;168;85;247m',
  gold: '\x1b[38;2;245;197;66m', green: '\x1b[38;2;80;200;120m',
  red: '\x1b[38;2;255;80;80m', muted: '\x1b[38;2;148;163;184m',
  white: '\x1b[38;2;226;232;240m', bgPanel: '\x1b[48;2;14;14;28m',
};
const BW = 64;
const GRAD = [[0,229,255],[60,180,255],[110,130,255],[170,90,255],[220,90,255],[170,90,255],[110,130,255],[60,180,255],[0,229,255]];
const stripAnsi = s => String(s).replace(/\x1b\[[0-9;]*m/g, '');

function gradientBar(rev=false){const c=rev?[...GRAD].reverse():GRAD;const w=Math.max(1,Math.ceil(BW/c.length));let b='';for(const[r,g,b2]of c)b+='\x1b[48;2;'+r+';'+g+';'+b2+'m'+' '.repeat(w);return b+ANSI.reset;}
function darkRow(content='',opts={}){const{fg=ANSI.white,bold=false}=opts;const p=(bold?ANSI.bold:'')+fg;const vl=stripAnsi(content).length;const pad=Math.max(0,BW-vl);return ANSI.bgPanel+p+content+ANSI.reset+' '.repeat(pad)+ANSI.reset;}
function darkEmptyRow(){return ANSI.bgPanel+' '.repeat(BW)+ANSI.reset;}
function centeredRow(content,opts={}){const{fg=ANSI.white,bold=false,glow=false}=opts;const c=glow?ANSI.cyan:fg;const vl=stripAnsi(content).length;const pad=Math.max(0,Math.floor((BW-vl)/2));const padE=Math.max(0,BW-vl-pad);const p=(bold?ANSI.bold:'')+c;return ANSI.bgPanel+' '.repeat(pad)+p+content+ANSI.reset+' '.repeat(padE)+ANSI.reset;}

function printBanner(){console.log(['',gradientBar(false),gradientBar(false),darkEmptyRow(),centeredRow('✦  MEGH X-MINI  ✦',{fg:ANSI.cyan,bold:true}),centeredRow('Premium Mini Bot  ·  v'+CONFIG.botVersion,{fg:ANSI.violet}),centeredRow('Chrome Baileys  ·  Owner-Only',{fg:ANSI.muted}),darkEmptyRow(),gradientBar(true),gradientBar(true),''].join('\n'));}
function printSessionPrompt(){console.log(['',gradientBar(false),gradientBar(false),darkEmptyRow(),centeredRow('◈  SESSION REQUIRED  ◈',{fg:ANSI.cyan,bold:true}),darkEmptyRow(),darkRow('  ➤ Pair on the site:',{fg:ANSI.muted,bold:true}),darkRow('    '+CONFIG.pairingUrl,{fg:ANSI.cyan,bold:true}),darkEmptyRow(),darkRow('  ➤ Format:',{fg:ANSI.muted,bold:true}),darkRow('    megh-ultra:~<code>~<base64>',{fg:ANSI.violet}),darkEmptyRow(),darkRow('  ➤ Support:  '+CONFIG.supportUrl,{fg:ANSI.muted}),darkEmptyRow(),gradientBar(true),gradientBar(true),''].join('\n'));}
function printFailure(msg){console.log(['',gradientBar(false),gradientBar(false),darkEmptyRow(),centeredRow('✗  FAILED  ✗',{fg:ANSI.red,bold:true}),darkEmptyRow(),darkRow('  '+String(msg).slice(0,56),{fg:ANSI.red}),darkRow('  ⌁ Please retry — panel will restart on exit.',{fg:ANSI.gold}),darkEmptyRow(),gradientBar(true),gradientBar(true),''].join('\n'));}
function printConnected(o){const pad=(s,n)=>String(s).padEnd(n).slice(0,n);console.log(['',gradientBar(false),gradientBar(false),darkEmptyRow(),centeredRow('✧  CONNECTED  ✧',{fg:ANSI.green,bold:true,glow:true}),darkEmptyRow(),darkRow('  ➤ Bot:      '+pad(o.botName,30),{fg:ANSI.white}),darkRow('  ➤ Prefix:   [ '+o.prefix+' ]',{fg:ANSI.cyan}),darkRow('  ➤ Owner:    '+pad(o.ownerName,30),{fg:ANSI.cyan,bold:true}),darkRow('  ➤ Platform: 🖥  Panel',{fg:ANSI.white}),darkRow('  ➤ Status:   online',{fg:ANSI.green,bold:true}),darkRow('  ➤ Time:     '+pad(o.time,30),{fg:ANSI.muted}),darkRow('  ➤ Repo:     '+pad(o.repo,50),{fg:ANSI.violet}),darkEmptyRow(),gradientBar(true),gradientBar(true),''].join('\n'));}

// ─── SMALL CAPS (cool fonts) ────────────────────────────────────────
const SC = {a:'ᴀ',b:'ʙ',c:'ᴄ',d:'ᴅ',e:'ᴇ',f:'ꜰ',g:'ɢ',h:'ʜ',i:'ɪ',j:'ᴊ',k:'ᴋ',l:'ʟ',m:'ᴍ',n:'ɴ',o:'ᴏ',p:'ᴘ',q:'ǫ',r:'ʀ',s:'s',t:'ᴛ',u:'ᴜ',v:'ᴠ',w:'ᴡ',x:'x',y:'ʏ',z:'ᴢ'};
const smallCaps = s => String(s).split('').map(c => SC[c.toLowerCase()] || c).join('');

// ─── SQLite ────────────────────────────────────────────────────────
fs.mkdirSync(CONFIG.dataDir, { recursive: true });
const db = new Database(CONFIG.dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS users (jid TEXT PRIMARY KEY, name TEXT, is_sudo INTEGER DEFAULT 0, is_blocked INTEGER DEFAULT 0, warns INTEGER DEFAULT 0, dp_base64 TEXT, created_at INTEGER);
  CREATE TABLE IF NOT EXISTS groups_tbl (jid TEXT PRIMARY KEY, name TEXT, anti_link INTEGER DEFAULT 0, anti_badword INTEGER DEFAULT 0, anti_bot INTEGER DEFAULT 0, anti_spam INTEGER DEFAULT 0, created_at INTEGER);
`);

const setS = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
const getS = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSetting = (k, v) => setS.run(k, String(v));
const getSetting = (k, fb = null) => { const r = getS.get(k); return r ? r.value : fb; };

// ─── Session ID validation + decode ─────────────────────────────────
function validateSessionId(raw) {
  if (!raw || !raw.startsWith('megh-ultra:~')) return { ok: false, error: 'Invalid prefix — expected "megh-ultra:~…"' };
  const rest = raw.slice('megh-ultra:~'.length);
  const sep = rest.indexOf('~');
  if (sep === -1) return { ok: false, error: 'Missing delimiter "~"' };
  const code = rest.slice(0, sep);
  const credsBase64 = rest.slice(sep + 1);
  if (code.length < 8) return { ok: false, error: 'Session code too short' };
  if (credsBase64.length < 100) return { ok: false, error: 'Credential payload too short' };
  let decoded;
  try { decoded = JSON.parse(Buffer.from(credsBase64, 'base64url').toString('utf8')); }
  catch { return { ok: false, error: 'Failed to decode — invalid base64' }; }
  if (!decoded.creds || !decoded.creds.me) return { ok: false, error: 'Credential JSON missing required fields' };
  return { ok: true, sessionId: raw, code, credsBase64, decoded };
}

function persistAuthState(decoded) {
  fs.mkdirSync(CONFIG.authDir, { recursive: true });
  if (decoded.creds) fs.writeFileSync(path.join(CONFIG.authDir, 'creds.json'), JSON.stringify(decoded.creds, null, 2));
  if (!decoded.keys) return;
  if (Array.isArray(decoded.keys)) {
    for (const [k, v] of decoded.keys) fs.writeFileSync(path.join(CONFIG.authDir, k + '.json'), JSON.stringify(v, null, 2));
  } else if (typeof decoded.keys === 'object' && decoded.keys !== null) {
    for (const [k, v] of Object.entries(decoded.keys)) fs.writeFileSync(path.join(CONFIG.authDir, k + '.json'), JSON.stringify(v, null, 2));
  }
}

// ─── createFakeContact (used in ALL replies) ────────────────────────
function createFakeContact(msg) {
  const botName = getSetting('botName', CONFIG.botName) || CONFIG.botName;
  const participantId = (msg && (msg.key.participant || msg.key.remoteJid)) || '0';
  const cleanId = String(participantId).split(':')[0].split('@')[0] || '0';
  return {
    key: {
      participants: '0@s.whatsapp.net',
      remoteJid: '0@s.whatsapp.net',
      fromMe: false,
      id: 'MEGHXMINI' + Math.random().toString(36).substring(2, 12).toUpperCase()
    },
    message: {
      contactMessage: {
        displayName: botName,
        vcard: `BEGIN:VCARD\nVERSION:3.0\nN:Sy;Bot;;;\nFN:${botName}\nitem1.TEL;waid=${cleanId}:${cleanId}\nitem1.X-ABLabel:Phone\nEND:VCARD`
      }
    },
    participant: '0@s.whatsapp.net'
  };
}

// ─── Owner check ───────────────────────────────────────────────────
function isOwner(jid) {
  const num = String(jid).split(':')[0].split('@')[0];
  const ownerNum = getSetting('ownerNumber', CONFIG.ownerNumber);
  // Check against env owner + paired account (from auth creds)
  if (num === ownerNum) return true;
  // Also check if this is the paired WhatsApp account
  try {
    const credsPath = path.join(CONFIG.authDir, 'creds.json');
    if (fs.existsSync(credsPath)) {
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      if (creds.me?.id && String(creds.me.id).split(':')[0] === num) return true;
    }
  } catch {}
  return false;
}

function getMode() { return getSetting('mode', CONFIG.mode); }

// ─── Helpers ────────────────────────────────────────────────────────
function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(d + 'd');
  if (h) parts.push(h + 'h');
  if (m) parts.push(m + 'm');
  parts.push((s % 60) + 's');
  return parts.join(' ');
}

function phoneToJid(phone) {
  let p = String(phone).replace(/\D/g, '');
  if (p.startsWith('00')) p = p.slice(2);
  return p + '@s.whatsapp.net';
}

async function downloadMenuImage() {
  const cachePath = path.join(CONFIG.dataDir, 'menu-image.png');
  if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 1000) {
    return fs.readFileSync(cachePath);
  }
  try {
    console.log('  ℹ Downloading menu image...');
    const res = await fetch(CONFIG.menuImageUrl);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(cachePath, buf);
    console.log('  ✓ Menu image cached (' + (buf.length / 1024).toFixed(1) + ' KB)');
    return buf;
  } catch (e) {
    console.log('  ⚠ Menu image download failed: ' + e.message);
    return null;
  }
}

function getMenuImage() {
  const cachePath = path.join(CONFIG.dataDir, 'menu-image.png');
  if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 1000) {
    return fs.readFileSync(cachePath);
  }
  return null;
}

// ─── MENU ──────────────────────────────────────────────────────────
const COMMAND_LIST = {
  main: ['menu', 'all', 'ping', 'repo', 'alive', 'pair', 'owner', 'runtime'],
  ai: ['ai', 'gpt', 'gemini', 'blackbox', 'deepseek', 'llama', 'mistral', 'translate', 'summarize', 'story', 'joke', 'quote', 'fact', 'dare', 'truth'],
  group: ['kick', 'add', 'promote', 'demote', 'mute', 'unmute', 'tagall', 'hidetag', 'invite', 'close', 'open', 'tosgroup', 'setname', 'setdesc'],
  admin: ['setprefix', 'setbotname', 'setownername', 'setprofilepic', 'setmenuimage', 'setstatus', 'mode'],
  anti: ['antidelete', 'antilink', 'antibadword', 'anticall', 'antibot', 'antispam', 'autoread', 'autotyping', 'autorecording', 'chatbot'],
  media: ['sticker', 'tovv', 'vv', 'song', 'getdp', 'toimage', 'toaudio', 'tomp3', 'emojimix'],
  tools: ['tls', 'qr', 'calc', 'weather', 'google', 'ytsearch', 'tiktok', 'ss'],
  fun: ['8ball', 'coinflip', 'dice', 'rps', 'ship', 'waste', 'horny', 'gay', 'smart'],
  info: ['whoami', 'profile', 'groupinfo', 'userinfo', 'botinfo'],
};

const CAT_EMOJI = { main:'🤖', ai:'🧠', group:'👥', admin:'⚙️', anti:'🛡️', media:'🎬', tools:'🔧', fun:'🎮', info:'ℹ️' };
const CAT_NAME = { main:'MAIN', ai:'AI', group:'GROUP', admin:'ADMIN', anti:'ANTI', media:'MEDIA', tools:'TOOLS', fun:'FUN', info:'INFO' };

function buildMainMenu(sock, msg) {
  const ownerName = getSetting('ownerName', CONFIG.ownerName);
  const prefix = getSetting('prefix', CONFIG.prefix);
  const mode = getMode();
  const mem = process.memoryUsage();
  const memMB = (mem.rss / 1024 / 1024).toFixed(0);
  const uptime = fmtUptime(process.uptime() * 1000);
  const speedMs = (process.hrtime()[1] / 1e6).toFixed(4);
  const ramPct = Math.min(100, Math.round((mem.rss / (1024 * 1024 * 512)) * 100));
  const ramBar = '█'.repeat(Math.round(ramPct / 10)) + '░'.repeat(10 - Math.round(ramPct / 10));
  const totalCmds = Object.values(COMMAND_LIST).reduce((a, b) => a + b.length, 0);

  return `┏▣ ◈ *${CONFIG.botName.replace(/\s+/g, '_').toUpperCase()}* ◈
┃ *ᴏᴡɴᴇʀ* : ${ownerName}
┃ *ᴘʀᴇғɪx* : [ ${prefix} ]
┃ *ʜᴏsᴛ* : Panel
┃ *ᴘʟᴜɢɪɴs* : ${totalCmds}
┃ *ᴍᴏᴅᴇ* : ${mode === 'private' ? 'Private' : 'Public'}
┃ *ᴠᴇʀsɪᴏɴ* : ${CONFIG.botVersion}
┃ *sᴘᴇᴇᴅ* : ${speedMs} ms
┃ *ᴜsᴀɢᴇ* : ${memMB} MB
┃ *ʀᴀᴍ* : [${ramBar}] ${ramPct}%
┃ *ᴜᴘᴛɪᴍᴇ* : ${uptime}
┗▣

_*Type ${prefix}all to see all commands*_`;
}

function buildFullMenu() {
  const prefix = getSetting('prefix', CONFIG.prefix);
  const cats = Object.keys(COMMAND_LIST);
  let out = `┏━━━━━━━✧ *${CONFIG.botName} ALL COMMANDS* ✧━━━━━━━\n\n`;

  // Two-column layout: pair up categories
  for (let i = 0; i < cats.length; i += 2) {
    const left = cats[i];
    const right = cats[i + 1];
    const leftCmds = COMMAND_LIST[left];
    const rightCmds = right ? COMMAND_LIST[right] : [];
    const maxRows = Math.max(leftCmds.length, rightCmds.length);

    // Header row
    const leftHeader = `${CAT_EMOJI[left]} *${smallCaps(CAT_NAME[left])} MENU*`;
    const rightHeader = right ? `${CAT_EMOJI[right]} *${smallCaps(CAT_NAME[right])} MENU*` : '';
    out += `${leftHeader.padEnd(28)} ${rightHeader}\n`;

    // Command rows
    for (let j = 0; j < maxRows; j++) {
      const lc = leftCmds[j] ? `│✦ ${smallCaps(leftCmds[j])}` : '';
      const rc = rightCmds[j] ? `│✦ ${smallCaps(rightCmds[j])}` : '';
      out += `${lc.padEnd(28)} ${rc}\n`;
    }
    out += '\n';
  }
  out += `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n_Type *${prefix}menu* for main menu_`;
  return out;
}

// ─── Command handlers ───────────────────────────────────────────────
const COMMANDS = {};

function cmd(name, aliases, desc, handler) {
  COMMANDS[name.toLowerCase()] = { name, aliases, desc, handler };
  if (aliases) for (const a of aliases) COMMANDS[a.toLowerCase()] = { name, aliases, desc, handler, isAlias: true };
}

// Helper: reply with fake contact
async function reply(sock, msg, text, options = {}) {
  return sock.sendMessage(msg.key.remoteJid, { text, ...options }, { quoted: createFakeContact(msg) });
}

// Helper: reply with image
async function replyImage(sock, msg, imageBuffer, caption, options = {}) {
  return sock.sendMessage(msg.key.remoteJid, { image: imageBuffer, caption, ...options }, { quoted: createFakeContact(msg) });
}

// ─── MAIN COMMANDS ──────────────────────────────────────────────────
cmd('menu', ['help'], 'Show main menu', async (sock, msg, args, ctx) => {
  const text = buildMainMenu(sock, msg);
  const img = getMenuImage();
  if (img) {
    await replyImage(sock, msg, img, text);
  } else {
    await reply(sock, msg, text);
  }
});

cmd('all', ['menuall', 'commands'], 'Show all commands', async (sock, msg) => {
  await reply(sock, msg, buildFullMenu());
});

cmd('ping', ['speed'], 'Check bot speed', async (sock, msg) => {
  const start = process.hrtime();
  const uptime = fmtUptime(process.uptime() * 1000);
  const end = process.hrtime(start);
  const ms = (end[0] * 1000 + end[1] / 1e6).toFixed(2);
  await reply(sock, msg, `🏓 *PONG!*\n\n┃✧ Speed: ${ms} ms\n┃✧ Uptime: ${uptime}\n┃✧ RAM: ${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)} MB`);
});

cmd('repo', ['repository', 'source'], 'Show repo info', async (sock, msg) => {
  await reply(sock, msg, `┏━━━━━✧ *REPO INFO* ✧━━━━━
┃✧ Bot: ${CONFIG.botName}
┃✧ Version: ${CONFIG.botVersion}
┃✧ Owner: ${getSetting('ownerName', CONFIG.ownerName)}
┃✧ Owner Number: ${getSetting('ownerNumber', CONFIG.ownerNumber)}
┃✧ Repo: ${CONFIG.repoUrl}
┃✧ Pairing: ${CONFIG.pairingUrl}
┃✧ Support: ${CONFIG.supportUrl}
┗━━━━━━━━━━━━━━━━━━━━━━━━`);
});

cmd('alive', ['status'], 'Bot status', async (sock, msg) => {
  const mem = (process.memoryUsage().rss / 1024 / 1024).toFixed(0);
  await reply(sock, msg, `🟢 *${CONFIG.botName} is alive!*\n\n┃✧ Uptime: ${fmtUptime(process.uptime() * 1000)}\n┃✧ RAM: ${mem} MB\n┃✧ Mode: ${getMode()}\n┃✧ Version: ${CONFIG.botVersion}`);
});

cmd('owner', ['creator'], 'Show owner info', async (sock, msg) => {
  await reply(sock, msg, `┏━━━━━✧ *OWNER* ✧━━━━━\n┃✧ Name: ${getSetting('ownerName', CONFIG.ownerName)}\n┃✧ Number: ${getSetting('ownerNumber', CONFIG.ownerNumber)}\n┃✧ WhatsApp: wa.me/${getSetting('ownerNumber', CONFIG.ownerNumber)}\n┗━━━━━━━━━━━━━━━━━━━━━━━━`);
});

cmd('runtime', ['uptime'], 'Show bot runtime', async (sock, msg) => {
  await reply(sock, msg, `⏱️ *Runtime:* ${fmtUptime(process.uptime() * 1000)}`);
});

// ─── PAIR ───────────────────────────────────────────────────────────
cmd('pair', ['paircode'], 'Get pairing link for another user', async (sock, msg, args) => {
  const phone = (args[0] || '').replace(/\D/g, '');
  if (!phone) {
    await reply(sock, msg, `🔗 *Pairing Site*\n\nVisit: ${CONFIG.pairingUrl}\n\nEnter your phone number → get an 8-char code → enter in WhatsApp → Linked Devices → Link with phone number.\n\nYou'll receive your SESSION_ID via WhatsApp.`);
    return;
  }
  // Generate a pairing code for the given phone using the bot's socket
  try {
    await sock.sendPresenceUpdate('composing', msg.key.remoteJid);
    const code = await sock.requestPairingCode(phone);
    const pretty = code.length === 8 ? code.slice(0,4) + '-' + code.slice(4) : code;
    await reply(sock, msg, `📲 *Pairing Code for +${phone}*\n\nCode: *${pretty}*\n\n1. Open WhatsApp on +${phone}\n2. Settings → Linked Devices → Link a Device\n3. Tap "Link with phone number instead"\n4. Enter the code above\n\n⏱️ Code expires in 90 seconds.`);
  } catch (e) {
    await reply(sock, msg, `❌ Failed to generate pairing code: ${e.message}\n\nVisit ${CONFIG.pairingUrl} to pair instead.`);
  }
});

// ─── ADMIN COMMANDS ─────────────────────────────────────────────────
cmd('setprefix', ['prefix'], 'Set command prefix', async (sock, msg, args) => {
  const newPrefix = args[0];
  if (!newPrefix || newPrefix.length > 4) { await reply(sock, msg, '❌ Usage: setprefix <new-prefix> (max 4 chars)'); return; }
  setSetting('prefix', newPrefix);
  await reply(sock, msg, `✅ Prefix changed to: [ ${newPrefix} ]`);
});

cmd('setbotname', ['botname'], 'Set bot name', async (sock, msg, args) => {
  const name = args.join(' ');
  if (!name) { await reply(sock, msg, '❌ Usage: setbotname <name>'); return; }
  setSetting('botName', name);
  await reply(sock, msg, `✅ Bot name changed to: ${name}`);
});

cmd('setownername', ['ownername'], 'Set owner name', async (sock, msg, args) => {
  const name = args.join(' ');
  if (!name) { await reply(sock, msg, '❌ Usage: setownername <name>'); return; }
  setSetting('ownerName', name);
  await reply(sock, msg, `✅ Owner name changed to: ${name}`);
});

cmd('setprofilepic', ['setpp', 'pp'], 'Set bot profile pic (reply to photo)', async (sock, msg) => {
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  const hasImage = msg.message?.imageMessage || quoted?.imageMessage;
  if (!hasImage) { await reply(sock, msg, '❌ Reply to a photo with this command'); return; }
  try {
    let imgBuf;
    if (msg.message.imageMessage) imgBuf = await sock.downloadMediaMessage(msg);
    else imgBuf = await sock.downloadMediaMessage({ key: msg.key, message: quoted });
    await sock.updateProfilePicture(sock.user.id, imgBuf);
    await reply(sock, msg, '✅ Profile picture updated!');
  } catch (e) { await reply(sock, msg, '❌ Failed: ' + e.message); }
});

cmd('setmenuimage', ['menuimage'], 'Set menu image (reply to photo)', async (sock, msg) => {
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  const hasImage = msg.message?.imageMessage || quoted?.imageMessage;
  if (!hasImage) { await reply(sock, msg, '❌ Reply to a photo with this command'); return; }
  try {
    let imgBuf;
    if (msg.message.imageMessage) imgBuf = await sock.downloadMediaMessage(msg);
    else imgBuf = await sock.downloadMediaMessage({ key: msg.key, message: quoted });
    fs.writeFileSync(path.join(CONFIG.dataDir, 'menu-image.png'), imgBuf);
    await reply(sock, msg, `✅ Menu image updated! (${(imgBuf.length / 1024).toFixed(0)} KB)`);
  } catch (e) { await reply(sock, msg, '❌ Failed: ' + e.message); }
});

cmd('setstatus', ['status'], 'Set bot status', async (sock, msg, args) => {
  const text = args.join(' ');
  if (!text) { await reply(sock, msg, '❌ Usage: setstatus <text>'); return; }
  try { await sock.updateProfileStatus(text); await reply(sock, msg, `✅ Status updated: ${text}`); }
  catch (e) { await reply(sock, msg, '❌ Failed: ' + e.message); }
});

cmd('mode', ['setmode'], 'Set bot mode (public/private)', async (sock, msg, args) => {
  const m = (args[0] || '').toLowerCase();
  if (m !== 'public' && m !== 'private') { await reply(sock, msg, `❌ Usage: mode public|private\nCurrent: ${getMode()}`); return; }
  setSetting('mode', m);
  await reply(sock, msg, `✅ Mode changed to: ${m}`);
});

// ─── ANTI / AUTO COMMANDS ───────────────────────────────────────────
cmd('autoread', [], 'Toggle auto-read messages', async (sock, msg) => {
  const cur = getSetting('autoread', 'off');
  const next = cur === 'on' ? 'off' : 'on';
  setSetting('autoread', next);
  await reply(sock, msg, `✅ Auto-read is now *${next.toUpperCase()}*`);
});

cmd('autotyping', [], 'Toggle auto typing indicator', async (sock, msg) => {
  const cur = getSetting('autotyping', 'off');
  const next = cur === 'on' ? 'off' : 'on';
  setSetting('autotyping', next);
  await reply(sock, msg, `✅ Auto-typing is now *${next.toUpperCase()}*`);
});

cmd('autorecording', [], 'Toggle auto recording indicator', async (sock, msg) => {
  const cur = getSetting('autorecording', 'off');
  const next = cur === 'on' ? 'off' : 'on';
  setSetting('autorecording', next);
  await reply(sock, msg, `✅ Auto-recording is now *${next.toUpperCase()}*`);
});

cmd('chatbot', ['autoreply'], 'Toggle auto-reply chatbot', async (sock, msg) => {
  const cur = getSetting('chatbot', 'off');
  const next = cur === 'on' ? 'off' : 'on';
  setSetting('chatbot', next);
  await reply(sock, msg, `✅ Chatbot is now *${next.toUpperCase()}*`);
});

cmd('antidelete', [], 'Toggle anti-delete', async (sock, msg) => {
  const cur = getSetting('antidelete', 'off');
  const next = cur === 'on' ? 'off' : 'on';
  setSetting('antidelete', next);
  await reply(sock, msg, `✅ Anti-delete is now *${next.toUpperCase()}*`);
});

cmd('anticall', [], 'Toggle anti-call (reject calls)', async (sock, msg) => {
  const cur = getSetting('anticall', 'off');
  const next = cur === 'on' ? 'off' : 'on';
  setSetting('anticall', next);
  await reply(sock, msg, `✅ Anti-call is now *${next.toUpperCase()}*`);
});

cmd('antilink', [], 'Toggle anti-link in groups', async (sock, msg) => {
  const cur = getSetting('antilink', 'off');
  const next = cur === 'on' ? 'off' : 'on';
  setSetting('antilink', next);
  await reply(sock, msg, `✅ Anti-link is now *${next.toUpperCase()}*`);
});

cmd('antibadword', [], 'Toggle anti-badword', async (sock, msg) => {
  const cur = getSetting('antibadword', 'off');
  const next = cur === 'on' ? 'off' : 'on';
  setSetting('antibadword', next);
  await reply(sock, msg, `✅ Anti-badword is now *${next.toUpperCase()}*`);
});

cmd('antibot', [], 'Toggle anti-bot', async (sock, msg) => {
  const cur = getSetting('antibot', 'off');
  const next = cur === 'on' ? 'off' : 'on';
  setSetting('antibot', next);
  await reply(sock, msg, `✅ Anti-bot is now *${next.toUpperCase()}*`);
});

cmd('antispam', [], 'Toggle anti-spam', async (sock, msg) => {
  const cur = getSetting('antispam', 'off');
  const next = cur === 'on' ? 'off' : 'on';
  setSetting('antispam', next);
  await reply(sock, msg, `✅ Anti-spam is now *${next.toUpperCase()}*`);
});

// ─── MEDIA COMMANDS ─────────────────────────────────────────────────
cmd('sticker', ['s'], 'Make sticker from replied image', async (sock, msg) => {
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  const hasImage = msg.message?.imageMessage || quoted?.imageMessage;
  if (!hasImage) { await reply(sock, msg, '❌ Reply to an image with .sticker'); return; }
  try {
    let imgBuf;
    if (msg.message.imageMessage) imgBuf = await sock.downloadMediaMessage(msg);
    else imgBuf = await sock.downloadMediaMessage({ key: msg.key, message: quoted });
    await sock.sendMessage(msg.key.remoteJid, {
      sticker: imgBuf, pack: CONFIG.botName, author: getSetting('ownerName', CONFIG.ownerName)
    }, { quoted: createFakeContact(msg) });
  } catch (e) { await reply(sock, msg, '❌ ' + e.message); }
});

cmd('vv', ['tovv', 'viewonce'], 'Convert image to view-once', async (sock, msg) => {
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  const hasImage = msg.message?.imageMessage || quoted?.imageMessage;
  if (!hasImage) { await reply(sock, msg, '❌ Reply to an image with .vv'); return; }
  try {
    let imgBuf;
    if (msg.message.imageMessage) imgBuf = await sock.downloadMediaMessage(msg);
    else imgBuf = await sock.downloadMediaMessage({ key: msg.key, message: quoted });
    await sock.sendMessage(msg.key.remoteJid, { image: imgBuf, viewOnce: true }, { quoted: createFakeContact(msg) });
  } catch (e) { await reply(sock, msg, '❌ ' + e.message); }
});

cmd('getdp', ['pp', 'profilepic'], 'Get user profile pic', async (sock, msg, args) => {
  let targetJid;
  if (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length) {
    targetJid = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
  } else if (args[0]) {
    targetJid = phoneToJid(args[0]);
  } else {
    targetJid = msg.key.participant || msg.key.remoteJid;
  }
  try {
    const url = await sock.profilePictureUrl(targetJid, 'image');
    const res = await fetch(url);
    const buf = Buffer.from(await res.arrayBuffer());
    await replyImage(sock, msg, buf, `📸 Profile pic of @${String(targetJid).split('@')[0]}`, { mentions: [targetJid] });
  } catch (e) { await reply(sock, msg, '❌ Could not fetch DP (user may have it hidden).'); }
});

cmd('song', ['play', 'music'], 'Download song (search)', async (sock, msg, args) => {
  const query = args.join(' ');
  if (!query) { await reply(sock, msg, '❌ Usage: song <song name>'); return; }
  await reply(sock, msg, `🔍 Searching for "${query}"...\n\n⚠️ Song download requires a YouTube API. Configure YOUTUBE_API_KEY to enable this feature.\n\nFor now, search on YouTube: https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`);
});

cmd('tls', [], 'Text-to-sticker (text sticker)', async (sock, msg, args) => {
  const text = args.join(' ');
  if (!text) { await reply(sock, msg, '❌ Usage: tls <text>'); return; }
  // Generate a simple text sticker using a canvas-like SVG
  try {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#0a0a14" rx="32"/><text x="256" y="280" font-family="Arial" font-size="${Math.max(20, Math.min(80, 400 / text.length))}" fill="#00e5ff" text-anchor="middle" font-weight="bold">${text.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'})[c])}</text></svg>`;
    // Note: Baileys expects webp for stickers. SVG won't work directly.
    // As a fallback, send as a text message.
    await reply(sock, msg, `💬 Text sticker: "${text}"\n\n(Full sticker generation requires sharp + webp encoding — install sharp to enable image stickers.)`);
  } catch (e) { await reply(sock, msg, '❌ ' + e.message); }
});

cmd('qr', ['qrcode'], 'Generate QR code', async (sock, msg, args) => {
  const text = args.join(' ');
  if (!text) { await reply(sock, msg, '❌ Usage: qr <text>'); return; }
  try {
    const url = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    const buf = Buffer.from(await res.arrayBuffer());
    await replyImage(sock, msg, buf, `QR code for: ${text}`);
  } catch (e) { await reply(sock, msg, '❌ ' + e.message); }
});

// ─── GROUP COMMANDS ─────────────────────────────────────────────────
cmd('kick', ['remove'], 'Kick from group', async (sock, msg, args) => {
  if (!msg.key.remoteJid.endsWith('@g.us')) { await reply(sock, msg, '❌ This command only works in groups'); return; }
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  let targets = [];
  if (args[0] === 'all') {
    // Kick everyone except the bot and owner
    try {
      const metadata = await sock.groupMetadata(msg.key.remoteJid);
      targets = metadata.participants
        .map(p => p.id)
        .filter(id => !isOwner(id) && id !== sock.user.id);
    } catch (e) { await reply(sock, msg, '❌ ' + e.message); return; }
  } else if (mentioned.length) {
    targets = mentioned.filter(id => !isOwner(id));
  } else if (args[0]) {
    targets = [phoneToJid(args[0])].filter(id => !isOwner(id));
  } else {
    await reply(sock, msg, '❌ Usage: kick all | kick @user | kick <number>');
    return;
  }
  if (!targets.length) { await reply(sock, msg, '❌ No valid targets to kick'); return; }
  try {
    await sock.groupParticipantsUpdate(msg.key.remoteJid, targets, 'remove');
    await reply(sock, msg, `✅ Kicked ${targets.length} member(s)`);
  } catch (e) { await reply(sock, msg, '❌ ' + e.message); }
});

cmd('tagall', ['hidetag'], 'Tag all members', async (sock, msg, args) => {
  if (!msg.key.remoteJid.endsWith('@g.us')) { await reply(sock, msg, '❌ Groups only'); return; }
  try {
    const metadata = await sock.groupMetadata(msg.key.remoteJid);
    const mentions = metadata.participants.map(p => p.id);
    const text = args.join(' ') || '┏━━━━━✧ *TAG ALL* ✧━━━━━\n';
    await sock.sendMessage(msg.key.remoteJid, { text, mentions }, { quoted: createFakeContact(msg) });
  } catch (e) { await reply(sock, msg, '❌ ' + e.message); }
});

cmd('tosgroup', ['setstatusgroup', 'groupstatus'], 'Set group status (reply to text/media)', async (sock, msg) => {
  if (!msg.key.remoteJid.endsWith('@g.us')) { await reply(sock, msg, '❌ Groups only'); return; }
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!quoted) { await reply(sock, msg, '❌ Reply to a text or media with this command to set it as group status'); return; }
  try {
    // Try to set the quoted message content as the group description (status)
    let text = '';
    if (quoted.conversation) text = quoted.conversation;
    else if (quoted.extendedTextMessage?.text) text = quoted.extendedTextMessage.text;
    else if (quoted.imageMessage?.caption) text = quoted.imageMessage.caption;
    else if (quoted.videoMessage?.caption) text = quoted.videoMessage.caption;
    if (!text) { await reply(sock, msg, '❌ Could not extract text from the replied message'); return; }
    await sock.groupUpdateDescription(msg.key.remoteJid, text);
    await reply(sock, msg, '✅ Group status/description updated!');
  } catch (e) { await reply(sock, msg, '❌ ' + e.message); }
});

cmd('promote', [], 'Promote to admin', async (sock, msg, args) => {
  if (!msg.key.remoteJid.endsWith('@g.us')) { await reply(sock, msg, '❌ Groups only'); return; }
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  if (!mentioned.length && args[0]) mentioned.push(phoneToJid(args[0]));
  if (!mentioned.length) { await reply(sock, msg, '❌ Usage: promote @user'); return; }
  try { await sock.groupParticipantsUpdate(msg.key.remoteJid, mentioned, 'promote'); await reply(sock, msg, `✅ Promoted ${mentioned.length} user(s)`); }
  catch (e) { await reply(sock, msg, '❌ ' + e.message); }
});

cmd('demote', [], 'Demote admin', async (sock, msg, args) => {
  if (!msg.key.remoteJid.endsWith('@g.us')) { await reply(sock, msg, '❌ Groups only'); return; }
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  if (!mentioned.length && args[0]) mentioned.push(phoneToJid(args[0]));
  if (!mentioned.length) { await reply(sock, msg, '❌ Usage: demote @user'); return; }
  try { await sock.groupParticipantsUpdate(msg.key.remoteJid, mentioned, 'demote'); await reply(sock, msg, `✅ Demoted ${mentioned.length} user(s)`); }
  catch (e) { await reply(sock, msg, '❌ ' + e.message); }
});

cmd('setname', ['groupname'], 'Set group name', async (sock, msg, args) => {
  if (!msg.key.remoteJid.endsWith('@g.us')) { await reply(sock, msg, '❌ Groups only'); return; }
  const name = args.join(' ');
  if (!name) { await reply(sock, msg, '❌ Usage: setname <new name>'); return; }
  try { await sock.groupUpdateSubject(msg.key.remoteJid, name); await reply(sock, msg, `✅ Group name: ${name}`); }
  catch (e) { await reply(sock, msg, '❌ ' + e.message); }
});

cmd('close', ['lockgroup'], 'Close group (admin only)', async (sock, msg) => {
  if (!msg.key.remoteJid.endsWith('@g.us')) { await reply(sock, msg, '❌ Groups only'); return; }
  try { await sock.groupSettingUpdate(msg.key.remoteJid, 'announcement'); await reply(sock, msg, '✅ Group closed — only admins can send messages'); }
  catch (e) { await reply(sock, msg, '❌ ' + e.message); }
});

cmd('open', ['opengroup'], 'Open group', async (sock, msg) => {
  if (!msg.key.remoteJid.endsWith('@g.us')) { await reply(sock, msg, '❌ Groups only'); return; }
  try { await sock.groupSettingUpdate(msg.key.remoteJid, 'not_announcement'); await reply(sock, msg, '✅ Group opened — everyone can send messages'); }
  catch (e) { await reply(sock, msg, '❌ ' + e.message); }
});

// ─── FUN / INFO ─────────────────────────────────────────────────────
cmd('whoami', [], 'Show your info', async (sock, msg) => {
  const jid = msg.key.participant || msg.key.remoteJid;
  const num = String(jid).split('@')[0].split(':')[0];
  const isOwn = isOwner(jid);
  await reply(sock, msg, `┏━━━━━✧ *WHO AM I* ✧━━━━━\n┃✧ Number: ${num}\n┃✧ JID: ${jid}\n┃✧ Owner: ${isOwn ? '✅ Yes' : '❌ No'}\n┃✧ Bot: ${CONFIG.botName}\n┗━━━━━━━━━━━━━━━━━━━━━━━━`);
});

cmd('botinfo', ['info'], 'Show bot info', async (sock, msg) => {
  await reply(sock, msg, `┏━━━━━✧ *BOT INFO* ✧━━━━━\n┃✧ Name: ${getSetting('botName', CONFIG.botName)}\n┃✧ Version: ${CONFIG.botVersion}\n┃✧ Owner: ${getSetting('ownerName', CONFIG.ownerName)}\n┃✧ Prefix: [ ${getSetting('prefix', CONFIG.prefix)} ]\n┃✧ Mode: ${getMode()}\n┃✧ Uptime: ${fmtUptime(process.uptime() * 1000)}\n┃✧ RAM: ${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)} MB\n┃✧ Node: ${process.version}\n┗━━━━━━━━━━━━━━━━━━━━━━━━`);
});

cmd('8ball', ['eightball'], 'Magic 8-ball', async (sock, msg) => {
  const responses = ['✅ Yes', '❌ No', '🤔 Maybe', 'Definitely ✅', 'Not in a million years ❌', 'Ask again later 🕐', '100% yes ✅', 'Absolutely not ❌'];
  await reply(sock, msg, `🎱 ${responses[Math.floor(Math.random() * responses.length)]}`);
});

cmd('coinflip', ['flip', 'coin'], 'Flip a coin', async (sock, msg) => {
  await reply(sock, msg, `🪙 ${Math.random() < 0.5 ? 'Heads' : 'Tails'}`);
});

cmd('dice', ['roll'], 'Roll a dice', async (sock, msg) => {
  await reply(sock, msg, `🎲 You rolled a ${Math.floor(Math.random() * 6) + 1}`);
});

cmd('calc', ['calculate'], 'Calculate expression', async (sock, msg, args) => {
  const expr = args.join(' ');
  if (!expr) { await reply(sock, msg, '❌ Usage: calc <expression>'); return; }
  try {
    const result = Function('"use strict"; return (' + expr.replace(/[^0-9+\-*/().%\s]/g, '') + ')')();
    await reply(sock, msg, `🔢 ${expr} = ${result}`);
  } catch { await reply(sock, msg, '❌ Invalid expression'); }
});

cmd('joke', [], 'Tell a joke', async (sock, msg) => {
  const jokes = ['Why did the scarecrow win an award? Because he was outstanding in his field! 🌾', 'I told my computer I needed a break, and it said "No problem — I\'ll go to sleep." 💻', 'Why don\'t scientists trust atoms? Because they make up everything! ⚛️', 'I would tell you a UDP joke, but you might not get it. 📡'];
  await reply(sock, msg, `😂 ${jokes[Math.floor(Math.random() * jokes.length)]}`);
});

cmd('quote', [], 'Random quote', async (sock, msg) => {
  const quotes = ['"The only way to do great work is to love what you do." — Steve Jobs', '"Code is like humor. When you have to explain it, it\'s bad." — Cory House', '"First, solve the problem. Then, write the code." — John Johnson', '"Simplicity is the soul of efficiency." — Austin Freeman'];
  await reply(sock, msg, `💬 ${quotes[Math.floor(Math.random() * quotes.length)]}`);
});

cmd('fact', [], 'Random fact', async (sock, msg) => {
  const facts = ['Honey never spoils. Archaeologists have found 3000-year-old honey in Egyptian tombs that\'s still edible. 🍯', 'Octopuses have three hearts and blue blood. 🐙', 'A group of flamingos is called a "flamboyance." 🦩', 'Bananas are berries, but strawberries aren\'t. 🍌'];
  await reply(sock, msg, `📚 ${facts[Math.floor(Math.random() * facts.length)]}`);
});

cmd('dare', [], 'Random dare', async (sock, msg) => {
  const dares = ['Send a voice note singing a song 🎤', 'Change your profile pic to a meme for 1 hour 🖼️', 'Send "I love you" to the last person you texted 💬', 'Do 10 push-ups and send a video 💪'];
  await reply(sock, msg, `🎯 *Dare:* ${dares[Math.floor(Math.random() * dares.length)]}`);
});

cmd('truth', [], 'Random truth', async (sock, msg) => {
  const truths = ['What\'s your biggest fear? 😨', 'What\'s the most embarrassing thing you\'ve done? 😳', 'If you could change one thing about yourself, what would it be? 🤔', 'What\'s your secret talent? 🎭'];
  await reply(sock, msg, `🤐 *Truth:* ${truths[Math.floor(Math.random() * truths.length)]}`);
});

// ─── AI COMMANDS (simplified — use a free API or echo) ──────────────
cmd('ai', ['ask', 'gpt'], 'AI response', async (sock, msg, args) => {
  const query = args.join(' ');
  if (!query) { await reply(sock, msg, '❌ Usage: ai <question>'); return; }
  try {
    await sock.sendPresenceUpdate('composing', msg.key.remoteJid);
    const res = await fetch(`https://api.safone.dev/api/ai?query=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error('API error');
    const data = await res.json();
    const answer = data.answer || data.message || data.response || 'No response';
    await reply(sock, msg, `🧠 *AI:* ${answer}`);
  } catch (e) { await reply(sock, msg, `🧠 *AI:* I'm not sure how to answer "${query}" right now. (AI API unavailable)`); }
});

// ─── MESSAGE HANDLER ────────────────────────────────────────────────
function extractText(msg) {
  let text = '';
  if (msg.message?.conversation) text = msg.message.conversation;
  else if (msg.message?.extendedTextMessage?.text) text = msg.message.extendedTextMessage.text;
  else if (msg.message?.imageMessage?.caption) text = msg.message.imageMessage.caption;
  else if (msg.message?.videoMessage?.caption) text = msg.message.videoMessage.caption;
  return (text || '').trim();
}

async function handleMessage(sock, msg) {
  if (!msg.message) return;
  const text = extractText(msg);
  if (!text) return;

  const prefix = getSetting('prefix', CONFIG.prefix);
  if (!text.startsWith(prefix)) return;

  const body = text.slice(prefix.length).trim();
  if (!body) return;

  const [cmdName, ...args] = body.split(/\s+/);
  const command = COMMANDS[cmdName.toLowerCase()];
  if (!command) return;

  const senderJid = msg.key.participant || msg.key.remoteJid;
  const senderNum = String(senderJid).split('@')[0].split(':')[0];
  const isGroup = msg.key.remoteJid.endsWith('@g.us');
  const chatType = isGroup ? 'GROUP' : 'DM';

  console.log(`[MSG] ${chatType} from ${senderNum}: "${text.slice(0, 60)}" → .${cmdName}`);

  // ★ Owner-only enforcement
  const mode = getMode();
  if (mode === 'private' && !isOwner(senderJid)) {
    await reply(sock, msg, '❌ *Only owner allowed* 💔\n\nThis bot is in private mode. Only the owner can use commands.');
    return;
  }

  // Execute the command
  try {
    await command.handler(sock, msg, args, { senderJid, senderNum, isGroup, isOwner: isOwner(senderJid) });
  } catch (e) {
    console.error('  ✗ Command error:', e.message);
    try { await reply(sock, msg, '❌ Error: ' + e.message); } catch {}
  }
}

// ─── Anti-delete handler ────────────────────────────────────────────
async function handleMessagesUpdate(sock, messages) {
  if (getSetting('antidelete', 'off') !== 'on') return;
  for (const msg of messages) {
    if (msg.update?.key?.fromMe === false && msg.update.message === null) {
      // Message was deleted — try to recover from store
      console.log('[ANTI-DELETE] Detected deletion, but recovery requires message store.');
    }
  }
}

// ─── Anti-call handler ─────────────────────────────────────────────
async function handleCall(sock, calls) {
  if (getSetting('anticall', 'off') !== 'on') return;
  for (const call of calls) {
    if (call.status === 'offer') {
      try {
        await sock.rejectCall(call.id, call.from);
        await sock.sendMessage(call.from, { text: `🚫 Calls are rejected. ${CONFIG.botName} is a bot.` }, { quoted: createFakeContact({ key: { participant: call.from, remoteJid: call.from } }) });
        console.log('[ANTI-CALL] Rejected call from', call.from);
      } catch (e) { console.error('[ANTI-CALL] Error:', e.message); }
    }
  }
}

// ─── Auto-read + auto-typing/recording ──────────────────────────────
async function handleAutoPresence(sock, msg) {
  const jid = msg.key.remoteJid;
  try {
    if (getSetting('autoread', 'off') === 'on' && !msg.key.fromMe) {
      await sock.readMessages([msg.key]);
    }
  } catch {}
  try {
    if (getSetting('autotyping', 'off') === 'on' && !msg.key.fromMe) {
      await sock.sendPresenceUpdate('composing', jid);
    } else if (getSetting('autorecording', 'off') === 'on' && !msg.key.fromMe) {
      await sock.sendPresenceUpdate('recording', jid);
    }
  } catch {}
}

// ─── Chatbot auto-reply ─────────────────────────────────────────────
async function handleChatbot(sock, msg) {
  if (getSetting('chatbot', 'off') !== 'on') return;
  if (msg.key.fromMe) return;
  if (msg.key.remoteJid.endsWith('@g.us')) return; // DM only
  const text = extractText(msg);
  if (!text || text.startsWith(getSetting('prefix', CONFIG.prefix))) return;
  try {
    await sock.sendPresenceUpdate('composing', msg.key.remoteJid);
    const res = await fetch(`https://api.safone.dev/api/ai?query=${encodeURIComponent(text)}`);
    if (!res.ok) throw new Error('AI API unavailable');
    const data = await res.json();
    const answer = data.answer || data.message || 'I didn\'t understand that.';
    await sock.sendMessage(msg.key.remoteJid, { text: '🤖 ' + answer }, { quoted: createFakeContact(msg) });
  } catch { /* silent fail for chatbot */ }
}

// ─── BAILEYS CONNECTION ────────────────────────────────────────────
let sock = null;

async function startBaileys() {
  fs.mkdirSync(CONFIG.authDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(CONFIG.authDir);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log('  ℹ Baileys v' + version.join('.') + (isLatest ? ' (latest)' : ''));

  sock = makeWASocket({
    version, auth: state,
    printQRInTerminal: false,
    logger: P({ level: CONFIG.baileysLogLevel }),
    browser: CONFIG.browser,
    makeCacheableSignalKeyStore: makeCacheableSignalKeyStore,
    generateHighQualityLinkPreview: true,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldIgnoreJid: () => false,
    getMessage: async () => proto.Message.fromObject({})
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'open') {
      console.log('\n  ✅ WhatsApp connected as', sock.user?.id);
      try {
        const userName = sock.user?.name || sock.user?.notifyName || CONFIG.ownerName;
        const time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        const banner = [
          '┏━━━━━━✧ CONNECTED ✧━━━━━━━',
          '┃✧ Bot: ' + getSetting('botName', CONFIG.botName),
          '┃✧ Prefix: [ ' + getSetting('prefix', CONFIG.prefix) + ' ]',
          '┃✧ Owner: ' + getSetting('ownerName', CONFIG.ownerName),
          '┃✧ Platform: 🖥️ Panel',
          '┃✧ Status: online',
          '┃✧ Time: ' + time,
          '┃✧ Repo: ' + CONFIG.repoUrl,
          '┗━━━━━━━━━━━━━━━━━━━━━━━━━━'
        ].join('\n');
        await sock.sendMessage(sock.user.id, { text: banner });
        console.log('  ✓ Sent CONNECTED banner to owner WhatsApp');
      } catch (e) { console.log('  ⚠ Self message failed:', e.message); }
      console.log('  🟢 Bot is now online. Listening for commands (owner-only mode)…\n');
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log('  ⚠ Connection closed. Status:', statusCode);
      if (statusCode === DisconnectReason.loggedOut) {
        console.log('  ✗ Logged out — credentials revoked. Re-pair on the site.');
        process.exit(1);
      } else if (statusCode === 515 || statusCode === 410) {
        setTimeout(() => startBaileys(), 3000);
      } else {
        setTimeout(() => startBaileys(), 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      try {
        await handleAutoPresence(sock, msg);
        await handleMessage(sock, msg);
        await handleChatbot(sock, msg);
      } catch (e) { console.error('  ✗ Message handler error:', e.message); }
    }
  });

  sock.ev.on('messages.update', async (updates) => {
    try { await handleMessagesUpdate(sock, updates); } catch (e) {}
  });

  sock.ev.on('call', async (calls) => {
    try { await handleCall(sock, calls); } catch (e) {}
  });

  return sock;
}

// ─── BOOT ──────────────────────────────────────────────────────────
async function getSessionId() {
  if (CONFIG.sessionId && CONFIG.sessionId.startsWith('megh-ultra:~')) return CONFIG.sessionId;
  return await new Promise((resolve, reject) => {
    printSessionPrompt();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let attempt = 0;
    const ask = () => {
      rl.question(ANSI.cyan + ANSI.bold + '  ↠ Enter SESSION_ID: ' + ANSI.reset, async (raw) => {
        const input = (raw || '').trim();
        attempt++;
        if (!input) {
          console.log(ANSI.red + '  ✗ Empty input — try again.' + ANSI.reset + '\n');
          if (attempt < 5) return ask();
          rl.close(); return reject(new Error('No session provided'));
        }
        const validated = validateSessionId(input);
        if (!validated.ok) {
          printFailure(validated.error);
          if (attempt < 5) {
            console.log(ANSI.gold + '  ↻ Please retry (' + (5 - attempt) + ' attempts left)' + ANSI.reset + '\n');
            return ask();
          }
          rl.close();
          console.log('\n  ' + ANSI.red + '✗ Max retries exceeded. Restarting panel…' + ANSI.reset + '\n');
          process.exit(1);
        }
        rl.close();
        resolve(validated.sessionId);
      });
    };
    ask();
  });
}

async function boot() {
  console.clear();
  printBanner();

  // Download menu image in background
  downloadMenuImage().catch(() => {});

  let sessionId;
  try { sessionId = await getSessionId(); }
  catch (e) { console.error('\n  ✗ Session resolution failed:', e.message); process.exit(1); }

  const validated = validateSessionId(sessionId);
  if (!validated.ok) { printFailure(validated.error); process.exit(1); }

  persistAuthState(validated.decoded);

  // Store owner info from creds if available
  if (validated.decoded.creds.me?.id) {
    const pairedNum = String(validated.decoded.creds.me.id).split(':')[0];
    // Don't override the env owner — just allow the paired account as owner too
    console.log('  ℹ Paired account: +' + pairedNum);
  }

  printConnected({
    botName: getSetting('botName', CONFIG.botName),
    prefix: getSetting('prefix', CONFIG.prefix),
    ownerName: getSetting('ownerName', CONFIG.ownerName),
    platform: 'Panel',
    time: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
    repo: CONFIG.repoUrl
  });

  console.log('\n  ✓ Loaded ' + Object.keys(COMMANDS).length + ' command handlers\n');
  console.log('  ⌁ Mode: ' + getMode().toUpperCase() + ' (owner: +' + getSetting('ownerNumber', CONFIG.ownerNumber) + ')\n');

  await startBaileys();
}

boot().catch(err => {
  console.error('\n  ✗ Boot failed:', err);
  process.exit(1);
});

process.on('SIGTERM', () => { console.log('\n  ⊘ SIGTERM received — shutting down'); process.exit(0); });
process.on('SIGINT', () => { console.log('\n  ⊘ SIGINT received — shutting down'); process.exit(0); });
