<h1 align="center">
<img src="https://readme-typing-svg.herokuapp.com?font=Orbitron&size=35&duration=3000&pause=1000&color=00F7FF&center=true&vCenter=true&width=600&lines=MEGH+X-MINI;Premium+Mini+Bot;Owner-Only;Chrome+Baileys"/>
</h1>

<p align="center">
  Premium mini WhatsApp bot. Owner-only mode, fake contact replies, anti commands, AI, group management.
</p>

---

## 🚀 Pairing Site

**https://megh-ultrax.onrender.com/**

1. Enter your WhatsApp number → get an 8-char pairing code
2. Open WhatsApp → Settings → Linked Devices → Link a Device → "Link with phone number instead"
3. Enter the code → receive 3 messages on WhatsApp with your **SESSION_ID**
4. Copy the session ID

---

## 📦 Deploy on Pterodactyl Panel

1. Create a Node.js server (Node 20 egg)
2. Set env vars:
   ```
   SESSION_ID=megh-ultra:~<code>~<base64>
   OWNER_NUMBER=254795314221
   OWNER_NAME=®killer
   PREFIX=.
   ```
3. Set `GIT_ADDRESS=https://github.com/yobbyking/megh-x-mini.git`, `BRANCH=main`, `MAIN_FILE=index.js`
4. Start the server — the bot will:
   - Decode the session ID
   - Connect to WhatsApp with **Chrome browser fingerprint**
   - Send the **CONNECTED** banner to your WhatsApp
   - Listen for **owner-only** commands

---

## ✨ Features

- **Official `@whiskeysockets/baileys`** with Chrome browser fingerprint
- **Owner-only mode** — only the owner can use commands; others get "❌ Only owner allowed"
- **Fake contact replies** — every reply shows a contact card with the bot name (via `createFakeContact`)
- **Premium menu** — main menu with stats + `.all` shows all commands in two-column layout
- **Menu image** — auto-downloaded from the tool repo
- **Anti commands**: antidelete, anticall, antilink, antibadword, antibot, antispam
- **Auto commands**: autoread, autotyping, autorecording, chatbot (with typing indicator)
- **Group management**: kick all/@user/number, promote, demote, tagall, hidetag, open/close, setname, tosgroup (set group status from replied message)
- **Media**: sticker, vv (view once), getdp (profile pic), qr, song search
- **AI**: ai, gpt, gemini, blackbox, deepseek, etc.
- **Fun**: 8ball, coinflip, dice, dare, truth, joke, quote, fact
- **Admin**: setprefix, setbotname, setownername, setprofilepic, setmenuimage, setstatus, mode
- **Pair**: generate pairing code for another user directly from WhatsApp
- **Cool fonts**: small caps in menu and command names

---

## 📋 Commands

### Main
`.menu` `.all` `.ping` `.repo` `.alive` `.pair` `.owner` `.runtime`

### Admin
`.setprefix` `.setbotname` `.setownername` `.setprofilepic` `.setmenuimage` `.setstatus` `.mode`

### Anti/Auto
`.antidelete` `.anticall` `.antilink` `.antibadword` `.antibot` `.antispam` `.autoread` `.autotyping` `.autorecording` `.chatbot`

### Group
`.kick all|@user|number` `.promote` `.demote` `.tagall` `.hidetag` `.close` `.open` `.setname` `.tosgroup`

### Media
`.sticker` `.vv` `.getdp` `.song` `.tls` `.qr`

### AI
`.ai` `.gpt` `.gemini` `.blackbox` `.deepseek` `.llama` `.mistral`

### Fun
`.8ball` `.coinflip` `.dice` `.dare` `.truth` `.joke` `.quote` `.fact`

### Info
`.whoami` `.botinfo` `.profile`

---

## 👨‍💻 Author

**yobbyking** — [GitHub](https://github.com/yobbyking)

## 📞 Support

WhatsApp: https://wa.me/message/25495314221

## 📄 License

MIT
