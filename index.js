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

// ─── createFakeContact ─────────────────────────────────────────────
function createFakeContact(msg) {
  const botName = getSetting('botName', CONFIG.botName);
  const participantId = (msg && (msg.key.participant || msg.key.remoteJid)) || '0';
  const cleanId = String(participantId).split(':')[0].split('@')[0] || '0';
  return {
    key: { participants: '0@s.whatsapp.net', remoteJid: '0@s.whatsapp.net', fromMe: false, id: 'MEGHXMINI' + Math.random().toString(36).substring(2,12).toUpperCase() },
    message: { contactMessage: { displayName: botName, vcard: `BEGIN:VCARD\nVERSION:3.0\nN:Sy;Bot;;;\nFN:${botName}\nitem1.TEL;waid=${cleanId}:${cleanId}\nitem1.X-ABLabel:Phone\nEND:VCARD` } },
    participant: '0@s.whatsapp.net'
  };
}

// ─── Owner check ───────────────────────────────────────────────────
function isOwner(jid) {
  const num = String(jid).split(':')[0].split('@')[0];
  if (num === getSetting('ownerNumber', CONFIG.ownerNumber)) return true;
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
function fmtUptime(ms) { const s=Math.floor(ms/1000); const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60); const p=[]; if(d)p.push(d+'d'); if(h)p.push(h+'h'); if(m)p.push(m+'m'); p.push((s%60)+'s'); return p.join(' '); }
function phoneToJid(phone) { let p=String(phone).replace(/\D/g,''); if(p.startsWith('00'))p=p.slice(2); return p+'@s.whatsapp.net'; }
function normalizePhone(input) { if(!input) return null; let p=String(input).replace(/[^\d]/g,''); if(!p) return null; if(p.length>10&&p.startsWith('0'))p=p.slice(1); if(!/^\d{8,15}$/.test(p)) return null; return p; }
async function reply(sock, msg, text, opts={}) { return sock.sendMessage(msg.key.remoteJid, { text, ...opts }, { quoted: createFakeContact(msg) }); }
async function replyImage(sock, msg, img, cap, opts={}) { return sock.sendMessage(msg.key.remoteJid, { image: img, caption: cap, ...opts }, { quoted: createFakeContact(msg) }); }

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
  main: ['menu','all','ping','repo','alive','pair','owner','runtime'],
  ai: ['ai','gpt','gemini','blackbox','deepseek','llama','translate','story','joke','quote','fact','dare','truth'],
  group: ['kick','promote','demote','tagall','hidetag','invite','close','open','tosgroup','setname'],
  admin: ['setprefix','setbotname','setownername','setprofilepic','setmenuimage','setstatus','mode'],
  anti: ['antidelete','antilink','antibadword','anticall','antibot','antispam','autoread','autotyping','autorecording','chatbot'],
  media: ['sticker','vv','getdp','song','tls','qr'],
  fun: ['8ball','coinflip','dice','rps','ship'],
  info: ['whoami','botinfo','profile'],
};
const CAT_EMOJI = { main:'🤖', ai:'🧠', group:'👥', admin:'⚙️', anti:'🛡️', media:'🎬', fun:'🎮', info:'ℹ️' };
const CAT_NAME = { main:'MAIN', ai:'AI', group:'GROUP', admin:'ADMIN', anti:'ANTI', media:'MEDIA', fun:'FUN', info:'INFO' };

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
  return `┏▣ ◈ *${CONFIG.botName.replace(/\s+/g,'_').toUpperCase()}* ◈
┃ *ᴏᴡɴᴇʀ* : ${ownerName}
┃ *ᴘʀᴇғɪx* : [ ${prefix} ]
┃ *ʜᴏsᴛ* : Render
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
  for (let i = 0; i < cats.length; i += 2) {
    const left = cats[i], right = cats[i+1];
    const lc = COMMAND_LIST[left], rc = right ? COMMAND_LIST[right] : [];
    const maxRows = Math.max(lc.length, rc.length);
    out += `${CAT_EMOJI[left]} *${smallCaps(CAT_NAME[left])} MENU*`.padEnd(28) + ` ${right ? `${CAT_EMOJI[right]} *${smallCaps(CAT_NAME[right])} MENU*` : ''}\n`;
    for (let j = 0; j < maxRows; j++) {
      const l = lc[j] ? `│✦ ${smallCaps(lc[j])}` : '';
      const r = rc[j] ? `│✦ ${smallCaps(rc[j])}` : '';
      out += `${l.padEnd(28)} ${r}\n`;
    }
    out += '\n';
  }
  out += `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n_Type *${prefix}menu* for main menu_`;
  return out;
}

// ─── Commands ──────────────────────────────────────────────────────
const COMMANDS = {};
function cmd(name, aliases, desc, handler) {
  COMMANDS[name.toLowerCase()] = { name, aliases, desc, handler };
  if (aliases) for (const a of aliases) COMMANDS[a.toLowerCase()] = { name, aliases, desc, handler };
}

cmd('menu', ['help'], 'Main menu', async (sock, msg) => {
  const text = buildMainMenu();
  const img = getMenuImage();
  if (img) await replyImage(sock, msg, img, text); else await reply(sock, msg, text);
});
cmd('all', ['menuall'], 'All commands', async (sock, msg) => { await reply(sock, msg, buildFullMenu()); });
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
  try { let b; if(msg.message.imageMessage) b=await sock.downloadMediaMessage(msg); else b=await sock.downloadMediaMessage({key:msg.key,message:q}); await sock.updateProfilePicture(sock.user.id,b); await reply(sock,msg,'✅ Profile pic updated!'); }
  catch(e){await reply(sock,msg,'❌ '+e.message);}
});
cmd('setmenuimage', ['menuimage'], 'Set menu image (reply to photo)', async (sock, msg) => {
  const q = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage; const hi = msg.message?.imageMessage || q?.imageMessage;
  if(!hi){await reply(sock,msg,'❌ Reply to a photo');return;}
  try { let b; if(msg.message.imageMessage) b=await sock.downloadMediaMessage(msg); else b=await sock.downloadMediaMessage({key:msg.key,message:q}); fs.writeFileSync(path.join(CONFIG.dataDir,'menu-image.png'),b); await reply(sock,msg,`✅ Menu image updated! (${(b.length/1024).toFixed(0)} KB)`); }
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
cmd('kick', ['remove'], 'Kick from group', async (sock, msg, args) => {
  if(!msg.key.remoteJid.endsWith('@g.us')){await reply(sock,msg,'❌ Groups only');return;}
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid||[];
  let targets=[];
  if(args[0]==='all'){try{const md=await sock.groupMetadata(msg.key.remoteJid);targets=md.participants.map(p=>p.id).filter(id=>!isOwner(id)&&id!==sock.user.id);}catch(e){await reply(sock,msg,'❌ '+e.message);return;}}
  else if(mentioned.length) targets=mentioned.filter(id=>!isOwner(id));
  else if(args[0]) targets=[phoneToJid(args[0])].filter(id=>!isOwner(id));
  else{await reply(sock,msg,'❌ Usage: kick all|@user|number');return;}
  if(!targets.length){await reply(sock,msg,'❌ No valid targets');return;}
  try{await sock.groupParticipantsUpdate(msg.key.remoteJid,targets,'remove');await reply(sock,msg,`✅ Kicked ${targets.length} member(s)`);}catch(e){await reply(sock,msg,'❌ '+e.message);}
});
cmd('promote', [], 'Promote', async (sock, msg, args) => {
  if(!msg.key.remoteJid.endsWith('@g.us')){await reply(sock,msg,'❌ Groups only');return;}
  const m=msg.message?.extendedTextMessage?.contextInfo?.mentionedJid||[]; if(!m.length&&args[0])m.push(phoneToJid(args[0])); if(!m.length){await reply(sock,msg,'❌ Usage: promote @user');return;}
  try{await sock.groupParticipantsUpdate(msg.key.remoteJid,m,'promote');await reply(sock,msg,`✅ Promoted ${m.length} user(s)`);}catch(e){await reply(sock,msg,'❌ '+e.message);}
});
cmd('demote', [], 'Demote', async (sock, msg, args) => {
  if(!msg.key.remoteJid.endsWith('@g.us')){await reply(sock,msg,'❌ Groups only');return;}
  const m=msg.message?.extendedTextMessage?.contextInfo?.mentionedJid||[]; if(!m.length&&args[0])m.push(phoneToJid(args[0])); if(!m.length){await reply(sock,msg,'❌ Usage: demote @user');return;}
  try{await sock.groupParticipantsUpdate(msg.key.remoteJid,m,'demote');await reply(sock,msg,`✅ Demoted ${m.length} user(s)`);}catch(e){await reply(sock,msg,'❌ '+e.message);}
});
cmd('tagall', ['hidetag'], 'Tag all', async (sock, msg, args) => {
  if(!msg.key.remoteJid.endsWith('@g.us')){await reply(sock,msg,'❌ Groups only');return;}
  try{const md=await sock.groupMetadata(msg.key.remoteJid);const mentions=md.participants.map(p=>p.id);const text=args.join(' ')||'┏━━━━━✧ *TAG ALL* ✧━━━━━\n';await sock.sendMessage(msg.key.remoteJid,{text,mentions},{quoted:createFakeContact(msg)});}catch(e){await reply(sock,msg,'❌ '+e.message);}
});
cmd('tosgroup', ['groupstatus'], 'Set group status (reply to msg)', async (sock, msg) => {
  if(!msg.key.remoteJid.endsWith('@g.us')){await reply(sock,msg,'❌ Groups only');return;}
  const q=msg.message?.extendedTextMessage?.contextInfo?.quotedMessage; if(!q){await reply(sock,msg,'❌ Reply to a text/media to set as group status');return;}
  let t=''; if(q.conversation)t=q.conversation; else if(q.extendedTextMessage?.text)t=q.extendedTextMessage.text; else if(q.imageMessage?.caption)t=q.imageMessage.caption; else if(q.videoMessage?.caption)t=q.videoMessage.caption;
  if(!t){await reply(sock,msg,'❌ Could not extract text');return;}
  try{await sock.groupUpdateDescription(msg.key.remoteJid,t);await reply(sock,msg,'✅ Group status updated!');}catch(e){await reply(sock,msg,'❌ '+e.message);}
});
cmd('close', ['lockgroup'], 'Close group', async (sock, msg) => { if(!msg.key.remoteJid.endsWith('@g.us')){await reply(sock,msg,'❌ Groups only');return;} try{await sock.groupSettingUpdate(msg.key.remoteJid,'announcement');await reply(sock,msg,'✅ Group closed — admin only');}catch(e){await reply(sock,msg,'❌ '+e.message);} });
cmd('open', ['opengroup'], 'Open group', async (sock, msg) => { if(!msg.key.remoteJid.endsWith('@g.us')){await reply(sock,msg,'❌ Groups only');return;} try{await sock.groupSettingUpdate(msg.key.remoteJid,'not_announcement');await reply(sock,msg,'✅ Group opened — everyone');}catch(e){await reply(sock,msg,'❌ '+e.message);} });
cmd('setname', ['groupname'], 'Set group name', async (sock, msg, args) => { if(!msg.key.remoteJid.endsWith('@g.us')){await reply(sock,msg,'❌ Groups only');return;} const n=args.join(' '); if(!n){await reply(sock,msg,'❌ Usage: setname <name>');return;} try{await sock.groupUpdateSubject(msg.key.remoteJid,n);await reply(sock,msg,`✅ Name: ${n}`);}catch(e){await reply(sock,msg,'❌ '+e.message);} });

// Media
cmd('sticker', ['s'], 'Make sticker', async (sock, msg) => {
  const q=msg.message?.extendedTextMessage?.contextInfo?.quotedMessage; const hi=msg.message?.imageMessage||q?.imageMessage; if(!hi){await reply(sock,msg,'❌ Reply to an image');return;}
  try{let b; if(msg.message.imageMessage)b=await sock.downloadMediaMessage(msg); else b=await sock.downloadMediaMessage({key:msg.key,message:q}); await sock.sendMessage(msg.key.remoteJid,{sticker:b,pack:CONFIG.botName,author:getSetting('ownerName',CONFIG.ownerName)},{quoted:createFakeContact(msg)});}catch(e){await reply(sock,msg,'❌ '+e.message);}
});
cmd('vv', ['tovv','viewonce'], 'To view-once', async (sock, msg) => {
  const q=msg.message?.extendedTextMessage?.contextInfo?.quotedMessage; const hi=msg.message?.imageMessage||q?.imageMessage; if(!hi){await reply(sock,msg,'❌ Reply to an image');return;}
  try{let b; if(msg.message.imageMessage)b=await sock.downloadMediaMessage(msg); else b=await sock.downloadMediaMessage({key:msg.key,message:q}); await sock.sendMessage(msg.key.remoteJid,{image:b,viewOnce:true},{quoted:createFakeContact(msg)});}catch(e){await reply(sock,msg,'❌ '+e.message);}
});
cmd('getdp', ['pp','profilepic'], 'Get profile pic', async (sock, msg, args) => {
  let jid; if(msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length) jid=msg.message.extendedTextMessage.contextInfo.mentionedJid[0]; else if(args[0]) jid=phoneToJid(args[0]); else jid=msg.key.participant||msg.key.remoteJid;
  try{const url=await sock.profilePictureUrl(jid,'image');const res=await fetch(url);const b=Buffer.from(await res.arrayBuffer());await replyImage(sock,msg,b,`📸 @${String(jid).split('@')[0]}`,{mentions:[jid]});}catch(e){await reply(sock,msg,'❌ Could not fetch DP (hidden).');}
});
cmd('qr', ['qrcode'], 'Generate QR', async (sock, msg, args) => { const t=args.join(' '); if(!t){await reply(sock,msg,'❌ Usage: qr <text>');return;} try{const u=`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(t)}`;const r=await fetch(u);const b=Buffer.from(await r.arrayBuffer());await replyImage(sock,msg,b,`QR: ${t}`);}catch(e){await reply(sock,msg,'❌ '+e.message);} });
cmd('song', ['play'], 'Search song', async (sock, msg, args) => { const q=args.join(' '); if(!q){await reply(sock,msg,'❌ Usage: song <name>');return;} await reply(sock,msg,`🔍 "${q}"\n\nhttps://www.youtube.com/results?search_query=${encodeURIComponent(q)}`); });
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
  // ★ Bot is for everyone — no owner-only gate by default.
  // Owner check is only used for sensitive commands (kick, mode change, etc.)
  // but regular commands work for ANYONE who messages the bot.
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

// ─── Baileys ───────────────────────────────────────────────────────
let sock = null;
let botConnected = false;

async function startBaileys() {
  const { state, saveCreds } = await useMultiFileAuthState(CONFIG.authDir);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log('  ℹ Baileys v' + version.join('.') + (isLatest ? ' (latest)' : ''));

  sock = makeWASocket({
    version, auth: state,
    printQRInTerminal: false, logger,
    browser: CONFIG.browser,
    generateHighQualityLinkPreview: true,
    markOnlineOnConnect: false, syncFullHistory: false,
    shouldIgnoreJid: () => false,
    getMessage: async () => proto.Message.fromObject({})
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'open') {
      botConnected = true;
      console.log('\n  ✅ WhatsApp connected as', sock.user?.id);
      try {
        const userName = sock.user?.name || sock.user?.notifyName || getSetting('ownerName', CONFIG.ownerName);
        const time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        printConnected({ botName: getSetting('botName', CONFIG.botName), ownerName: userName, time });
        const banner = [
          '┏━━━━━━✧ CONNECTED ✧━━━━━━━',
          '┃✧ Bot: ' + getSetting('botName', CONFIG.botName),
          '┃✧ Prefix: [ ' + getSetting('prefix', CONFIG.prefix) + ' ]',
          '┃✧ Owner: ' + userName,
          '┃✧ Platform: 🖥️ Render',
          '┃✧ Status: online',
          '┃✧ Time: ' + time,
          '┃✧ Repo: ' + CONFIG.repoUrl,
          '┗━━━━━━━━━━━━━━━━━━━━━━━━┛'
        ].join('\n');
        await sock.sendMessage(sock.user.id, { text: banner });
        console.log('  ✓ Sent CONNECTED banner to user WhatsApp');
      } catch (e) { console.log('  ⚠ Banner failed:', e.message); }
      console.log('  🟢 Bot online. Listening for commands…\n');
    }
    if (connection === 'close') {
      botConnected = false;
      const sc = lastDisconnect?.error?.output?.statusCode;
      console.log('  ⚠ Closed. Status:', sc);
      if (sc === DisconnectReason.loggedOut) { console.log('  ✗ Logged out. Re-pair via the site.'); return; }
      setTimeout(() => startBaileys(), sc === 515 || sc === 410 ? 3000 : 5000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      try { await handleAutoPresence(sock, msg); await handleMessage(sock, msg); await handleChatbot(sock, msg); }
      catch(e) { console.error('  ✗ Handler error:', e.message); }
    }
  });
  sock.ev.on('call', async (calls) => { try{ await handleCall(sock, calls); }catch{} });
  return sock;
}

// ─── Built-in pairing ──────────────────────────────────────────────
const pairingSessions = new Map();

async function startPairing(phone) {
  phone = normalizePhone(phone);
  if (!phone) throw new Error('Invalid phone number');
  const webId = 'web_' + crypto.randomBytes(8).toString('hex');
  const sessionFolder = path.join(CONFIG.dataDir, 'pairing_tmp', webId);
  fs.mkdirSync(sessionFolder, { recursive: true });

  const entry = { phone, status: 'pending', code: null, sock: null, authFolder: sessionFolder };
  pairingSessions.set(webId, entry);

  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
  const { version } = await fetchLatestBaileysVersion();
  const pairSock = makeWASocket({
    version, auth: state, printQRInTerminal: false, logger,
    browser: CONFIG.browser, qrTimeout: 120000, keepAliveIntervalMs: 30000,
    markOnlineOnConnect: false, syncFullHistory: false, linkPreview: false
  });
  entry.sock = pairSock;

  pairSock.ev.on('creds.update', saveCreds);
  pairSock.ev.on('connection.update', async (u) => {
    const { connection, qr, pairingCode } = u;
    if (pairingCode) { entry.code = pairingCode; entry.status = 'code_sent'; }
    if (connection === 'open') {
      // ★ Pair success — copy creds to the main auth folder, then start the bot
      entry.status = 'linked';
      console.log(`[PAIR ${webId}] ✓ Linked! Copying creds to main auth folder…`);
      // Copy all files from sessionFolder to CONFIG.authDir
      for (const f of fs.readdirSync(sessionFolder)) {
        fs.copyFileSync(path.join(sessionFolder, f), path.join(CONFIG.authDir, f));
      }
      // Send the 3 owner messages
      try {
        const jid = pairSock.user.id;
        const sessionId = 'megh-ultra:~' + webId + '~' + Buffer.from(JSON.stringify({creds: state.creds, keys: {}})).toString('base64url');
        await pairSock.sendMessage(jid, { text: 'Generation session.....' });
        await new Promise(r => setTimeout(r, 800));
        await pairSock.sendMessage(jid, { text: sessionId });
        await new Promise(r => setTimeout(r, 800));
        await pairSock.sendMessage(jid, { text: `🟢 Session Linked\n\n🟢 Bot is starting…\n🟢 Support: ${CONFIG.supportUrl}` });
        console.log(`[PAIR ${webId}] ✓ 3 owner messages sent`);
      } catch(e) { console.log(`[PAIR ${webId}] ⚠ Owner messages: ${e.message}`); }
      // Logout the pairing socket
      try { await pairSock.logout(); } catch{}
      // Start the main bot
      console.log(`[PAIR ${webId}] → Starting main bot…`);
      setTimeout(() => startBaileys(), 2000);
    }
    if (connection === 'close') {
      if (entry.status === 'linked') return;
      // Reconnect for fresh auth
      setTimeout(async () => {
        try {
          const { state: s2, saveCreds: sc2 } = await useMultiFileAuthState(sessionFolder);
          const s = makeWASocket({ version, auth: s2, printQRInTerminal: false, logger, browser: CONFIG.browser, qrTimeout: 120000, markOnlineOnConnect: false, syncFullHistory: false, linkPreview: false });
          entry.sock = s;
          s.ev.on('creds.update', sc2);
          s.ev.on('connection.update', (u2) => {
            if (u2.connection === 'open') {
              entry.status = 'linked';
              for (const f of fs.readdirSync(sessionFolder)) fs.copyFileSync(path.join(sessionFolder, f), path.join(CONFIG.authDir, f));
              console.log(`[PAIR ${webId}] ✓ Linked (reconnect)! Starting main bot…`);
              setTimeout(() => startBaileys(), 2000);
            }
          });
        } catch(e) { console.error(`[PAIR ${webId}] Reconnect failed:`, e.message); }
      }, 3000);
    }
  });

  // Wait for QR event (socket ready), then request pairing code
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Socket timeout')), 60000);
    const handler = (u) => {
      if (u.qr || u.connection === 'open') { clearTimeout(timeout); pairSock.ev.off('connection.update', handler); resolve(); }
      if (u.connection === 'close') { clearTimeout(timeout); pairSock.ev.off('connection.update', handler); reject(new Error('Connection closed')); }
    };
    pairSock.ev.on('connection.update', handler);
  });

  const code = await pairSock.requestPairingCode(phone);
  entry.code = code;
  entry.status = 'code_sent';
  console.log(`[PAIR ${webId}] Code: ${code} for +${phone}`);
  return { webId, code: code.length === 8 ? code.slice(0,4) + '-' + code.slice(4) : code, rawCode: code, phone };
}

// ─── Express + premium UI ──────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true, botConnected, ts: Date.now() }));

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

// Download menu image in background
downloadMenuImage().catch(() => {});

// If SESSION_ID env var is set OR auth folder has creds, start bot directly
const hasCreds = fs.existsSync(path.join(CONFIG.authDir, 'creds.json'));
if (CONFIG.sessionId || hasCreds) {
  console.log('  ℹ Existing session found — starting bot directly…\n');
  startBaileys().catch(e => console.error('  ✗ Bot start failed:', e.message));
} else {
  console.log('  ℹ No session found — visit the pairing site to pair.\n');
}

process.on('SIGTERM', () => { console.log('\n  ⊘ SIGTERM — shutting down'); process.exit(0); });
process.on('SIGINT', () => { console.log('\n  ⊘ SIGINT — shutting down'); process.exit(0); });
