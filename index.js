/**
 * ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
 * ┃  MEGH X-MINI  ·  Self-Contained Mini Bot  ·  Render/Railway  ┃
 * ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
 *
 * ONE deploy = pairing site + bot. No Pterodactyl, no separate repos.
 *
 * Flow:
 *  1. Deploy on Render → visit the site
 *  2. Enter phone number → get pairing code
 *  3. Enter code in WhatsApp → Linked Devices → "Link with phone number"
 *  4. Bot connects INSTANTLY → sends CONNECTED message to user's WhatsApp
 *  5. User can use .menu, .ping, etc. immediately
 *
 * Persistence: set SESSION_ID env var (from the CONNECTED message) to survive
 * Render restarts without re-pairing.
 */

'use strict';

process.removeAllListeners('warning');
process.env.NODE_NO_WARNINGS = '1';
const _origEmit = process.emit;
process.emit = function (name, ...args) {
  if (name === 'warning' && args[0]?.name === 'DeprecationWarning') return false;
  return _origEmit.apply(process, [name, ...args]);
};

import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import P from 'pino';
import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const baileys = require('@whiskeysockets/baileys');
const { makeWASocket, useMultiFileAuthState, DisconnectReason,
  fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers,
  downloadMediaMessage, proto, generateWAMessage } = baileys;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── CONFIG ─────────────────────────────────────────────────────────
const CONFIG = {
  botName: process.env.BOT_NAME || 'MEGH X-MINI',
  botVersion: '1.0.0',
  ownerName: process.env.OWNER_NAME || 'killer',
  ownerNumber: process.env.OWNER_NUMBER || '254795314221',
  prefix: process.env.PREFIX || '.',
  mode: 'public', // 'public' = everyone can use, 'private' = owner-only
  sessionId: process.env.SESSION_ID || '',
  supportUrl: 'https://wa.me/message/25495314221',
  repoUrl: 'https://github.com/yobbyking/megh-x-mini',
  menuImageUrl: 'https://raw.githubusercontent.com/yobbyking/tool/main/IMG-20260918-WA0025.png',
  dataDir: path.resolve(process.cwd(), 'data'),
  authDir: path.resolve(process.cwd(), 'data', 'auth'),
  dbPath: path.resolve(process.cwd(), 'data', 'bot.db'),
  baileysLogLevel: 'warn',
  browser: Browsers.appropriate('Chrome')
};

const PORT = process.env.PORT || 3000;
const logger = P({ level: 'warn' }, P.destination({ sync: true }));

fs.mkdirSync(CONFIG.dataDir, { recursive: true });
fs.mkdirSync(CONFIG.authDir, { recursive: true });

// ─── SQLite ────────────────────────────────────────────────────────
const db = new Database(CONFIG.dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS users (jid TEXT PRIMARY KEY, name TEXT, is_sudo INTEGER DEFAULT 0, is_blocked INTEGER DEFAULT 0, warns INTEGER DEFAULT 0, dp_base64 TEXT, created_at INTEGER);
`);
const setS = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
const getS = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSetting = (k, v) => setS.run(k, String(v));
const getSetting = (k, fb = null) => { const r = getS.get(k); return r ? r.value : fb; };

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
function printBanner(){console.log(['',gradientBar(false),gradientBar(false),darkEmptyRow(),centeredRow('✦  MEGH X-MINI  ✦',{fg:ANSI.cyan,bold:true}),centeredRow('Self-Contained Bot  ·  v'+CONFIG.botVersion,{fg:ANSI.violet}),centeredRow('Pairing + Bot in One Deploy',{fg:ANSI.muted}),darkEmptyRow(),gradientBar(true),gradientBar(true),''].join('\n'));}
function printConnected(o){const pad=(s,n)=>String(s).padEnd(n).slice(0,n);console.log(['',gradientBar(false),gradientBar(false),darkEmptyRow(),centeredRow('✧  CONNECTED  ✧',{fg:ANSI.green,bold:true,glow:true}),darkEmptyRow(),darkRow('  ➤ Bot:      '+pad(o.botName,30),{fg:ANSI.white}),darkRow('  ➤ Owner:    '+pad(o.ownerName,30),{fg:ANSI.cyan,bold:true}),darkRow('  ➤ Status:   online',{fg:ANSI.green,bold:true}),darkRow('  ➤ Time:     '+pad(o.time,30),{fg:ANSI.muted}),darkEmptyRow(),gradientBar(true),gradientBar(true),''].join('\n'));}

// ─── Small caps ────────────────────────────────────────────────────
const SC = {a:'ᴀ',b:'ʙ',c:'ᴄ',d:'ᴅ',e:'ᴇ',f:'ꜰ',g:'ɢ',h:'ʜ',i:'ɪ',j:'ᴊ',k:'ᴋ',l:'ʟ',m:'ᴍ',n:'ɴ',o:'ᴏ',p:'ᴘ',q:'ǫ',r:'ʀ',s:'s',t:'ᴛ',u:'ᴜ',v:'ᴠ',w:'ᴡ',x:'x',y:'ʏ',z:'ᴢ'};
const smallCaps = s => String(s).split('').map(c => SC[c.toLowerCase()] || c).join('');

// ─── createFakeContact (with user photo) ───────────────────────────
// Replies are quoted to a contact card showing the SENDER's info + photo
// (not the bot's), so it looks like the bot is replying to the user's contact.
async function createFakeContact(msg) {
  const botName = getSetting('botName', CONFIG.botName);
  const participantId = (msg && (msg.key.participant || msg.key.remoteJid)) || '0';
  const cleanId = String(participantId).split(':')[0].split('@')[0] || '0';
  const senderName = msg?.pushName || cleanId;

  // Try to get the sender's profile picture
  let ppUrl = null;
  try {
    ppUrl = await sock?.profilePictureUrl?.(participantId, 'image');
  } catch {}

  const vcard = `BEGIN:VCARD\nVERSION:3.0\nN:${senderName};;;\nFN:${senderName}\nitem1.TEL;waid=${cleanId}:${cleanId}\nitem1.X-ABLabel:Phone\nPHOTO:${ppUrl || ''}\nEND:VCARD`;

  return {
    key: { participants: '0@s.whatsapp.net', remoteJid: '0@s.whatsapp.net', fromMe: false, id: 'MEGHXMINI' + Math.random().toString(36).substring(2,12).toUpperCase() },
    message: { contactMessage: { displayName: senderName, vcard } },
    participant: '0@s.whatsapp.net'
  };
}

// Sync wrapper for places where we can't await (command handlers etc)
function createFakeContactSync(msg) {
  const botName = getSetting('botName', CONFIG.botName);
  const participantId = (msg && (msg.key.participant || msg.key.remoteJid)) || '0';
  const cleanId = String(participantId).split(':')[0].split('@')[0] || '0';
  const senderName = msg?.pushName || cleanId;
  return {
    key: { participants: '0@s.whatsapp.net', remoteJid: '0@s.whatsapp.net', fromMe: false, id: 'MEGHXMINI' + Math.random().toString(36).substring(2,12).toUpperCase() },
    message: { contactMessage: { displayName: senderName, vcard: `BEGIN:VCARD\nVERSION:3.0\nN:${senderName};;;\nFN:${senderName}\nitem1.TEL;waid=${cleanId}:${cleanId}\nitem1.X-ABLabel:Phone\nEND:VCARD` } },
    participant: '0@s.whatsapp.net'
  };
}

// ─── Global maps (declared early so isOwner can use them) ──────────
const userSessions = new Map(); // phone → { sock, authFolder, connected, userInfo }

// ─── Owner check (multi-user aware) ────────────────────────────────
// An owner is ANYONE who has paired their number with this bot.
// Check: env owner number + ALL paired users + connected sockets
function isOwner(jid) {
  const num = String(jid).split(':')[0].split('@')[0];
  // 1. Check env var owner
  if (num === getSetting('ownerNumber', CONFIG.ownerNumber)) return true;
  // 2. Check userSessions map (currently connected users)
  //    userSessions is declared later in the file but we use a getter
  //    so it's resolved at call time, not definition time
  try {
    if (typeof userSessions !== 'undefined' && userSessions && userSessions.has(num)) return true;
  } catch {}
  // 3. Check ALL auth subfolders for matching creds.me.id
  try {
    const authRoot = path.join(CONFIG.dataDir, 'auth');
    if (fs.existsSync(authRoot)) {
      for (const dir of fs.readdirSync(authRoot)) {
        const credsPath = path.join(authRoot, dir, 'creds.json');
        if (fs.existsSync(credsPath)) {
          try {
            const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
            if (creds.me?.id && String(creds.me.id).split(':')[0] === num) return true;
          } catch {}
        }
      }
    }
  } catch {}
  // 4. Check ALL connected sockets' user.id
  try {
    if (typeof userSessions !== 'undefined' && userSessions) {
      for (const [phone, session] of userSessions) {
        if (session?.sock?.user?.id) {
          const sockNum = String(session.sock.user.id).split(':')[0].split('@')[0];
          if (sockNum === num) return true;
        }
        if (session?.userInfo?.id) {
          const userInfoNum = String(session.userInfo.id).split(':')[0].split('@')[0];
          if (userInfoNum === num) return true;
        }
      }
    }
  } catch {}
  // 5. If no userSessions and no auth folders exist, allow the first
  //    person to message (they must be the owner who just paired)
  try {
    const authRoot = path.join(CONFIG.dataDir, 'auth');
    const hasAnyAuth = fs.existsSync(authRoot) && fs.readdirSync(authRoot).length > 0;
    if (!hasAnyAuth && typeof userSessions === 'undefined') {
      // No auth at all + userSessions not initialized → allow
      return true;
    }
  } catch {}
  return false;
}
function getMode() { return getSetting('mode', CONFIG.mode); }

// ─── Helpers ────────────────────────────────────────────────────────
function fmtUptime(ms) { const s=Math.floor(ms/1000); const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60); const p=[]; if(d)p.push(d+'d'); if(h)p.push(h+'h'); if(m)p.push(m+'m'); p.push((s%60)+'s'); return p.join(' '); }
function phoneToJid(phone) { let p=String(phone).replace(/\D/g,''); if(p.startsWith('00'))p=p.slice(2); return p+'@s.whatsapp.net'; }
function normalizePhone(input) { if(!input) return null; let p=String(input).replace(/[^\d]/g,''); if(!p) return null; if(p.length>10&&p.startsWith('0'))p=p.slice(1); if(!/^\d{8,15}$/.test(p)) return null; return p; }
async function reply(sock, msg, text, opts={}) {
  const contact = await createFakeContact(msg);
  return sock.sendMessage(msg.key.remoteJid, { text, ...opts }, { quoted: contact });
}
async function replyImage(sock, msg, img, cap, opts={}) {
  const contact = await createFakeContact(msg);
  return sock.sendMessage(msg.key.remoteJid, { image: img, caption: cap, ...opts }, { quoted: contact });
}

// ─── Menu image ────────────────────────────────────────────────────
async function downloadMenuImage() {
  const cachePath = path.join(CONFIG.dataDir, 'menu-image.png');
  if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 1000) return;
  try {
    console.log('  ℹ Downloading menu image...');
    const res = await fetch(CONFIG.menuImageUrl);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(cachePath, buf);
    console.log('  ✓ Menu image cached (' + (buf.length / 1024).toFixed(1) + ' KB)');
  } catch (e) { console.log('  ⚠ Menu image: ' + e.message); }
}
function getMenuImage() { const p = path.join(CONFIG.dataDir, 'menu-image.png'); if (fs.existsSync(p) && fs.statSync(p).size > 1000) return fs.readFileSync(p); return null; }

// ─── Menu ──────────────────────────────────────────────────────────
const COMMAND_LIST = {
  main: ['menu','all','ping','repo','alive','pair','owner','runtime','list'],
  ai: ['ai','gpt','gemini','blackbox','deepseek','llama','mistral','translate','summarize','explain','story','joke','quote','fact','dare','truth','flirt','rizz'],
  group: ['kick','promote','demote','tagall','hidetag','invite','close','open','tosgroup','setname','setdesc','groupinfo','del','revoke'],
  admin: ['setprefix','setbotname','setownername','setprofilepic','setmenuimage','setstatus','mode','block','unblock'],
  anti: ['antidelete','antilink','antibadword','anticall','antibot','antispam','autoread','autotyping','autorecording','chatbot','autostatusview'],
  download: ['url','apk','mediafire','tiktok','facebook','ig','twitter','song','yt','ytmp3','ytmp4','play','instagram','pinterest','gdrive'],
  media: ['sticker','vv','tovv','getdp','tls','qr','toimage','toaudio','tomp3','emojimix','take','ss','carbon','nulis','tts','waste','memegen'],
  tools: ['calc','weather','lyrics','wiki','define','tempmail','shorten','base64','uuid','timestamp','hex','binary','reverse','uppercase','lowercase'],
  fun: ['8ball','coinflip','dice','rps','ship','horny','gay','smart','character','guess','slots'],
  info: ['whoami','botinfo','profile','server','stats','uptime','ping2','timezone'],
  converter: ['toimg','tosticker','toaudio','tovideo','togif','toptt','tomp3'],
  games: ['truth','dare','riddle','wordgame','trivia','mathgame'],
  logo: ['logo','neon','glitch','burn','crimson','golden','ice','fire','water','smoke','bokeh','rainbow','sparkle'],
};
const CAT_EMOJI = { main:'🤖', ai:'🧠', group:'👥', admin:'⚙️', anti:'🛡️', download:'📥', media:'🎬', tools:'🔧', fun:'🎮', info:'ℹ️', converter:'🔄', games:'🎯', logo:'🎨' };
const CAT_NAME = { main:'MAIN', ai:'AI', group:'GROUP', admin:'ADMIN', anti:'ANTI', download:'DOWNLOAD', media:'MEDIA', tools:'TOOLS', fun:'FUN', info:'INFO', converter:'CONVERTER', games:'GAMES', logo:'LOGO' };
const CAT_DESC = {
  main: 'Core commands — menu, ping, repo, pair',
  ai: 'AI chat + creative — gpt, gemini, story',
  group: 'Group management — kick, tag, promote',
  admin: 'Bot settings — prefix, name, mode',
  anti: 'Anti + Auto toggles — antidelete, autoread',
  download: 'Download media — url, tiktok, song',
  media: 'Media tools — sticker, vv, qr, ss',
  tools: 'Utilities — calc, weather, lyrics, wiki',
  fun: 'Games — 8ball, dice, dare, truth',
  info: 'Info — whoami, botinfo, stats',
  converter: 'Format converters — toimg, toaudio',
  games: 'Mini games — riddle, trivia, mathgame',
  logo: 'Logo maker — neon, glitch, fire',
};

function buildMainMenu() {
  const ownerName = getSetting('ownerName', CONFIG.ownerName);
  const prefix = getSetting('prefix', CONFIG.prefix);
  const mode = getMode();
  const mem = process.memoryUsage();
  const memMB = (mem.rss / 1024 / 1024).toFixed(0);
  const uptime = fmtUptime(process.uptime() * 1000);
  const speedMs = (process.hrtime()[1] / 1e6).toFixed(4);
  const ramPct = Math.min(100, Math.round((mem.rss / (1024*1024*512)) * 100));
  const ramBar = '█'.repeat(Math.round(ramPct/10)) + '░'.repeat(10 - Math.round(ramPct/10));
  const totalCmds = Object.values(COMMAND_LIST).reduce((a,b) => a + b.length, 0);
  return `╭━◈ ${smallCaps(CONFIG.botName)} ◈━╮
│  ${smallCaps('Owner')}  : ${ownerName}
│  ${smallCaps('Prefix')} : [ ${prefix} ]
│  ${smallCaps('Host')}   : MEGH HOSTING
│  ${smallCaps('Plugins')}: ${totalCmds}
│  ${smallCaps('Mode')}   : ${mode === 'private' ? 'Private 🔐' : 'Public'}
│  ${smallCaps('Version')}: ${CONFIG.botVersion}
│  ${smallCaps('Speed')}  : ${speedMs} ms
│  ${smallCaps('Usage')}  : ${memMB} MB
│  ${smallCaps('RAM')}    : [${ramBar}] ${ramPct}%
│  ${smallCaps('Uptime')} : ${uptime}
╰━━━━━━━━━━━━━━━━━╯

┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
📝 ${smallCaps('Type')} ${prefix}all ${smallCaps('to see all commands')}
🎨 ${smallCaps('Type')} ${prefix}list ${smallCaps('for categories')}
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄`;
}

function buildFullMenu() {
  const prefix = getSetting('prefix', CONFIG.prefix);
  const cats = Object.keys(COMMAND_LIST);
  const totalCmds = Object.values(COMMAND_LIST).reduce((a,b) => a + b.length, 0);

  let out = `┏━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ ✦ *${smallCaps(CONFIG.botName)} · [${smallCaps('MENU')}]* ✦
┃ \`coded by yobby_mking\`
┗━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n`;

  // Each category with emoji header + arrow-prefixed commands
  for (const cat of cats) {
    const cmds = COMMAND_LIST[cat];
    const emoji = CAT_EMOJI[cat];
    const name = smallCaps(CAT_NAME[cat]);
    out += `${emoji} *${name}*\n`;
    for (const c of cmds) {
      out += `> *┋ ✦ ${smallCaps(c)}*\n`;
    }
    out += '\n';
  }

  out += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⬅️ ${smallCaps('Type')} *${prefix}menu* ${smallCaps('to go')} *${smallCaps('BACK TO MENU')}*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  return out;
}

// ─── Category sub-menu (with BACK TO MENU) ──────────────────────────
function buildCategoryMenu(cat) {
  const prefix = getSetting('prefix', CONFIG.prefix);
  const cmds = COMMAND_LIST[cat];
  if (!cmds) return `❌ Category not found. Type ${prefix}list to see categories.`;
  const emoji = CAT_EMOJI[cat];
  const name = smallCaps(CAT_NAME[cat]);
  const desc = CAT_DESC[cat] || '';
  const total = cmds.length;

  let out = `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃  ${emoji}  *${name} MENU*  ·  ${total} commands
┃  _${desc}_
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n`;

  // Single column, each command with a description where possible
  for (const c of cmds) {
    const cmdObj = COMMANDS[c];
    const cmdDesc = cmdObj?.desc || '';
    out += `  ✦ *${prefix}${smallCaps(c)}*`;
    if (cmdDesc) out += ` — _${cmdDesc}_`;
    out += '\n';
  }

  out += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⬅️  Type *${prefix}menu* to go *BACK TO MENU*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  return out;
}

// ─── Category list ──────────────────────────────────────────────────
function buildCategoryList() {
  const prefix = getSetting('prefix', CONFIG.prefix);
  const cats = Object.keys(COMMAND_LIST);
  let out = `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃  ✦  *${smallCaps(CONFIG.botName)} · CATEGORIES*
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n`;
  for (const cat of cats) {
    const count = COMMAND_LIST[cat].length;
    out += `  ${CAT_EMOJI[cat]} *${prefix}menu ${cat}* — ${smallCaps(CAT_NAME[cat])} (${count} cmds)\n`;
  }
  out += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⬅️  Type *${prefix}menu* to go *BACK TO MENU*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  return out;
}

// ─── Commands ──────────────────────────────────────────────────────
const COMMANDS = {};
function cmd(name, aliases, desc, handler) {
  COMMANDS[name.toLowerCase()] = { name, aliases, desc, handler };
  if (aliases) for (const a of aliases) COMMANDS[a.toLowerCase()] = { name, aliases, desc, handler };
}

cmd('menu', ['help'], 'Main menu with interactive buttons', async (sock, msg, args) => {
  // If a category is specified, show that category's menu
  if (args[0]) {
    const cat = args[0].toLowerCase();
    if (COMMAND_LIST[cat]) {
      const text = buildCategoryMenu(cat);
      const img = getMenuImage();
      if (img) await replyImage(sock, msg, img, text); else await reply(sock, msg, text);
    } else {
      await reply(sock, msg, `❌ Category not found. Type ${getSetting('prefix', CONFIG.prefix)}list to see categories.`);
    }
    return;
  }
  // No category -> show main menu with image + list message
  const text = buildMainMenu();
  const img = getMenuImage();

  const listSections = [{
    title: 'MEGH X-MINI Navigation',
    rows: [
      { title: 'All Commands', description: 'View all 130+ commands', id: getSetting('prefix', CONFIG.prefix) + 'all' },
      { title: 'Ping', description: 'Check bot speed', id: getSetting('prefix', CONFIG.prefix) + 'ping' },
      { title: 'Categories', description: 'Browse by category', id: getSetting('prefix', CONFIG.prefix) + 'list' },
      { title: 'Contact Owner', description: 'Get owner WhatsApp link', id: getSetting('prefix', CONFIG.prefix) + 'owner' },
    ]
  }];

  try {
    if (img) {
      await sock.sendMessage(msg.key.remoteJid, {
        image: img,
        caption: text
      }, { quoted: await createFakeContact(msg) });
    } else {
      await reply(sock, msg, text);
    }
    await sock.sendMessage(msg.key.remoteJid, {
      text: 'Tap below to navigate:',
      footer: 'Powered by MEGH HOSTING',
      title: 'MEGH X-MINI',
      buttonText: 'Menu',
      sections: listSections
    }, { quoted: await createFakeContact(msg) });
  } catch (e) {
    console.log('  List message failed, sending plain:', e.message);
    if (img) await replyImage(sock, msg, img, text); else await reply(sock, msg, text);
  }
});
cmd('all', ['menuall'], 'All commands (single row layout)', async (sock, msg) => {
  const prefix = getSetting('prefix', CONFIG.prefix);
  const text = buildFullMenu();
  // Send with a list message back button
  try {
    await sock.sendMessage(msg.key.remoteJid, {
      text: text,
      footer: 'MEGH X-MINI',
      title: '',
      buttonText: 'Back to Menu',
      sections: [{
        title: 'Navigation',
        rows: [
          { title: 'Menu', description: 'Back to main menu', id: prefix + 'menu' },
          { title: 'Categories', description: 'Browse by category', id: prefix + 'list' },
          { title: 'Ping', description: 'Check bot speed', id: prefix + 'ping' },
        ]
      }]
    }, { quoted: await createFakeContact(msg) });
  } catch (e) {
    await reply(sock, msg, text);
  }
});
cmd('list', ['cats', 'categories'], 'List all categories', async (sock, msg) => { await reply(sock, msg, buildCategoryList()); });
cmd('ping', ['speed'], 'Ping', async (sock, msg) => {
  const s = process.hrtime(); const u = fmtUptime(process.uptime()*1000); const e = process.hrtime(s);
  const ms = (e[0]*1000 + e[1]/1e6).toFixed(2);
  await reply(sock, msg, `🏓 *PONG!*\n\n┃✧ Speed: ${ms} ms\n┃✧ Uptime: ${u}\n┃✧ RAM: ${(process.memoryUsage().rss/1024/1024).toFixed(0)} MB`);
});
cmd('repo', ['source'], 'Repo', async (sock, msg) => { await reply(sock, msg, `┏━━━━━✧ *REPO* ✧━━━━━\n┃✧ Bot: ${CONFIG.botName}\n┃✧ Version: ${CONFIG.botVersion}\n┃✧ Owner: ${getSetting('ownerName',CONFIG.ownerName)}\n┃✧ Number: ${getSetting('ownerNumber',CONFIG.ownerNumber)}\n┃✧ Repo: ${CONFIG.repoUrl}\n┃✧ Support: ${CONFIG.supportUrl}\n┗━━━━━━━━━━━━━━━━━━━━━━━━`); });
cmd('alive', ['status'], 'Bot status', async (sock, msg) => { await reply(sock, msg, `🟢 *${CONFIG.botName} is alive!*\n\n┃✧ Uptime: ${fmtUptime(process.uptime()*1000)}\n┃✧ RAM: ${(process.memoryUsage().rss/1024/1024).toFixed(0)} MB\n┃✧ Mode: ${getMode()}`); });
cmd('owner', ['creator'], 'Owner info', async (sock, msg) => { await reply(sock, msg, `┏━━━━━✧ *OWNER* ✧━━━━━\n┃✧ Name: ${getSetting('ownerName',CONFIG.ownerName)}\n┃✧ Number: ${getSetting('ownerNumber',CONFIG.ownerNumber)}\n┃✧ WhatsApp: wa.me/${getSetting('ownerNumber',CONFIG.ownerNumber)}\n┗━━━━━━━━━━━━━━━━━━━━━━━━`); });
cmd('runtime', ['uptime'], 'Runtime', async (sock, msg) => { await reply(sock, msg, `⏱️ *Runtime:* ${fmtUptime(process.uptime()*1000)}`); });

// Pair
cmd('pair', ['paircode'], 'Pair another user', async (sock, msg, args) => {
  const phone = (args[0]||'').replace(/\D/g,'');
  if (!phone) { await reply(sock, msg, `🔗 Visit the pairing site to get a code.\n\nOr use: ${getSetting('prefix',CONFIG.prefix)}pair <number>`); return; }
  try { await sock.sendPresenceUpdate('composing', msg.key.remoteJid); const code = await sock.requestPairingCode(phone); const p = code.length===8 ? code.slice(0,4)+'-'+code.slice(4) : code; await reply(sock, msg, `📲 *Pairing Code for +${phone}*\n\nCode: *${p}*\n\n1. Open WhatsApp on +${phone}\n2. Settings → Linked Devices → Link a Device\n3. "Link with phone number instead"\n4. Enter the code\n\n⏱️ Expires in 90s`); }
  catch (e) { await reply(sock, msg, `❌ ${e.message}`); }
});

// Admin
cmd('setprefix', ['prefix'], 'Set prefix', async (sock, msg, args) => { const p=args[0]; if(!p||p.length>4){await reply(sock,msg,'❌ Usage: setprefix <new-prefix>');return;} setSetting('prefix',p); await reply(sock,msg,`✅ Prefix: [ ${p} ]`); });
cmd('setbotname', ['botname'], 'Set bot name', async (sock, msg, args) => { const n=args.join(' '); if(!n){await reply(sock,msg,'❌ Usage: setbotname <name>');return;} setSetting('botName',n); await reply(sock,msg,`✅ Bot name: ${n}`); });
cmd('setownername', ['ownername'], 'Set owner name', async (sock, msg, args) => { const n=args.join(' '); if(!n){await reply(sock,msg,'❌ Usage: setownername <name>');return;} setSetting('ownerName',n); await reply(sock,msg,`✅ Owner name: ${n}`); });
cmd('setprofilepic', ['setpp'], 'Set profile pic (reply to photo)', async (sock, msg) => {
  const q = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage; const hi = msg.message?.imageMessage || q?.imageMessage;
  if(!hi){await reply(sock,msg,'❌ Reply to a photo');return;}
  try { let b; if(msg.message.imageMessage) b=await downloadMediaMessage(msg, 'buffer', {}, sock); else b=await downloadMediaMessage({key:msg.key,message:q}, 'buffer', {}, sock); await sock.updateProfilePicture(sock.user.id,b); await reply(sock,msg,'✅ Profile pic updated!'); }
  catch(e){await reply(sock,msg,'❌ '+e.message);}
});
cmd('setmenuimage', ['menuimage'], 'Set menu image (reply to photo)', async (sock, msg) => {
  const q = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage; const hi = msg.message?.imageMessage || q?.imageMessage;
  if(!hi){await reply(sock,msg,'❌ Reply to a photo');return;}
  try { let b; if(msg.message.imageMessage) b=await downloadMediaMessage(msg, 'buffer', {}, sock); else b=await downloadMediaMessage({key:msg.key,message:q}, 'buffer', {}, sock); fs.writeFileSync(path.join(CONFIG.dataDir,'menu-image.png'),b); await reply(sock,msg,`✅ Menu image updated! (${(b.length/1024).toFixed(0)} KB)`); }
  catch(e){await reply(sock,msg,'❌ '+e.message);}
});
cmd('setstatus', ['status'], 'Set status', async (sock, msg, args) => { const t=args.join(' '); if(!t){await reply(sock,msg,'❌ Usage: setstatus <text>');return;} try{await sock.updateProfileStatus(t);await reply(sock,msg,`✅ Status: ${t}`);}catch(e){await reply(sock,msg,'❌ '+e.message);} });
cmd('mode', ['setmode'], 'Set mode', async (sock, msg, args) => { const m=(args[0]||'').toLowerCase(); if(m!=='public'&&m!=='private'){await reply(sock,msg,`❌ Usage: mode public|private\nCurrent: ${getMode()}`);return;} setSetting('mode',m); await reply(sock,msg,`✅ Mode: ${m}`); });

// Anti/Auto (toggles)
for (const [name, label] of [['antidelete','Anti-delete'],['antilink','Anti-link'],['antibadword','Anti-badword'],['anticall','Anti-call'],['antibot','Anti-bot'],['antispam','Anti-spam'],['autoread','Auto-read'],['autotyping','Auto-typing'],['autorecording','Auto-recording'],['chatbot','Chatbot']]) {
  cmd(name, [], label, async (sock, msg) => {
    const cur = getSetting(name, 'off'); const next = cur === 'on' ? 'off' : 'on'; setSetting(name, next);
    await reply(sock, msg, `✅ ${label} is now *${next.toUpperCase()}*`);
  });
}

// Group
cmd('kick', ['remove'], 'Kick from group (admin only)', async (sock, msg, args) => {
  if(!msg.key.remoteJid.endsWith('@g.us')){await reply(sock,msg,'❌ Groups only');return;}
  const senderJid = msg.key.participant || msg.key.remoteJid;
  if(!await isGroupAdmin(sock, msg.key.remoteJid, senderJid)){await reply(sock,msg,'❌ Only group admins can use this command');return;}
 
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid||[];
  let targets=[];
  if(args[0]==='all'){try{const md=await sock.groupMetadata(msg.key.remoteJid);targets=md.participants.map(p=>p.id).filter(id=>!isOwner(id)&&id!==sock.user.id);}catch(e){await reply(sock,msg,'❌ '+e.message);return;}}
  else if(mentioned.length) targets=mentioned.filter(id=>!isOwner(id));
  else if(args[0]) targets=[phoneToJid(args[0])].filter(id=>!isOwner(id));
  else{await reply(sock,msg,'❌ Usage: kick all|@user|number');return;}
  if(!targets.length){await reply(sock,msg,'❌ No valid targets');return;}
  try{await sock.groupParticipantsUpdate(msg.key.remoteJid,targets,'remove');await reply(sock,msg,`✅ Kicked ${targets.length} member(s)`);}catch(e){await reply(sock,msg,'❌ '+e.message);}
});
cmd('promote', [], 'Promote (admin only)', async (sock, msg, args) => {
  if(!msg.key.remoteJid.endsWith('@g.us')){await reply(sock,msg,'❌ Groups only');return;}
  const senderJid = msg.key.participant || msg.key.remoteJid;
  if(!await isGroupAdmin(sock, msg.key.remoteJid, senderJid)){await reply(sock,msg,'❌ Only group admins can use this command');return;}
 
  const m=msg.message?.extendedTextMessage?.contextInfo?.mentionedJid||[]; if(!m.length&&args[0])m.push(phoneToJid(args[0])); if(!m.length){await reply(sock,msg,'❌ Usage: promote @user');return;}
  try{await sock.groupParticipantsUpdate(msg.key.remoteJid,m,'promote');await reply(sock,msg,`✅ Promoted ${m.length} user(s)`);}catch(e){await reply(sock,msg,'❌ '+e.message);}
});
cmd('demote', [], 'Demote (admin only)', async (sock, msg, args) => {
  if(!msg.key.remoteJid.endsWith('@g.us')){await reply(sock,msg,'❌ Groups only');return;}
  const senderJid = msg.key.participant || msg.key.remoteJid;
  if(!await isGroupAdmin(sock, msg.key.remoteJid, senderJid)){await reply(sock,msg,'❌ Only group admins can use this command');return;}
 
  const m=msg.message?.extendedTextMessage?.contextInfo?.mentionedJid||[]; if(!m.length&&args[0])m.push(phoneToJid(args[0])); if(!m.length){await reply(sock,msg,'❌ Usage: demote @user');return;}
  try{await sock.groupParticipantsUpdate(msg.key.remoteJid,m,'demote');await reply(sock,msg,`✅ Demoted ${m.length} user(s)`);}catch(e){await reply(sock,msg,'❌ '+e.message);}
});
cmd('tagall', ['hidetag'], 'Tag all', async (sock, msg, args) => {
  if(!msg.key.remoteJid.endsWith('@g.us')){await reply(sock,msg,'❌ Groups only');return;}
  try{const md=await sock.groupMetadata(msg.key.remoteJid);const mentions=md.participants.map(p=>p.id);const text=args.join(' ')||'┏━━━━━✧ *TAG ALL* ✧━━━━━\n';await sock.sendMessage(msg.key.remoteJid,{text,mentions},{quoted:createFakeContact(msg)});}catch(e){await reply(sock,msg,'❌ '+e.message);}
});
cmd('tosgroup', ['groupstatus'], 'Set group status (admin only, reply to msg)', async (sock, msg) => {
  if(!msg.key.remoteJid.endsWith('@g.us')){await reply(sock,msg,'❌ Groups only');return;}
  const senderJid = msg.key.participant || msg.key.remoteJid;
  if(!await isGroupAdmin(sock, msg.key.remoteJid, senderJid)){await reply(sock,msg,'❌ Only group admins can use this command');return;}
  const q=msg.message?.extendedTextMessage?.contextInfo?.quotedMessage; if(!q){await reply(sock,msg,'❌ Reply to a text/media to set as group status');return;}
  let t=''; if(q.conversation)t=q.conversation; else if(q.extendedTextMessage?.text)t=q.extendedTextMessage.text; else if(q.imageMessage?.caption)t=q.imageMessage.caption; else if(q.videoMessage?.caption)t=q.videoMessage.caption;
  if(!t){await reply(sock,msg,'❌ Could not extract text');return;}
  try{await sock.groupUpdateDescription(msg.key.remoteJid,t);await reply(sock,msg,'✅ Group status updated!');}catch(e){await reply(sock,msg,'❌ '+e.message);}
});
cmd('close', ['lockgroup'], 'Close group (admin only)', async (sock, msg) => { if(!msg.key.remoteJid.endsWith('@g.us')){await reply(sock,msg,'❌ Groups only');return;} const senderJid = msg.key.participant || msg.key.remoteJid; if(!await isGroupAdmin(sock, msg.key.remoteJid, senderJid)){await reply(sock,msg,'❌ Only group admins can use this command');return;} try{await sock.groupSettingUpdate(msg.key.remoteJid,'announcement');await reply(sock,msg,'✅ Group closed — admin only');}catch(e){await reply(sock,msg,'❌ '+e.message);} });
cmd('open', ['opengroup'], 'Open group (admin only)', async (sock, msg) => { if(!msg.key.remoteJid.endsWith('@g.us')){await reply(sock,msg,'❌ Groups only');return;} const senderJid = msg.key.participant || msg.key.remoteJid; if(!await isGroupAdmin(sock, msg.key.remoteJid, senderJid)){await reply(sock,msg,'❌ Only group admins can use this command');return;} try{await sock.groupSettingUpdate(msg.key.remoteJid,'not_announcement');await reply(sock,msg,'✅ Group opened — everyone');}catch(e){await reply(sock,msg,'❌ '+e.message);} });
cmd('setname', ['groupname'], 'Set group name (admin only)', async (sock, msg, args) => { if(!msg.key.remoteJid.endsWith('@g.us')){await reply(sock,msg,'❌ Groups only');return;} const senderJid = msg.key.participant || msg.key.remoteJid; if(!await isGroupAdmin(sock, msg.key.remoteJid, senderJid)){await reply(sock,msg,'❌ Only group admins can use this command');return;} const n=args.join(' '); if(!n){await reply(sock,msg,'❌ Usage: setname <name>');return;} try{await sock.groupUpdateSubject(msg.key.remoteJid,n);await reply(sock,msg,`✅ Name: ${n}`);}catch(e){await reply(sock,msg,'❌ '+e.message);} });

// Media
cmd('sticker', ['s'], 'Make sticker', async (sock, msg) => {
  const q=msg.message?.extendedTextMessage?.contextInfo?.quotedMessage; const hi=msg.message?.imageMessage||q?.imageMessage; if(!hi){await reply(sock,msg,'❌ Reply to an image');return;}
  try{let b; if(msg.message.imageMessage)b=await downloadMediaMessage(msg, 'buffer', {}, sock); else b=await downloadMediaMessage({key:msg.key,message:q}, 'buffer', {}, sock); await sock.sendMessage(msg.key.remoteJid,{sticker:b,pack:CONFIG.botName,author:getSetting('ownerName',CONFIG.ownerName)},{quoted:createFakeContact(msg)});}catch(e){await reply(sock,msg,'❌ '+e.message);}
});
cmd('vv', ['unlock', 'tovv', 'viewonce'], 'Unlock view-once media (reply to view-once)', async (sock, msg) => {
  const q = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  // Check for view-once image or video (both direct and viewOnceMessage wrapper)
  const isVVImage = q?.imageMessage?.viewOnce || q?.viewOnceMessage?.message?.imageMessage;
  const isVVVideo = q?.videoMessage?.viewOnce || q?.viewOnceMessage?.message?.videoMessage;
  const isVVAudio = q?.audioMessage?.viewOnce || q?.viewOnceMessage?.message?.audioMessage;
  if (!isVVImage && !isVVVideo && !isVVAudio) {
    await reply(sock, msg, '❌ Reply to a view-once photo/video/audio with .vv to unlock it');
    return;
  }
  try {
    // Download the view-once media
    const quotedKey = {
      remoteJid: msg.key.remoteJid,
      fromMe: msg.message?.extendedTextMessage?.contextInfo?.participant === sock.user.id,
      id: msg.message?.extendedTextMessage?.contextInfo?.stanzaId,
      participant: msg.message?.extendedTextMessage?.contextInfo?.participant
    };
    const mediaMsg = { key: quotedKey, message: q };
    const mediaBuffer = await downloadMediaMessage(mediaMsg, 'buffer', {}, sock);
    if (!mediaBuffer || mediaBuffer.length < 100) throw new Error('Could not download view-once media');

    // Determine type
    let mediaType = 'image';
    if (isVVVideo) mediaType = 'video';
    else if (isVVAudio) mediaType = 'audio';

    // Send UNLOCKED media to the owner's own DM (sock.user.id)
    const ownerJid = sock.user.id;
    if (mediaType === 'image') {
      await sock.sendMessage(ownerJid, { image: mediaBuffer, caption: `🔓 *VIEW-ONCE UNLOCKED*\n\n*From:* ${msg.key.remoteJid.endsWith('@g.us') ? (msg.key.participant ? String(msg.key.participant).split('@')[0] : 'Group') : 'DM'}\n*Type:* Photo (unlocked 🔓)` });
    } else if (mediaType === 'video') {
      await sock.sendMessage(ownerJid, { video: mediaBuffer, caption: `🔓 *VIEW-ONCE UNLOCKED*\n\n*From:* ${msg.key.remoteJid.endsWith('@g.us') ? (msg.key.participant ? String(msg.key.participant).split('@')[0] : 'Group') : 'DM'}\n*Type:* Video (unlocked 🔓)` });
    } else if (mediaType === 'audio') {
      await sock.sendMessage(ownerJid, { audio: mediaBuffer, mimetype: 'audio/mpeg' });
      await sock.sendMessage(ownerJid, { text: `🔓 *VIEW-ONCE UNLOCKED*\n\n*From:* ${msg.key.remoteJid.endsWith('@g.us') ? (msg.key.participant ? String(msg.key.participant).split('@')[0] : 'Group') : 'DM'}\n*Type:* Audio (unlocked 🔓)` });
    }

    // React to the view-once message with 🤦
    try {
      await sock.sendMessage(msg.key.remoteJid, {
        react: { text: '🤦', key: { remoteJid: msg.key.remoteJid, id: msg.message?.extendedTextMessage?.contextInfo?.stanzaId, fromMe: false, participant: msg.message?.extendedTextMessage?.contextInfo?.participant }
        }
      });
    } catch (e) { console.log('  ⚠ React failed:', e.message); }

    await reply(sock, msg, '✅ View-once media unlocked and sent to your DM! 🤦');
    console.log(`  🔓 [VV] Unlocked view-once ${mediaType} for +${sock.user.id.split('@')[0]}`);
  } catch (e) { await reply(sock, msg, '❌ Failed to unlock: ' + e.message); }
});
cmd('getdp', ['pp','profilepic'], 'Get profile pic', async (sock, msg, args) => {
  let jid; if(msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length) jid=msg.message.extendedTextMessage.contextInfo.mentionedJid[0]; else if(args[0]) jid=phoneToJid(args[0]); else jid=msg.key.participant||msg.key.remoteJid;
  try{const url=await sock.profilePictureUrl(jid,'image');const res=await fetch(url);const b=Buffer.from(await res.arrayBuffer());await replyImage(sock,msg,b,`📸 @${String(jid).split('@')[0]}`,{mentions:[jid]});}catch(e){await reply(sock,msg,'❌ Could not fetch DP (hidden).');}
});
cmd('qr', ['qrcode'], 'Generate QR', async (sock, msg, args) => { const t=args.join(' '); if(!t){await reply(sock,msg,'❌ Usage: qr <text>');return;} try{const u=`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(t)}`;const r=await fetch(u);const b=Buffer.from(await r.arrayBuffer());await replyImage(sock,msg,b,`QR: ${t}`);}catch(e){await reply(sock,msg,'❌ '+e.message);} });
cmd('song', ['play', 'music'], 'Download full song', async (sock, msg, args) => {
  const query = args.join(' ');
  if (!query) { await reply(sock, msg, `❌ Usage: ${getSetting('prefix', CONFIG.prefix)}song <song name>\n\nExample: .song Blinding Lights`); return; }
  try {
    await sock.sendPresenceUpdate('composing', msg.key.remoteJid);
    const waitMsg = await reply(sock, msg, `🎵 Searching for: "${query}"...\n⏳ Downloading — this may take 10-30 seconds`);
    // Use a public YouTube audio API
    const apiUrl = `https://api.safone.dev/api/ytdl?query=${encodeURIComponent(query)}&type=audio`;
    const res = await fetch(apiUrl, { timeout: 60000 });
    if (!res.ok) throw new Error('API error ' + res.status);
    const data = await res.json();
    if (!data?.result?.download?.audio) throw new Error('No audio URL found');
    const audioUrl = data.result.download.audio;
    const title = data.result.title || query;
    const duration = data.result.duration || 'Unknown';
    const thumbnail = data.result.thumbnail;
    // Download the audio
    const audioRes = await fetch(audioUrl, { timeout: 120000 });
    if (!audioRes.ok) throw new Error('Audio download failed');
    const audioBuf = Buffer.from(await audioRes.arrayBuffer());
    try { await sock.deleteMessage(waitMsg.key.chat, waitMsg.key); } catch {}
    // Send as audio document
    await sock.sendMessage(msg.key.remoteJid, {
      audio: audioBuf,
      mimetype: 'audio/mpeg',
      fileName: `${title}.mp3`,
      caption: `🎵 *${title}*\n⏱️ Duration: ${duration}\n💾 Size: ${(audioBuf.length / 1024 / 1024).toFixed(1)} MB`
    }, { quoted: await createFakeContact(msg) });
    console.log(`  ✓ [SONG] Sent "${title}" (${(audioBuf.length / 1024 / 1024).toFixed(1)} MB)`);
  } catch (e) {
    // Fallback: search YouTube and send link
    try {
      const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
      await reply(sock, msg, `🎵 *${query}*\n\n⚠️ Direct download failed: ${e.message}\n\n🔗 Search on YouTube:\n${searchUrl}\n\n_Use .ytmp3 <url> to convert._`);
    } catch (e2) {
      await reply(sock, msg, `❌ Song download failed: ${e.message}`);
    }
  }
});
cmd('tls', [], 'Text sticker', async (sock, msg, args) => { const t=args.join(' '); if(!t){await reply(sock,msg,'❌ Usage: tls <text>');return;} await reply(sock,msg,`💬 ${t}`); });

// AI
cmd('ai', ['ask','gpt'], 'AI response', async (sock, msg, args) => { const q=args.join(' '); if(!q){await reply(sock,msg,'❌ Usage: ai <question>');return;} try{await sock.sendPresenceUpdate('composing',msg.key.remoteJid);const r=await fetch(`https://api.safone.dev/api/ai?query=${encodeURIComponent(q)}`);if(!r.ok)throw new Error('API');const d=await r.json();await reply(sock,msg,`🧠 ${d.answer||d.message||d.response||'No response'}`);}catch(e){await reply(sock,msg,`🧠 I can't answer that right now.`);} });

// Fun
cmd('8ball', ['eightball'], 'Magic 8-ball', async (sock, msg) => { const r=['✅ Yes','❌ No','🤔 Maybe','Definitely ✅','Not in a million years ❌','Ask again later 🕐']; await reply(sock,msg,`🎱 ${r[Math.floor(Math.random()*r.length)]}`); });
cmd('coinflip', ['flip'], 'Flip coin', async (sock, msg) => { await reply(sock,msg,`🪙 ${Math.random()<0.5?'Heads':'Tails'}`); });
cmd('dice', ['roll'], 'Roll dice', async (sock, msg) => { await reply(sock,msg,`🎲 ${Math.floor(Math.random()*6)+1}`); });
cmd('dare', [], 'Dare', async (sock, msg) => { const d=['Send a voice note singing 🎤','Change profile pic to a meme 🖼️','Do 10 push-ups 💪']; await reply(sock,msg,`🎯 *Dare:* ${d[Math.floor(Math.random()*d.length)]}`); });
cmd('truth', [], 'Truth', async (sock, msg) => { const t=['Biggest fear? 😨','Most embarrassing moment? 😳','Secret talent? 🎭']; await reply(sock,msg,`🤐 *Truth:* ${t[Math.floor(Math.random()*t.length)]}`); });
cmd('joke', [], 'Joke', async (sock, msg) => { const j=['Why did the scarecrow win an award? He was outstanding in his field! 🌾','I told my computer I needed a break — it said "I\'ll go to sleep." 💻']; await reply(sock,msg,`😂 ${j[Math.floor(Math.random()*j.length)]}`); });
cmd('quote', [], 'Quote', async (sock, msg) => { const q=['"Code is like humor. When you have to explain it, it\'s bad." — Cory House','"First solve the problem. Then write the code." — John Johnson']; await reply(sock,msg,`💬 ${q[Math.floor(Math.random()*q.length)]}`); });
cmd('fact', [], 'Fact', async (sock, msg) => { const f=['Honey never spoils. 3000-year-old honey is still edible. 🍯','Octopuses have 3 hearts and blue blood. 🐙']; await reply(sock,msg,`📚 ${f[Math.floor(Math.random()*f.length)]}`); });

// Info
cmd('whoami', [], 'Your info', async (sock, msg) => { const jid=msg.key.participant||msg.key.remoteJid; const num=String(jid).split('@')[0].split(':')[0]; await reply(sock,msg,`┏━━━━━✧ *WHO AM I* ✧━━━━━\n┃✧ Number: ${num}\n┃✧ Owner: ${isOwner(jid)?'✅':'❌'}\n┃✧ Bot: ${CONFIG.botName}\n┗━━━━━━━━━━━━━━━━━━━━━━━━`); });
cmd('botinfo', ['info'], 'Bot info', async (sock, msg) => { await reply(sock,msg,`┏━━━━━✧ *BOT INFO* ✧━━━━━\n┃✧ Name: ${getSetting('botName',CONFIG.botName)}\n┃✧ Version: ${CONFIG.botVersion}\n┃✧ Owner: ${getSetting('ownerName',CONFIG.ownerName)}\n┃✧ Prefix: [ ${getSetting('prefix',CONFIG.prefix)} ]\n┃✧ Mode: ${getMode()}\n┃✧ Uptime: ${fmtUptime(process.uptime()*1000)}\n┃✧ RAM: ${(process.memoryUsage().rss/1024/1024).toFixed(0)} MB\n┗━━━━━━━━━━━━━━━━━━━━━━━━`); });
cmd('calc', ['calculate'], 'Calculate', async (sock, msg, args) => { const e=args.join(' '); if(!e){await reply(sock,msg,'❌ Usage: calc <expression>');return;} try{const r=Function('"use strict";return ('+e.replace(/[^0-9+\-*/().%\s]/g,'')+')')();await reply(sock,msg,`🔢 ${e} = ${r}`);}catch{await reply(sock,msg,'❌ Invalid');} });

// ─── DOWNLOAD COMMANDS ─────────────────────────────────────────────
cmd('url', ['direct'], 'Direct URL download (reply to media)', async (sock, msg) => {
  const q = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!q) { await reply(sock, msg, '❌ Reply to a media message with .url'); return; }
  // Extract the direct URL from the quoted message
  let url = '';
  if (q.imageMessage?.url) url = q.imageMessage.url;
  else if (q.videoMessage?.url) url = q.videoMessage.url;
  else if (q.audioMessage?.url) url = q.audioMessage.url;
  else if (q.documentMessage?.url) url = q.documentMessage.url;
  else if (q.stickerMessage?.url) url = q.stickerMessage.url;
  if (!url) { await reply(sock, msg, '❌ Could not extract URL from the quoted message'); return; }
  await reply(sock, msg, `🔗 *Direct URL:*\n\n${url}\n\n_Copy this URL to download the media directly._`);
});

cmd('apk', [], 'Download APK (search)', async (sock, msg, args) => {
  const name = args.join(' ');
  if (!name) { await reply(sock, msg, '❌ Usage: apk <app name>'); return; }
  await reply(sock, msg, `📱 *APK Search: ${name}*\n\nhttps://apkpure.com/search?q=${encodeURIComponent(name)}\n\n_Download from APKPure — always verify apps before installing._`);
});

cmd('mediafire', ['mf'], 'MediaFire download link', async (sock, msg, args) => {
  const url = args[0];
  if (!url || !url.includes('mediafire.com')) { await reply(sock, msg, '❌ Usage: mediafire <mediafire-url>'); return; }
  await reply(sock, msg, `📥 *MediaFire Link:*\n\n${url}\n\n_Open the link in your browser to download._`);
});

cmd('tiktok', ['tt'], 'TikTok download', async (sock, msg, args) => {
  const url = args[0];
  if (!url || !url.includes('tiktok.com')) { await reply(sock, msg, '❌ Usage: tiktok <tiktok-url>'); return; }
  try {
    const api = `https://api.tiklydown.eu.org/api/download?url=${encodeURIComponent(url)}`;
    const res = await fetch(api);
    if (!res.ok) throw new Error('API error');
    const data = await res.json();
    if (data?.result?.video?.downloadUrl) {
      const vRes = await fetch(data.result.video.downloadUrl);
      const buf = Buffer.from(await vRes.arrayBuffer());
      await sock.sendMessage(msg.key.remoteJid, { video: buf, caption: `🎵 *${data.result.author?.nickname || 'TikTok'}*\n\n${data.result.desc || ''}` }, { quoted: createFakeContact(msg) });
    } else {
      await reply(sock, msg, '❌ Could not fetch TikTok video');
    }
  } catch (e) { await reply(sock, msg, '❌ TikTok download failed: ' + e.message); }
});

cmd('facebook', ['fb'], 'Facebook video download', async (sock, msg, args) => {
  const url = args[0];
  if (!url || !url.includes('facebook.com')) { await reply(sock, msg, '❌ Usage: facebook <fb-url>'); return; }
  await reply(sock, msg, `📘 *Facebook Video:*\n\n${url}\n\n_Direct download requires a scraper API. Use an online FB downloader for now._`);
});

cmd('ig', ['instagram'], 'Instagram download', async (sock, msg, args) => {
  const url = args[0];
  if (!url || !url.includes('instagram.com')) { await reply(sock, msg, '❌ Usage: ig <instagram-url>'); return; }
  await reply(sock, msg, `📸 *Instagram Post:*\n\n${url}\n\n_Use an online IG downloader (e.g. snapinsta.app) for now._`);
});

cmd('twitter', ['x'], 'Twitter/X download', async (sock, msg, args) => {
  const url = args[0];
  if (!url || !(url.includes('twitter.com') || url.includes('x.com'))) { await reply(sock, msg, '❌ Usage: twitter <tweet-url>'); return; }
  await reply(sock, msg, `🐦 *Twitter/X Post:*\n\n${url}\n\n_Use an online Twitter downloader (e.g. ssstwitter.com) for now._`);
});

cmd('yt', ['youtube'], 'YouTube search', async (sock, msg, args) => {
  const q = args.join(' ');
  if (!q) { await reply(sock, msg, '❌ Usage: yt <search query>'); return; }
  await reply(sock, msg, `🔍 *YouTube Search: ${q}*\n\nhttps://www.youtube.com/results?search_query=${encodeURIComponent(q)}`);
});

cmd('ytmp3', ['yta'], 'YouTube to MP3', async (sock, msg, args) => {
  const url = args[0];
  if (!url || !url.includes('youtube.com') && !url.includes('youtu.be')) { await reply(sock, msg, '❌ Usage: ytmp3 <youtube-url>'); return; }
  await reply(sock, msg, `🎵 *YouTube → MP3*\n\nURL: ${url}\n\n_Convert at ytmp3.cc or similar service._`);
});

cmd('ytmp4', ['ytv'], 'YouTube to MP4', async (sock, msg, args) => {
  const url = args[0];
  if (!url || !url.includes('youtube.com') && !url.includes('youtu.be')) { await reply(sock, msg, '❌ Usage: ytmp4 <youtube-url>'); return; }
  await reply(sock, msg, `🎬 *YouTube → MP4*\n\nURL: ${url}\n\n_Convert at ytmp4.cc or similar service._`);
});

cmd('play', ['playsong'], 'Play song (search)', async (sock, msg, args) => {
  const q = args.join(' ');
  if (!q) { await reply(sock, msg, '❌ Usage: play <song name>'); return; }
  await reply(sock, msg, `🎵 *Searching: ${q}*\n\nhttps://www.youtube.com/results?search_query=${encodeURIComponent(q)}\n\n_Use .ytmp3 <url> to convert._`);
});

// ─── TOOLS ────────────────────────────────────────────────────────
cmd('weather', ['wx'], 'Weather forecast', async (sock, msg, args) => {
  const city = args.join(' ');
  if (!city) { await reply(sock, msg, '❌ Usage: weather <city>'); return; }
  try {
    const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=3`);
    const text = await res.text();
    await reply(sock, msg, `🌤️ *Weather: ${city}*\n\n${text}`);
  } catch (e) { await reply(sock, msg, '❌ Weather fetch failed'); }
});

cmd('lyrics', [], 'Song lyrics', async (sock, msg, args) => {
  const q = args.join(' ');
  if (!q) { await reply(sock, msg, '❌ Usage: lyrics <song name>'); return; }
  await reply(sock, msg, `🎵 *Lyrics for: ${q}*\n\nhttps://www.google.com/search?q=${encodeURIComponent(q + ' lyrics')}\n\n_Search Google for the full lyrics._`);
});

cmd('wiki', ['wikipedia'], 'Wikipedia search', async (sock, msg, args) => {
  const q = args.join(' ');
  if (!q) { await reply(sock, msg, '❌ Usage: wiki <query>'); return; }
  try {
    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error('Not found');
    const data = await res.json();
    await reply(sock, msg, `📚 *${data.title}*\n\n${data.extract}\n\n_Source: Wikipedia_`);
  } catch (e) { await reply(sock, msg, '❌ Wikipedia article not found'); }
});

cmd('define', ['dictionary'], 'Define a word', async (sock, msg, args) => {
  const word = args.join(' ');
  if (!word) { await reply(sock, msg, '❌ Usage: define <word>'); return; }
  try {
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
    if (!res.ok) throw new Error('Not found');
    const data = await res.json();
    const def = data[0]?.meanings?.[0]?.definitions?.[0];
    if (def) await reply(sock, msg, `📖 *${word}*\n\n${def.definition}\n\n_Part of speech: ${data[0].meanings[0].partOfSpeech}_`);
    else await reply(sock, msg, '❌ No definition found');
  } catch (e) { await reply(sock, msg, '❌ Word not found in dictionary'); }
});

cmd('shorten', ['shorturl'], 'Shorten URL', async (sock, msg, args) => {
  const url = args[0];
  if (!url) { await reply(sock, msg, '❌ Usage: shorten <url>'); return; }
  try {
    const res = await fetch(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(url)}`);
    const short = await res.text();
    await reply(sock, msg, `🔗 *Shortened:*\n\n${short}`);
  } catch (e) { await reply(sock, msg, '❌ URL shorten failed'); }
});

cmd('ss', ['screenshot'], 'Screenshot a URL', async (sock, msg, args) => {
  const url = args[0];
  if (!url) { await reply(sock, msg, '❌ Usage: ss <url>'); return; }
  try {
    const ssUrl = `https://api.microlink.io/?url=${encodeURIComponent(url)}&screenshot=true&meta=true&embed=screenshot.url`;
    const res = await fetch(ssUrl);
    const data = await res.json();
    if (data?.data?.screenshot?.url) {
      const imgRes = await fetch(data.data.screenshot.url);
      const buf = Buffer.from(await imgRes.arrayBuffer());
      await replyImage(sock, msg, buf, `📸 Screenshot of ${url}`);
    } else {
      await reply(sock, msg, '❌ Could not screenshot that URL');
    }
  } catch (e) { await reply(sock, msg, '❌ Screenshot failed: ' + e.message); }
});

cmd('tts', ['speak'], 'Text to speech (reply to text)', async (sock, msg, args) => {
  const text = args.join(' ');
  if (!text) { await reply(sock, msg, '❌ Usage: tts <text>'); return; }
  try {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=en&client=tw-ob`;
    const res = await fetch(url);
    const buf = Buffer.from(await res.arrayBuffer());
    await sock.sendMessage(msg.key.remoteJid, { audio: buf, mimetype: 'audio/mpeg' }, { quoted: createFakeContact(msg) });
  } catch (e) { await reply(sock, msg, '❌ TTS failed: ' + e.message); }
});

cmd('carbon', ['codesnippet'], 'Carbon code snippet', async (sock, msg, args) => {
  const code = args.join(' ');
  if (!code) { await reply(sock, msg, '❌ Usage: carbon <code>'); return; }
  try {
    const url = `https://carbonnowsh.herokuapp.com/?code=${encodeURIComponent(code)}`;
    await reply(sock, msg, `🎨 *Carbon snippet:*\n\n${url}\n\n_Open the link to see your code as an image._`);
  } catch (e) { await reply(sock, msg, '❌ Carbon failed'); }
});

cmd('nulis', ['write'], 'Text to handwriting image', async (sock, msg, args) => {
  const text = args.join(' ');
  if (!text) { await reply(sock, msg, '❌ Usage: nulis <text>'); return; }
  try {
    const url = `https://api.zahwazein.xyz/entertainment/nulis?text=${encodeURIComponent(text)}&apikey=KEYS`;
    await reply(sock, msg, `✍️ *Handwriting image:*\n\n_Text: ${text}_\n\n_Use an online text-to-handwriting tool for now._`);
  } catch (e) { await reply(sock, msg, '❌ Nulis failed'); }
});

cmd('base64', ['b64'], 'Base64 encode/decode', async (sock, msg, args) => {
  const mode = args[0]; const text = args.slice(1).join(' ');
  if (!mode || !text || (mode !== 'enc' && mode !== 'dec')) { await reply(sock, msg, '❌ Usage: base64 enc <text> | base64 dec <base64>'); return; }
  try {
    const result = mode === 'enc' ? Buffer.from(text).toString('base64') : Buffer.from(text, 'base64').toString('utf8');
    await reply(sock, msg, `🔐 *Base64 ${mode === 'enc' ? 'Encode' : 'Decode'}:*\n\n${result}`);
  } catch (e) { await reply(sock, msg, '❌ Invalid base64'); }
});

cmd('uuid', ['guid'], 'Generate UUID', async (sock, msg) => {
  const uuid = crypto.randomUUID();
  await reply(sock, msg, `🆔 *UUID:*\n\n${uuid}`);
});

cmd('timestamp', ['ts'], 'Current Unix timestamp', async (sock, msg) => {
  await reply(sock, msg, `⏰ *Unix Timestamp:*\n\n${Math.floor(Date.now() / 1000)}`);
});

cmd('hex', ['hexencode'], 'Text to hex', async (sock, msg, args) => {
  const text = args.join(' ');
  if (!text) { await reply(sock, msg, '❌ Usage: hex <text>'); return; }
  const hex = Buffer.from(text).toString('hex');
  await reply(sock, msg, `🔢 *Hex:*\n\n${hex}`);
});

cmd('binary', ['bin'], 'Text to binary', async (sock, msg, args) => {
  const text = args.join(' ');
  if (!text) { await reply(sock, msg, '❌ Usage: binary <text>'); return; }
  const bin = text.split('').map(c => c.charCodeAt(0).toString(2).padStart(8, '0')).join(' ');
  await reply(sock, msg, `🔢 *Binary:*\n\n${bin}`);
});

cmd('reverse', ['rev'], 'Reverse text', async (sock, msg, args) => {
  const text = args.join(' ');
  if (!text) { await reply(sock, msg, '❌ Usage: reverse <text>'); return; }
  await reply(sock, msg, `🔄 *Reversed:*\n\n${text.split('').reverse().join('')}`);
});

cmd('uppercase', ['upper'], 'To uppercase', async (sock, msg, args) => {
  const text = args.join(' ');
  if (!text) { await reply(sock, msg, '❌ Usage: uppercase <text>'); return; }
  await reply(sock, msg, `🔡 *UPPERCASE:*\n\n${text.toUpperCase()}`);
});

cmd('lowercase', ['lower'], 'To lowercase', async (sock, msg, args) => {
  const text = args.join(' ');
  if (!text) { await reply(sock, msg, '❌ Usage: lowercase <text>'); return; }
  await reply(sock, msg, `🔡 *lowercase:*\n\n${text.toLowerCase()}`);
});

// ─── GROUP EXTENSIONS ──────────────────────────────────────────────
cmd('groupinfo', ['gpinfo'], 'Group info', async (sock, msg) => {
  if (!msg.key.remoteJid.endsWith('@g.us')) { await reply(sock, msg, '❌ Groups only'); return; }
  try {
    const md = await sock.groupMetadata(msg.key.remoteJid);
    await reply(sock, msg, `┏━━━━━✧ *GROUP INFO* ✧━━━━━\n┃✧ Name: ${md.subject}\n┃✧ Members: ${md.participants.length}\n┃✧ Created: ${new Date(md.creation * 1000).toLocaleDateString()}\n┃✧ Owner: ${md.owner ? String(md.owner).split('@')[0] : 'Unknown'}\n┃✧ Desc: ${md.desc || 'No description'}\n┗━━━━━━━━━━━━━━━━━━━━━━━━`);
  } catch (e) { await reply(sock, msg, '❌ ' + e.message); }
});

cmd('del', ['delete'], 'Delete message (reply to msg)', async (sock, msg) => {
  const q = msg.message?.extendedTextMessage?.contextInfo;
  if (!q?.quotedMessage) { await reply(sock, msg, '❌ Reply to a message to delete it'); return; }
  try {
    const key = { remoteJid: msg.key.remoteJid, id: q.stanzaId, fromMe: q.participant === sock.user.id, participant: q.participant };
    await sock.sendMessage(msg.key.remoteJid, { delete: key });
  } catch (e) { await reply(sock, msg, '❌ ' + e.message); }
});

cmd('revoke', ['revokegroup'], 'Revoke group invite (admin only)', async (sock, msg) => {
  if (!msg.key.remoteJid.endsWith('@g.us')) { await reply(sock, msg, '❌ Groups only'); return; }
  const senderJid = msg.key.participant || msg.key.remoteJid;
  if (!await isGroupAdmin(sock, msg.key.remoteJid, senderJid)) { await reply(sock, msg, '❌ Only group admins can use this command'); return; }
 
  try { await sock.groupRevokeInvite(msg.key.remoteJid); await reply(sock, msg, '✅ Group invite link revoked'); }
  catch (e) { await reply(sock, msg, '❌ ' + e.message); }
});

cmd('setdesc', ['groupdesc'], 'Set group description (admin only)', async (sock, msg, args) => {
  if (!msg.key.remoteJid.endsWith('@g.us')) { await reply(sock, msg, '❌ Groups only'); return; }
  const senderJid = msg.key.participant || msg.key.remoteJid;
  if (!await isGroupAdmin(sock, msg.key.remoteJid, senderJid)) { await reply(sock, msg, '❌ Only group admins can use this command'); return; }
 
  const desc = args.join(' '); if (!desc) { await reply(sock, msg, '❌ Usage: setdesc <text>'); return; }
  try { await sock.groupUpdateDescription(msg.key.remoteJid, desc); await reply(sock, msg, '✅ Description updated'); }
  catch (e) { await reply(sock, msg, '❌ ' + e.message); }
});

// ─── ADMIN EXTENSIONS ──────────────────────────────────────────────
cmd('block', ['blk'], 'Block a user', async (sock, msg, args) => {
  const m = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid||[];
  if(!m.length&&args[0]) m.push(phoneToJid(args[0])); if(!m.length){await reply(sock,msg,'❌ Usage: block @user|number');return;}
  try { for (const jid of m) await sock.updateBlockStatus(jid, 'block'); await reply(sock, msg, `✅ Blocked ${m.length} user(s)`); }
  catch (e) { await reply(sock, msg, '❌ ' + e.message); }
});

cmd('unblock', ['unblk'], 'Unblock a user', async (sock, msg, args) => {
  const m = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid||[];
  if(!m.length&&args[0]) m.push(phoneToJid(args[0])); if(!m.length){await reply(sock,msg,'❌ Usage: unblock @user|number');return;}
  try { for (const jid of m) await sock.updateBlockStatus(jid, 'unblock'); await reply(sock, msg, `✅ Unblocked ${m.length} user(s)`); }
  catch (e) { await reply(sock, msg, '❌ ' + e.message); }
});

cmd('autostatusview', ['asv'], 'Toggle auto status view', async (sock, msg) => {
  const cur = getSetting('autostatusview', 'off'); const next = cur === 'on' ? 'off' : 'on'; setSetting('autostatusview', next);
  await reply(sock, msg, `✅ Auto status view is now *${next.toUpperCase()}*`);
});

// ─── INFO EXTENSIONS ────────────────────────────────────────────────
cmd('server', ['hostinfo'], 'Server info', async (sock, msg) => {
  const mem = process.memoryUsage();
  const cpus = ['Single core', 'Dual core', 'Quad core'][Math.floor(Math.random() * 3)];
  await reply(sock, msg, `┏━━━━━✧ *SERVER* ✧━━━━━\n┃✧ Platform: ${process.platform}\n┃✧ Node: ${process.version}\n┃✧ RAM: ${(mem.rss/1024/1024).toFixed(0)} MB\n┃✧ Uptime: ${fmtUptime(process.uptime()*1000)}\n┃✧ PID: ${process.pid}\n┗━━━━━━━━━━━━━━━━━━━━━━━━`);
});

cmd('stats', ['statistics'], 'Bot statistics', async (sock, msg) => {
  const totalCmds = Object.values(COMMAND_LIST).reduce((a,b) => a + b.length, 0);
  const mem = process.memoryUsage();
  await reply(sock, msg, `┏━━━━━✧ *STATS* ✧━━━━━\n┃✧ Commands: ${totalCmds}\n┃✧ Categories: ${Object.keys(COMMAND_LIST).length}\n┃✧ Uptime: ${fmtUptime(process.uptime()*1000)}\n┃✧ RAM: ${(mem.rss/1024/1024).toFixed(0)} MB\n┃✧ CPU: ${process.cpuUsage().user/1000} ms\n┗━━━━━━━━━━━━━━━━━━━━━━━━`);
});

cmd('timezone', ['tz'], 'Show timezone', async (sock, msg) => {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const time = new Date().toLocaleString('en-US', { timeZone: tz });
  await reply(sock, msg, `🌍 *Timezone:* ${tz}\n🕒 *Local time:* ${time}`);
});

// ─── LOGO MAKER ────────────────────────────────────────────────────
for (const [name, style] of [['logo','Default'],['neon','Neon'],['glitch','Glitch'],['burn','Burn'],['crimson','Crimson'],['golden','Golden'],['ice','Ice'],['fire','Fire'],['water','Water'],['smoke','Smoke'],['bokeh','Bokeh'],['rainbow','Rainbow'],['sparkle','Sparkle']]) {
  cmd(name, [], `${style} text logo`, async (sock, msg, args) => {
    const text = args.join(' ');
    if (!text) { await reply(sock, msg, `❌ Usage: ${name} <text>`); return; }
    try {
      const url = `https://api.zahwazein.xyz/ephoto/${name}?text=${encodeURIComponent(text)}&apikey=KEYS`;
      // Fallback to a simpler text logo API
      const fallbackUrl = `https://flamingtext.com/net-fu/proxy.php?image=${name}-logo&script=${name}-logo&text=${encodeURIComponent(text)}&_loc=rop&dynsym=0`;
      const res = await fetch(fallbackUrl, { redirect: 'follow' });
      if (res.ok && res.headers.get('content-type')?.startsWith('image/')) {
        const buf = Buffer.from(await res.arrayBuffer());
        await replyImage(sock, msg, buf, `🎨 *${style} logo: ${text}*`);
      } else {
        await reply(sock, msg, `🎨 *${style} logo: ${text}*\n\nhttps://flamingtext.com/net-fu/proxy.php?image=${name}-logo&script=${name}-logo&text=${encodeURIComponent(text)}\n\n_Click the link to view your logo._`);
      }
    } catch (e) { await reply(sock, msg, `🎨 *${style} logo: ${text}*\n\n_Generate at flamingtext.com (style: ${name})_`); }
  });
}

// ─── CONVERTER ─────────────────────────────────────────────────────
cmd('toimg', ['toimage'], 'Sticker to image (reply to sticker)', async (sock, msg) => {
  const q = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!q?.stickerMessage) { await reply(sock, msg, '❌ Reply to a sticker with .toimg'); return; }
  try {
    const buf = await downloadMediaMessage({key:msg.key,message:q}, 'buffer', {}, sock);
    await replyImage(sock, msg, buf, '🖼️ Converted to image');
  } catch (e) { await reply(sock, msg, '❌ ' + e.message); }
});

cmd('emojimix', ['emix'], 'Mix two emojis', async (sock, msg, args) => {
  const emojis = args.join(' ');
  if (!emojis || emojis.length < 2) { await reply(sock, msg, '❌ Usage: emojimix <emoji1><emoji2>'); return; }
  try {
    const e1 = encodeURIComponent(emojis[0]); const e2 = encodeURIComponent(emojis[1]);
    const url = `https://tenor.googleapis.com/v2/featured?key=AIzaSyAyimkwY5Z4czYqVrV0lN3VHx5V2vB2xV0&contentfilter=high&media_filter=png_transparent&component=proactive&collection=emoji_kitchen_v5&q=${e1}_${e2}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data?.results?.[0]?.url) {
      const imgRes = await fetch(data.results[0].url);
      const buf = Buffer.from(await imgRes.arrayBuffer());
      await replyImage(sock, msg, buf, `🎨 ${emojis[0]} + ${emojis[1]}`);
    } else { await reply(sock, msg, '❌ Could not mix those emojis'); }
  } catch (e) { await reply(sock, msg, '❌ Emoji mix failed'); }
});

// ─── GAMES ─────────────────────────────────────────────────────────
cmd('riddle', [], 'Random riddle', async (sock, msg) => {
  const riddles = ['I have keys but no locks. I have space but no room. You can enter but can\'t go outside. What am I? (Keyboard)', 'What has hands but can\'t clap? (Clock)', 'What has a face and two hands but no arms or legs? (Clock)', 'I speak without a mouth and hear without ears. I have no body but come alive with wind. (Echo)'];
  await reply(sock, msg, `🧩 *Riddle:*\n\n${riddles[Math.floor(Math.random() * riddles.length)]}`);
});

cmd('trivia', [], 'Random trivia', async (sock, msg) => {
  const trivia = ['The shortest war in history was between Britain and Zanzibar in 1896 — it lasted 38 minutes.', 'A group of flamingos is called a "flamboyance."', 'The human nose can detect over 1 trillion smells.', 'Honey is the only food that does not spoil.', 'A group of crows is called a "murder."'];
  await reply(sock, msg, `📚 *Trivia:*\n\n${trivia[Math.floor(Math.random() * trivia.length)]}`);
});

cmd('mathgame', ['math'], 'Math game', async (sock, msg) => {
  const a = Math.floor(Math.random() * 20) + 1; const b = Math.floor(Math.random() * 20) + 1;
  const ops = ['+', '-', '*']; const op = ops[Math.floor(Math.random() * 3)];
  const answer = op === '+' ? a + b : op === '-' ? a - b : a * b;
  await reply(sock, msg, `🧮 *Math Game:*\n\nWhat is ${a} ${op} ${b}?\n\n_Reply with the answer!_`);
});

// ─── FUN EXTENSIONS ────────────────────────────────────────────────
cmd('ship', [], 'Ship two users', async (sock, msg, args) => {
  const m = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid||[];
  if (m.length < 2) { await reply(sock, msg, '❌ Usage: ship @user1 @user2'); return; }
  const pct = Math.floor(Math.random() * 100) + 1;
  const bar = '❤️'.repeat(Math.round(pct/10)) + '🤍'.repeat(10 - Math.round(pct/10));
  await reply(sock, msg, `💕 *Ship: ${String(m[0]).split('@')[0]} × ${String(m[1]).split('@')[0]}*\n\n${bar}\n${pct}% compatible!`);
});

cmd('horny', [], 'How horny?', async (sock, msg) => {
  const pct = Math.floor(Math.random() * 100);
  await reply(sock, msg, `horniness meter:\n\n${'🔥'.repeat(Math.round(pct/10))}\n${pct}%`);
});

cmd('gay', [], 'How gay?', async (sock, msg) => {
  const pct = Math.floor(Math.random() * 100);
  await reply(sock, msg, `🏳️‍🌈 gay meter:\n\n${'🌈'.repeat(Math.round(pct/10))}\n${pct}%`);
});

cmd('smart', [], 'How smart?', async (sock, msg) => {
  const pct = Math.floor(Math.random() * 100);
  await reply(sock, msg, `🧠 smartness meter:\n\n${'🧠'.repeat(Math.round(pct/10))}\n${pct}%`);
});

cmd('character', ['char'], 'Random character trait', async (sock, msg) => {
  const traits = ['Kind 💚', 'Brave 🦁', 'Wise 🦉', 'Creative 🎨', 'Loyal 🤝', 'Funny 😂', 'Calm 🧘', 'Ambitious 🚀'];
  await reply(sock, msg, `🎭 *Your character: ${traits[Math.floor(Math.random() * traits.length)]}*`);
});

cmd('slots', ['slot'], 'Slot machine', async (sock, msg) => {
  const s = ['🍒', '🍋', '🍊', '🍇', '7️⃣', '💎'];
  const r1 = s[Math.floor(Math.random()*s.length)], r2 = s[Math.floor(Math.random()*s.length)], r3 = s[Math.floor(Math.random()*s.length)];
  const win = r1 === r2 && r2 === r3;
  await reply(sock, msg, `🎰 *SLOTS*\n\n${r1} | ${r2} | ${r3}\n\n${win ? '🎉 JACKPOT! You won!' : '❌ No match. Try again!'}`);
});

cmd('guess', ['guessnum'], 'Guess the number game', async (sock, msg, args) => {
  const num = Math.floor(Math.random() * 10) + 1;
  const guess = parseInt(args[0]);
  if (!guess) { await reply(sock, msg, '🎲 Guess a number 1-10. Usage: guess <number>'); return; }
  await reply(sock, msg, guess === num ? `🎉 Correct! The number was ${num}.` : `❌ Wrong! The number was ${num}. You guessed ${guess}.`);
});

// ─── AI EXTENSIONS ─────────────────────────────────────────────────
cmd('summarize', ['sum'], 'Summarize text', async (sock, msg, args) => {
  const text = args.join(' '); if (!text) { await reply(sock, msg, '❌ Usage: summarize <text>'); return; }
  try { await sock.sendPresenceUpdate('composing', msg.key.remoteJid); const r = await fetch(`https://api.safone.dev/api/ai?query=Summarize this: ${encodeURIComponent(text)}`); const d = await r.json(); await reply(sock, msg, `📝 *Summary:*\n\n${d.answer||d.message||'Failed'}`); }
  catch (e) { await reply(sock, msg, '❌ Summarize failed'); }
});

cmd('explain', ['explaincode'], 'Explain code/text', async (sock, msg, args) => {
  const text = args.join(' '); if (!text) { await reply(sock, msg, '❌ Usage: explain <text>'); return; }
  try { await sock.sendPresenceUpdate('composing', msg.key.remoteJid); const r = await fetch(`https://api.safone.dev/api/ai?query=Explain this: ${encodeURIComponent(text)}`); const d = await r.json(); await reply(sock, msg, `💡 *Explanation:*\n\n${d.answer||d.message||'Failed'}`); }
  catch (e) { await reply(sock, msg, '❌ Explain failed'); }
});

cmd('flirt', [], 'AI flirt', async (sock, msg, args) => {
  const target = args.join(' ') || 'you';
  const lines = ['Are you a magician? Because whenever I look at you, everyone else disappears ✨', 'Do you have a map? I keep getting lost in your eyes 🗺️', 'Are you WiFi? Because I\'m feeling a connection 📶', 'Is your name Google? Because you\'ve got everything I\'ve been searching for 🔍'];
  await reply(sock, msg, `😏 *Flirt for ${target}:*\n\n${lines[Math.floor(Math.random() * lines.length)]}`);
});

cmd('rizz', [], 'Rizz line', async (sock, msg) => {
  const lines = ['Are you a parking ticket? Because you\'ve got FINE written all over you 🎫', 'I\'m not a photographer, but I can picture us together 📸', 'Do you believe in love at first sight, or should I walk by again? 🚶', 'Are you French? Because Eiffel for you 🗼'];
  await reply(sock, msg, `😎 *Rizz:*\n\n${lines[Math.floor(Math.random() * lines.length)]}`);
});

// ─── Message handler ───────────────────────────────────────────────
function extractText(msg) { if(msg.message?.conversation)return msg.message.conversation; if(msg.message?.extendedTextMessage?.text)return msg.message.extendedTextMessage.text; if(msg.message?.imageMessage?.caption)return msg.message.imageMessage.caption; if(msg.message?.videoMessage?.caption)return msg.message.videoMessage.caption; return ''; }

async function handleMessage(sock, msg) {
  if(!msg.message) return;
  const text = extractText(msg); if(!text) return;
  const prefix = getSetting('prefix', CONFIG.prefix); if(!text.startsWith(prefix)) return;
  const body = text.slice(prefix.length).trim(); if(!body) return;
  const [cmdName, ...args] = body.split(/\s+/);
  const command = COMMANDS[cmdName.toLowerCase()]; if(!command) return;
  const senderJid = msg.key.participant || msg.key.remoteJid;
  const senderNum = String(senderJid).split('@')[0].split(':')[0];
  const isGroup = msg.key.remoteJid.endsWith('@g.us');
  console.log(`[MSG] ${isGroup?'GROUP':'DM'} from ${senderNum}: ".${cmdName}"`);
  // ★ In DM: always allow (you can only DM your own bot account)
  // ★ In GROUP: check if sender is the paired user (sudo)
  if (isGroup && !isOwner(senderJid)) {
    await reply(sock, msg, '> *only sudo access🔐*');
    return;
  }
  try { await command.handler(sock, msg, args, { senderJid, senderNum, isGroup }); }
  catch(e) { console.error('  ✗ Command error:', e.message); try{await reply(sock,msg,'❌ '+e.message);}catch{} }
}

async function handleAutoPresence(sock, msg) {
  try { if(getSetting('autoread','off')==='on' && !msg.key.fromMe) await sock.readMessages([msg.key]); }catch{}
  try { if(getSetting('autotyping','off')==='on' && !msg.key.fromMe) await sock.sendPresenceUpdate('composing', msg.key.remoteJid); else if(getSetting('autorecording','off')==='on' && !msg.key.fromMe) await sock.sendPresenceUpdate('recording', msg.key.remoteJid); }catch{}
}

async function handleChatbot(sock, msg) {
  if(getSetting('chatbot','off')!=='on') return; if(msg.key.fromMe) return; if(msg.key.remoteJid.endsWith('@g.us')) return;
  const text = extractText(msg); if(!text || text.startsWith(getSetting('prefix',CONFIG.prefix))) return;
  try { await sock.sendPresenceUpdate('composing', msg.key.remoteJid); const r=await fetch(`https://api.safone.dev/api/ai?query=${encodeURIComponent(text)}`); if(!r.ok) throw new Error(); const d=await r.json(); await sock.sendMessage(msg.key.remoteJid,{text:'🤖 '+(d.answer||d.message||'I didn\'t understand.')},{quoted:createFakeContact(msg)}); }catch{}
}

async function handleCall(sock, calls) {
  if(getSetting('anticall','off')!=='on') return;
  for(const c of calls) { if(c.status==='offer') { try{await sock.rejectCall(c.id,c.from);await sock.sendMessage(c.from,{text:`🚫 Calls rejected. ${CONFIG.botName} is a bot.`},{quoted:createFakeContact({key:{participant:c.from,remoteJid:c.from}})});}catch{} } }
}

// ─── Message store (for anti-delete + view-once unlock) ────────────
// Stores recent messages per user so deleted/view-once ones can be retrieved.
const messageStore = new Map(); // phone → Map(messageId → { text, type, mediaBuffer })

async function storeMessage(msg, phone, sock) {
  if (!messageStore.has(phone)) messageStore.set(phone, new Map());
  const store = messageStore.get(phone);
  const id = msg.key.id;
  let text = '';
  let type = 'text';
  let mediaBuffer = null;

  if (msg.message?.conversation) text = msg.message.conversation;
  else if (msg.message?.extendedTextMessage?.text) text = msg.message.extendedTextMessage.text;
  else if (msg.message?.imageMessage?.caption) { text = msg.message.imageMessage.caption; type = 'image'; }
  else if (msg.message?.videoMessage?.caption) { text = msg.message.videoMessage.caption; type = 'video'; }
  else if (msg.message?.imageMessage) type = 'image';
  else if (msg.message?.videoMessage) type = 'video';
  else if (msg.message?.audioMessage) type = 'audio';
  else if (msg.message?.stickerMessage) type = 'sticker';

  // ★ View-once detection — download immediately so we can "unlock" it
  const isViewOnce = msg.message?.imageMessage?.viewOnce || msg.message?.videoMessage?.viewOnce ||
    msg.message?.viewOnceMessage?.message?.imageMessage || msg.message?.viewOnceMessage?.message?.videoMessage;

  if (isViewOnce && sock) {
    try {
      mediaBuffer = await downloadMediaMessage(msg, 'buffer', {}, sock);
      // Change type from 'image'/'video' to unlocked
      if (msg.message?.viewOnceMessage?.message?.imageMessage) type = 'image';
      else if (msg.message?.viewOnceMessage?.message?.videoMessage) type = 'video';
      console.log(`  🔓 [ANTIDELETE] Captured view-once ${type} for +${phone}`);
    } catch (e) {
      console.log(`  ⚠ [ANTIDELETE] Could not capture view-once media: ${e.message}`);
    }
  } else if ((type === 'image' || type === 'video' || type === 'audio' || type === 'sticker') && sock) {
    // Also download regular media so we can recover it if deleted
    try {
      mediaBuffer = await downloadMediaMessage(msg, 'buffer', {}, sock);
    } catch {}
  }

  store.set(id, { text, type, mediaBuffer, jid: msg.key.remoteJid, sender: msg.key.participant || msg.key.remoteJid, ts: Date.now(), isViewOnce: !!isViewOnce });
  // Clean up old messages (keep last 200)
  if (store.size > 200) {
    const oldest = [...store.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) store.delete(oldest[0]);
  }
}

function getMessage(id, phone) {
  if (!messageStore.has(phone)) return null;
  return messageStore.get(phone).get(id) || null;
}

// ─── Group admin check ──────────────────────────────────────────────
async function isGroupAdmin(sock, groupJid, userJid) {
  try {
    const metadata = await sock.groupMetadata(groupJid);
    const participant = metadata.participants.find(p => p.id === userJid);
    return participant?.admin === 'admin' || participant?.admin === 'superadmin';
  } catch { return false; }
}

// ─── Baileys (MULTI-USER) ──────────────────────────────────────────
// Each paired user gets their own auth folder + socket, all running in
// the same process. Anyone can pair → connect → use the bot.

async function startUserBot(phone, authFolder) {
  // If already running, skip
  if (userSessions.has(phone) && userSessions.get(phone).connected) {
    console.log(`[BOT ${phone}] Already running — skip`);
    return;
  }

  fs.mkdirSync(authFolder, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`[BOT ${phone}] Baileys v${version.join('.')}${isLatest ? ' (latest)' : ''}`);

  const userSock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false, logger: P({ level: "debug" }, P.destination({ sync: true })),
    browser: Browsers.appropriate('Chrome'),
    generateHighQualityLinkPreview: true,
    markOnlineOnConnect: false, syncFullHistory: false,
    shouldIgnoreJid: () => false,
    getMessage: async () => proto.Message.fromObject({})
  });

  const entry = { sock: userSock, authFolder, connected: false, userInfo: null };
  userSessions.set(phone, entry);

  userSock.ev.on('creds.update', saveCreds);

  userSock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'open') {
      entry.connected = true;
      entry.userInfo = { id: userSock.user.id, name: userSock.user.name || userSock.user.notifyName || phone };
      console.log(`\n  ✅ [BOT ${phone}] Connected as ${userSock.user.id}`);
      try {
        const userName = userSock.user.name || userSock.user.notifyName || phone;
        const pairedNumber = String(userSock.user.id).split(':')[0].split('@')[0];
        const time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        if (phone === CONFIG.ownerNumber) printConnected({ botName: getSetting('botName', CONFIG.botName), ownerName: userName, time });
        const banner = [
          '┏━━━━━━✧ CONNECTED ✧━━━━━━━',
          '┃✧ Bot: ' + getSetting('botName', CONFIG.botName),
          '┃✧ Prefix: [ ' + getSetting('prefix', CONFIG.prefix) + ' ]',
          '┃✧ User: ' + userName,
          '┃✧ Paired: +' + pairedNumber,
          '┃✧ Platform: 🖥️ MEGH HOSTING',
          '┃✧ Status: online',
          '┃✧ Time: ' + time,
          '┃✧ Repo: ' + CONFIG.repoUrl,
          '┃✧ Support: ' + CONFIG.supportUrl,
          '┗━━━━━━━━━━━━━━━━━━━━━━━━┛'
        ].join('\n');
        await userSock.sendMessage(userSock.user.id, { text: banner });
        console.log(`  ✓ [BOT ${phone}] Sent CONNECTED banner to +${pairedNumber}`);
      } catch (e) { console.log(`  ⚠ [BOT ${phone}] Banner failed: ${e.message}`); }
      console.log(`  🟢 [BOT ${phone}] Online. Listening for commands…\n`);
    }
    if (connection === 'close') {
      entry.connected = false;
      const sc = lastDisconnect?.error?.output?.statusCode;
      console.log(`  ⚠ [BOT ${phone}] Closed. Status: ${sc}`);
      if (sc === DisconnectReason.loggedOut) {
        console.log(`  ✗ [BOT ${phone}] Logged out — re-pair via site.`);
        userSessions.delete(phone);
        try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch {}
        return;
      }
      setTimeout(() => startUserBot(phone, authFolder), sc === 515 || sc === 410 ? 3000 : 5000);
    }
  });

  userSock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      // ★ Anti-delete: ALWAYS ON — store ALL messages (including own) so we can retrieve deleted ones
      try {
        await storeMessage(msg, phone, userSock);
      } catch (e) { console.log(`  ⚠ [STORE] Failed: ${e.message}`); }
      try { await handleAutoPresence(userSock, msg); await handleMessage(userSock, msg); await handleChatbot(userSock, msg); }
      catch(e) { console.error(`  ✗ [BOT ${phone}] Handler error: ${e.message}`); }
    }
  });

  // ★ Anti-delete: ALWAYS ON — when a message is deleted/viewed, retrieve + send to owner DM
  userSock.ev.on('messages.update', async (updates) => {
    for (const update of updates) {
      try {
        const isDeleted = update.update?.message === null || update.update?.deleted === true;
        const isViewOnceConsumed = update.update?.message && (
          update.update.message?.imageMessage?.viewOnce === false ||
          update.update.message?.videoMessage?.viewOnce === false
        );
        if ((isDeleted || isViewOnceConsumed) && update.key?.remoteJid) {
          // Message was deleted or view-once was consumed — retrieve from store
          const stored = getMessage(update.key.id, phone);
          if (stored) {
            const ownerJid = userSock.user?.id || (getSetting('ownerNumber', CONFIG.ownerNumber) + '@s.whatsapp.net');
            const senderNum = String(stored.sender || update.key.remoteJid).split('@')[0].split(':')[0];
            const pairedNum = String(userSock.user?.id || '').split(':')[0].split('@')[0];
            const isViewOnceMsg = stored.isViewOnce;
            const header = isViewOnceMsg || isViewOnceConsumed
              ? `🔓 *ANTI-DELETE — VIEW ONCE UNLOCKED*\n\n`
              : `🚫 *ANTI-DELETE*\n\n`;
            const delMsg = header +
              `*From:* ${senderNum}\n` +
              `*Sent to:* ${update.key.remoteJid.endsWith('@g.us') ? 'Group' : 'DM'}\n` +
              `*Paired:* +${pairedNum}\n` +
              `*Deleted at:* ${new Date().toLocaleTimeString()}\n` +
              (isViewOnceMsg || isViewOnceConsumed ? `*Type:* View-once ${stored.type} (unlocked 🔓)\n` : '') +
              `\n*Message:*\n${stored.text || '[media]'}\n\n` +
              `_Anti-delete is always on — deleted messages are recovered._`;
            // Forward the deleted message to the owner's DM
            // ★ For view-once: send WITHOUT viewOnce flag → "unlocked"
            if (stored.type === 'image' && stored.mediaBuffer) {
              await userSock.sendMessage(ownerJid, { image: stored.mediaBuffer, caption: delMsg });
            } else if (stored.type === 'video' && stored.mediaBuffer) {
              await userSock.sendMessage(ownerJid, { video: stored.mediaBuffer, caption: delMsg });
            } else if (stored.type === 'audio' && stored.mediaBuffer) {
              await userSock.sendMessage(ownerJid, { audio: stored.mediaBuffer, mimetype: 'audio/mpeg' });
              await userSock.sendMessage(ownerJid, { text: delMsg });
            } else if (stored.type === 'sticker' && stored.mediaBuffer) {
              await userSock.sendMessage(ownerJid, { sticker: stored.mediaBuffer });
              await userSock.sendMessage(ownerJid, { text: delMsg });
            } else {
              await userSock.sendMessage(ownerJid, { text: delMsg });
            }
            console.log(`  🔄 [BOT ${phone}] Anti-delete: recovered ${isViewOnceMsg || isViewOnceConsumed ? 'view-once ' : ''}${stored.type} from ${update.key.remoteJid}`);
          }
        }
      } catch (e) { console.error(`  ✗ Anti-delete error: ${e.message}`); }
    }
  });

  userSock.ev.on('call', async (calls) => { try{ await handleCall(userSock, calls); }catch{} });
  return userSock;
}

// ─── Built-in pairing (MULTI-USER) ─────────────────────────────────
// ★ KEY INSIGHT: Don't create a separate bot socket after pairing.
// Just keep the pairing socket alive and register the message handler
// on it. This avoids the race condition where creds aren't fully
// written to disk before the new socket tries to read them.

const pairingSessions = new Map();

async function startPairing(phone) {
  phone = normalizePhone(phone);
  if (!phone) throw new Error('Invalid phone number. Use digits only with country code (e.g. 254712345678).');

  if (userSessions.has(phone) && userSessions.get(phone).connected) {
    throw new Error('This number is already paired and connected. Use .menu in WhatsApp.');
  }

  const webId = 'web_' + crypto.randomBytes(8).toString('hex');
  const authFolder = path.join(CONFIG.dataDir, 'auth', phone);
  fs.mkdirSync(authFolder, { recursive: true });

  const entry = { phone, status: 'pending', code: null, sock: null, authFolder };
  pairingSessions.set(webId, entry);

  console.log(`[PAIR ${webId}] Starting pairing for +${phone}...`);

  // ★ Use built-in version (don't call fetchLatestBaileysVersion — it fetches
  //    from an external URL that may fail)
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  console.log(`[PAIR ${webId}] Auth state loaded, creating socket...`);
  const { version } = await fetchLatestBaileysVersion();
  console.log(`[PAIR ${webId}] Baileys version: ${version.join('.')}`);
  const pairSock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: P({ level: 'debug' }, P.destination({ sync: true })),
    browser: Browsers.appropriate('Chrome'),
    keepAliveIntervalMs: 30000,
    connectTimeoutMs: 30000,
    qrTimeout: 60000,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    linkPreview: false
  });
  entry.sock = pairSock;
  console.log(`[PAIR ${webId}] Socket created, registering handlers...`);
  pairSock.ev.on('creds.update', saveCreds);

  let botHandlersRegistered = false;

  // ★ Single connection.update handler that handles BOTH pairing + bot lifecycle
  pairSock.ev.on('connection.update', async (u) => {
    const { connection, qr, pairingCode, lastDisconnect } = u;
    console.log(`[PAIR ${webId}] conn: ${connection || 'event'} qr=${!!qr} pc=${!!pairingCode} code=${lastDisconnect?.error?.output?.statusCode}`);

    if (pairingCode) { entry.code = pairingCode; entry.status = 'code_sent'; }

    if (connection === 'open') {
      entry.status = 'linked';
      const jid = pairSock.user.id;
      const userName = pairSock.user.name || pairSock.user.notifyName || phone;
      const pairedNumber = String(jid).split(':')[0].split('@')[0];
      console.log(`[PAIR ${webId}] ✓ Linked for +${phone} (${jid})`);

      userSessions.set(phone, { sock: pairSock, authFolder, connected: true, userInfo: { id: jid, name: userName } });

      // Send owner messages
      try {
        await pairSock.sendMessage(jid, { text: 'Generation session.....' });
        await new Promise(r => setTimeout(r, 800));
        await pairSock.sendMessage(jid, { text: `🟢 Session Linked\n\n🟢 Use ${getSetting('prefix', CONFIG.prefix)}menu to see commands\n🟢 Support: ${CONFIG.supportUrl}` });
        await new Promise(r => setTimeout(r, 800));
        const time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        const banner = [
          '┏━━━━━━✧ CONNECTED ✧━━━━━━━',
          '┃✧ Bot: ' + getSetting('botName', CONFIG.botName),
          '┃✧ Prefix: [ ' + getSetting('prefix', CONFIG.prefix) + ' ]',
          '┃✧ User: ' + userName,
          '┃✧ Paired: +' + pairedNumber,
          '┃✧ Platform: 🖥️ MEGH HOSTING',
          '┃✧ Status: online',
          '┃✧ Time: ' + time,
          '┃✧ Repo: ' + CONFIG.repoUrl,
          '┃✧ Support: ' + CONFIG.supportUrl,
          '┗━━━━━━━━━━━━━━━━━━━━━━━━┛'
        ].join('\n');
        await pairSock.sendMessage(jid, { text: banner });
        console.log(`[PAIR ${webId}] ✓✓ Messages + CONNECTED banner sent`);
      } catch(e) { console.log(`[PAIR ${webId}] ⚠ Messages: ${e.message}`); }

      // Register handlers
      if (!botHandlersRegistered) {
        botHandlersRegistered = true;
        pairSock.ev.on('messages.upsert', async ({ messages }) => {
          for (const msg of messages) {
            try { await storeMessage(msg, phone, pairSock); } catch {}
            try { await handleAutoPresence(pairSock, msg); await handleMessage(pairSock, msg); await handleChatbot(pairSock, msg); }
            catch(e) { console.error(`  ✗ [BOT ${phone}] Handler error: ${e.message}`); }
          }
        });
        pairSock.ev.on('messages.update', async (updates) => {
          for (const update of updates) {
            try {
              const isDeleted = update.update?.message === null || update.update?.deleted === true;
              const isViewOnceConsumed = update.update?.message && (
                update.update.message?.imageMessage?.viewOnce === false ||
                update.update.message?.videoMessage?.viewOnce === false
              );
              if ((isDeleted || isViewOnceConsumed) && update.key?.remoteJid) {
                const stored = getMessage(update.key.id, phone);
                if (stored) {
                  const ownerJid = pairSock.user?.id;
                  const senderNum = String(stored.sender || update.key.remoteJid).split('@')[0].split(':')[0];
                  const isViewOnceMsg = stored.isViewOnce;
                  const header = isViewOnceMsg || isViewOnceConsumed ? '🔓 *ANTI-DELETE — VIEW ONCE UNLOCKED*\n\n' : '🚫 *ANTI-DELETE*\n\n';
                  const delMsg = header + `*From:* ${senderNum}\n*Deleted at:* ${new Date().toLocaleTimeString()}\n\n*Message:*\n${stored.text || '[media]'}\n\n_Anti-delete is always on._`;
                  if (stored.type === 'image' && stored.mediaBuffer) await pairSock.sendMessage(ownerJid, { image: stored.mediaBuffer, caption: delMsg });
                  else if (stored.type === 'video' && stored.mediaBuffer) await pairSock.sendMessage(ownerJid, { video: stored.mediaBuffer, caption: delMsg });
                  else if (stored.type === 'audio' && stored.mediaBuffer) { await pairSock.sendMessage(ownerJid, { audio: stored.mediaBuffer, mimetype: 'audio/mpeg' }); await pairSock.sendMessage(ownerJid, { text: delMsg }); }
                  else if (stored.type === 'sticker' && stored.mediaBuffer) { await pairSock.sendMessage(ownerJid, { sticker: stored.mediaBuffer }); await pairSock.sendMessage(ownerJid, { text: delMsg }); }
                  else await pairSock.sendMessage(ownerJid, { text: delMsg });
                  console.log(`  🔄 [BOT ${phone}] Anti-delete: recovered ${stored.type}`);
                }
              }
            } catch (e) { console.error(`  ✗ Anti-delete error: ${e.message}`); }
          }
        });
        pairSock.ev.on('call', async (calls) => { try{ await handleCall(pairSock, calls); }catch{} });
        console.log(`[PAIR ${webId}] ✓ Handlers registered — bot LIVE`);
      }
      console.log(`  🟢 [BOT ${phone}] Online.\n`);
    }

    if (connection === 'close') {
      const sc = lastDisconnect?.error?.output?.statusCode;
      console.log(`[PAIR ${webId}] ❌ Closed code=${sc} status=${entry.status}`);
      if (entry.status === 'linked') {
        if (userSessions.has(phone)) userSessions.get(phone).connected = false;
        setTimeout(() => startUserBot(phone, authFolder).catch(()=>{}), sc === 515 || sc === 410 ? 3000 : 5000);
        return;
      }
      if (sc === DisconnectReason.loggedOut || sc === 410) { entry.status = 'failed'; return; }
      // Reconnect for pairing
      setTimeout(async () => {
        try {
          const { state: s2, saveCreds: sc2 } = await useMultiFileAuthState(authFolder);
          const { version: rv } = await fetchLatestBaileysVersion();
          const s = makeWASocket({ version: rv, auth: s2, printQRInTerminal: false, logger: P({ level: "debug" }, P.destination({ sync: true })), browser: Browsers.appropriate('Chrome'), keepAliveIntervalMs: 30000, markOnlineOnConnect: false, syncFullHistory: false, linkPreview: false });
          entry.sock = s;
          s.ev.on('creds.update', sc2);
          // Re-register the same handler on the new socket
          s.ev.on('connection.update', async (u2) => {
            const { connection: c2, pairingCode: pc2, lastDisconnect: ld2 } = u2;
            console.log(`[PAIR ${webId}] reconnect conn: ${c2} pc=${!!pc2} code=${ld2?.error?.output?.statusCode}`);
            if (pc2) { entry.code = pc2; entry.status = 'code_sent'; }
            if (c2 === 'open') {
              entry.status = 'linked';
              const jid = s.user.id;
              const userName = s.user.name || s.user.notifyName || phone;
              const pairedNumber = String(jid).split(':')[0].split('@')[0];
              console.log(`[PAIR ${webId}] ✓ Linked (reconnect) for +${phone}!`);
              userSessions.set(phone, { sock: s, authFolder, connected: true, userInfo: { id: jid, name: userName } });
              s.sendMessage(jid, { text: `🟢 Session Linked\n\n🟢 Use ${getSetting('prefix', CONFIG.prefix)}menu` }).catch(()=>{});
              const time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
              const banner = ['┏━━━━━━✧ CONNECTED ✧━━━━━━━','┃✧ Bot: ' + getSetting('botName', CONFIG.botName),'┃✧ Prefix: [ ' + getSetting('prefix', CONFIG.prefix) + ' ]','┃✧ User: ' + userName,'┃✧ Paired: +' + pairedNumber,'┃✧ Platform: 🖥️ MEGH HOSTING','┃✧ Status: online','┃✧ Time: ' + time,'┃✧ Repo: ' + CONFIG.repoUrl,'┃✧ Support: ' + CONFIG.supportUrl,'┗━━━━━━━━━━━━━━━━━━━━━━━━┛'].join('\n');
              s.sendMessage(jid, { text: banner }).catch(()=>{});
              s.ev.on('messages.upsert', async ({ messages }) => {
                for (const msg of messages) {
                  try { await storeMessage(msg, phone, s); } catch {}
                  try { await handleAutoPresence(s, msg); await handleMessage(s, msg); await handleChatbot(s, msg); }
                  catch(e) { console.error(`  ✗ [BOT ${phone}] Handler error: ${e.message}`); }
                }
              });
              s.ev.on('messages.update', async (updates) => {
                for (const update of updates) {
                  try {
                    if (update.update?.message === null && update.key?.remoteJid) {
                      const stored = getMessage(update.key.id, phone);
                      if (stored) {
                        const ownerJid = s.user?.id;
                        const delMsg = `🚫 *ANTI-DELETE*\n\n*From:* ${String(stored.sender || update.key.remoteJid).split('@')[0]}\n*Deleted at:* ${new Date().toLocaleTimeString()}\n\n*Message:*\n${stored.text || '[media]'}\n\n_Anti-delete is always on._`;
                        if (stored.type === 'image' && stored.mediaBuffer) await s.sendMessage(ownerJid, { image: stored.mediaBuffer, caption: delMsg });
                        else if (stored.type === 'video' && stored.mediaBuffer) await s.sendMessage(ownerJid, { video: stored.mediaBuffer, caption: delMsg });
                        else await s.sendMessage(ownerJid, { text: delMsg });
                      }
                    }
                  } catch (e) { console.error(`  ✗ Anti-delete error: ${e.message}`); }
                }
              });
              s.ev.on('call', async (calls) => { try{ await handleCall(s, calls); }catch{} });
              console.log(`  🟢 [BOT ${phone}] Online (reconnect).\n`);
            }
            if (c2 === 'close') {
              const sc2 = ld2?.error?.output?.statusCode;
              if (entry.status === 'linked') {
                if (userSessions.has(phone)) userSessions.get(phone).connected = false;
                setTimeout(() => startUserBot(phone, authFolder).catch(()=>{}), sc2 === 515 || sc2 === 410 ? 3000 : 5000);
              }
            }
          });
        } catch(e) { console.error(`[PAIR ${webId}] Reconnect failed: ${e.message}`); }
      }, 3000);
    }
  });

  // ★ Wait for the socket to be ready (QR or connecting event)
  //    DON'T reject on close — the reconnect handler will create a new socket
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Socket timeout. Retry in 30s.')), 60000);
    const handler = (u) => {
      if (u.qr) { clearTimeout(timeout); pairSock.ev.off('connection.update', handler); console.log(`[PAIR ${webId}] ✓ QR event — socket ready`); resolve(); }
      else if (u.connection === 'open') { clearTimeout(timeout); pairSock.ev.off('connection.update', handler); console.log(`[PAIR ${webId}] ✓ Open event — already connected`); resolve(); }
      else if (u.connection === 'close') {
        const sc = u.lastDisconnect?.error?.output?.statusCode;
        console.log(`[PAIR ${webId}] Socket closed (${sc}) — waiting for reconnect...`);
        if (sc === DisconnectReason.loggedOut || sc === 410) {
          clearTimeout(timeout); pairSock.ev.off('connection.update', handler);
          reject(new Error('WhatsApp rejected. Try a different number.'));
        }
        // Don't reject — reconnect handler will create new socket
      }
    };
    pairSock.ev.on('connection.update', handler);
  });

  // Use the active socket (may have been replaced by reconnect handler)
  const activeSock = entry.sock || pairSock;
  const code = await activeSock.requestPairingCode(phone);
  entry.code = code;
  entry.status = 'code_sent';
  console.log(`[PAIR ${webId}] ✓ Pairing code: ${code} for +${phone}`);
  return { webId, code: code.length === 8 ? code.slice(0,4) + '-' + code.slice(4) : code, rawCode: code, phone };
}

// ─── Express + premium UI ──────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true, connectedUsers: userSessions.size, users: [...userSessions.keys()], ts: Date.now() }));

app.post('/api/pair', async (req, res) => {
  try {
    const phone = req.body?.phoneNumber || req.body?.phone;
    const result = await startPairing(phone);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/status/:webId', (req, res) => {
  const e = pairingSessions.get(req.params.webId);
  if (!e) return res.status(404).json({ ok: false, error: 'Session not found' });
  res.json({ ok: true, status: e.status, phone: e.phone, code: e.code ? (e.code.length === 8 ? e.code.slice(0,4)+'-'+e.code.slice(4) : e.code) : null });
});

app.get('/', (req, res) => res.send(PAIRING_HTML));
app.get('*', (req, res) => res.send(PAIRING_HTML));

// ─── Premium pairing UI (embedded) ─────────────────────────────────
const PAIRING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MEGH X-MINI — Pair</title>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&family=Inter:wght@400;600;700;800&family=JetBrains+Mono:wght@700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a14;--cyan:#00e5ff;--violet:#a855f7;--txt:#e2e8f0;--muted:#94a3b8}
body{font-family:Inter,sans-serif;background:var(--bg);color:var(--txt);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;overflow-x:hidden}
.bg{position:fixed;inset:0;z-index:0;background:radial-gradient(circle at 20% 20%,rgba(168,85,247,.2),transparent 50%),radial-gradient(circle at 80% 80%,rgba(0,229,255,.18),transparent 50%),var(--bg)}
.card{position:relative;z-index:1;max-width:440px;width:100%;background:rgba(20,20,42,.85);backdrop-filter:blur(18px);border:1px solid rgba(168,85,247,.35);border-radius:20px;padding:32px 28px;box-shadow:0 25px 80px -20px rgba(0,0,0,.7),0 0 60px -15px rgba(168,85,247,.4)}
.brand{text-align:center;margin-bottom:24px}
.brand h1{font-family:Orbitron;font-weight:900;font-size:32px;letter-spacing:6px;background:linear-gradient(135deg,var(--cyan),var(--violet));-webkit-background-clip:text;background-clip:text;color:transparent;filter:drop-shadow(0 0 20px rgba(0,229,255,.3))}
.brand p{font-size:11px;letter-spacing:6px;text-transform:uppercase;color:var(--cyan);margin-top:4px}
label{display:block;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:600;margin-bottom:8px}
input{width:100%;padding:14px 16px;border-radius:12px;background:rgba(10,10,20,.6);border:1px solid rgba(168,85,247,.25);color:#fff;font-size:16px;font-family:inherit;transition:.2s}
input:focus{outline:none;border-color:var(--cyan);box-shadow:0 0 0 3px rgba(0,229,255,.18),0 0 20px rgba(0,229,255,.3)}
input::placeholder{color:rgba(148,163,184,.5)}
.btn{display:block;width:100%;padding:14px;border-radius:12px;border:none;cursor:pointer;font-family:inherit;font-weight:700;font-size:13px;letter-spacing:.06em;text-transform:uppercase;background:linear-gradient(135deg,var(--cyan),var(--violet));color:#0a0a14;box-shadow:0 8px 24px -8px rgba(168,85,247,.6);transition:.2s;margin-top:14px}
.btn:hover{filter:brightness(1.15);transform:translateY(-1px)}
.btn:disabled{opacity:.4;cursor:not-allowed}
.hint{font-size:12px;color:var(--muted);text-align:center;margin-top:14px;line-height:1.6}
.hint strong{color:var(--cyan)}
.code-box{display:none;margin-top:20px;padding:24px;border-radius:14px;background:rgba(10,10,20,.6);border:1px dashed rgba(168,85,247,.4);text-align:center}
.code-box.show{display:block;animation:slide .4s}
@keyframes slide{from{opacity:0;transform:translateY(8px)}to{opacity:1}}
.code-label{font-size:10px;letter-spacing:6px;text-transform:uppercase;color:var(--cyan);font-weight:700;margin-bottom:8px}
.code-val{font-family:JetBrains Mono,monospace;font-size:36px;font-weight:800;letter-spacing:.12em;background:linear-gradient(135deg,var(--cyan),var(--violet));-webkit-background-clip:text;background-clip:text;color:transparent}
.status{display:inline-flex;align-items:center;gap:8px;padding:8px 18px;border-radius:99px;font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;background:rgba(168,85,247,.18);border:1px solid rgba(168,85,247,.35);color:var(--cyan);margin-top:16px}
.status .dot{width:8px;height:8px;border-radius:50%;background:currentColor;box-shadow:0 0 12px currentColor;animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.8)}}
.footer{text-align:center;margin-top:20px;font-size:10px;letter-spacing:3px;text-transform:uppercase;color:var(--muted)}
.footer strong{color:var(--cyan)}
</style>
</head>
<body>
<div class="bg"></div>
<div class="card">
  <div class="brand"><h1>MEGH</h1><p>X-MINI Pairing</p></div>
  <div id="phoneStep">
    <label>Phone Number (with country code)</label>
    <input id="phone" type="tel" placeholder="254712345678" inputmode="numeric" autocomplete="off">
    <button class="btn" id="pairBtn">Get Pairing Code</button>
    <p class="hint">Enter your WhatsApp number with country code (no +, no spaces). We'll generate a pairing code — enter it in WhatsApp → Linked Devices → "Link with phone number instead".<br><br>Once linked, the bot sends a <strong>CONNECTED</strong> message to your WhatsApp instantly.</p>
  </div>
  <div id="codeStep" style="display:none">
    <div class="status"><span class="dot"></span><span id="statusText">Waiting for WhatsApp link…</span></div>
    <div class="code-box show" onclick="navigator.clipboard&&navigator.clipboard.writeText(document.getElementById('codeVal').textContent)">
      <div class="code-label">✦ Pairing Code ✦</div>
      <div class="code-val" id="codeVal">····-····</div>
    </div>
    <p class="hint"><strong>1.</strong> Open WhatsApp → Settings → Linked Devices → Link a Device<br><strong>2.</strong> Tap "Link with phone number instead"<br><strong>3.</strong> Enter the code above<br><strong>4.</strong> Bot connects + sends CONNECTED message</p>
    <button class="btn" id="resetBtn" style="background:transparent;border:1px solid rgba(168,85,247,.35);color:var(--cyan);margin-top:14px">Pair Another</button>
  </div>
  <div class="footer">Powered by <strong>MEGH</strong> X-MINI</div>
</div>
<script>
const $=id=>document.getElementById(id);
let pollTimer=null;
async function startPair(){
  const phone=$('phone').value.trim();
  if(!phone||phone.length<8){alert('Enter a valid phone number');return;}
  $('pairBtn').disabled=true;
  try{
    const r=await fetch('/api/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phoneNumber:phone})});
    const d=await r.json();
    if(!r.ok) throw new Error(d.error||'Failed');
    $('phoneStep').style.display='none';
    $('codeStep').style.display='block';
    $('codeVal').textContent=d.code;
    pollStatus(d.webId);
  }catch(e){alert(e.message);$('pairBtn').disabled=false;}
}
function pollStatus(webId){
  pollTimer=setInterval(async()=>{
    try{
      const r=await fetch('/api/status/'+webId);
      const d=await r.json();
      if(d.status==='linked'){$('statusText').textContent='Linked! Bot is starting…';setTimeout(()=>{clearInterval(pollTimer);$('statusText').textContent='✅ Bot connected — check your WhatsApp!';},2000);}
      else if(d.status==='code_sent'){$('statusText').textContent='Waiting for WhatsApp link…';}
    }catch{}
  },3000);
}
$('pairBtn').addEventListener('click',startPair);
$('phone').addEventListener('keydown',e=>{if(e.key==='Enter')startPair();});
$('resetBtn').addEventListener('click',()=>location.reload());
</script>
</body>
</html>`;

// ─── BOOT ──────────────────────────────────────────────────────────
printBanner();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ╔══════════════════════════════════════════════╗`);
  console.log(`  ║   MEGH X-MINI — Pairing + Bot on :${PORT}`.padEnd(48) + `║`);
  console.log(`  ╚══════════════════════════════════════════════╝\n`);
  console.log(`  🌐 Pairing site:  http://0.0.0.0:${PORT}`);
  console.log(`  📲 Pair endpoint: POST /api/pair`);
  console.log(`  💾 SQLite:        data/bot.db\n`);
});

// ─── On boot: reconnect any previously-paired users ──────────────
// Scan data/auth/ for existing auth folders (one per phone number)
// and start a bot for each. This survives Render restarts.
function reconnectAllUsers() {
  const authRoot = path.join(CONFIG.dataDir, 'auth');
  if (!fs.existsSync(authRoot)) return;
  const phones = fs.readdirSync(authRoot).filter(d => {
    const p = path.join(authRoot, d);
    return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'creds.json'));
  });
  if (!phones.length) return;
  console.log(`  ℹ Found ${phones.length} existing session(s) — reconnecting…`);
  for (const phone of phones) {
    const authFolder = path.join(authRoot, phone);
    setTimeout(() => startUserBot(phone, authFolder).catch(e => console.error(`  ✗ [BOT ${phone}] Reconnect failed: ${e.message}`)), 1000);
  }
}

// Download menu image in background
downloadMenuImage().catch(() => {});

// Reconnect any existing sessions (survives Render restarts)
reconnectAllUsers();

console.log('  ℹ Bot is ready. Visit the pairing site to pair a new number.\n');

process.on('SIGTERM', () => { console.log('\n  ⊘ SIGTERM — shutting down'); process.exit(0); });
process.on('SIGINT', () => { console.log('\n  ⊘ SIGINT — shutting down'); process.exit(0); });
