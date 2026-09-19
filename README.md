# MEGH X-MINI — Self-Contained Mini Bot

Premium mini WhatsApp bot with **built-in pairing**. One deploy = pairing site + bot. Deploy on Render or Railway, pair via web, bot connects instantly.

<h1 align="center">
<img src="https://readme-typing-svg.herokuapp.com?font=Orbitron&size=35&duration=3000&pause=1000&color=00F7FF&center=true&vCenter=true&width=600&lines=MEGH+X-MINI;Self-Contained+Bot;Built-in+Pairing;Render+Ready"/>
</h1>

## 🚀 Deploy on Render

1. New Web Service → connect this repo
2. Render auto-detects `render.yaml` — confirm and deploy
3. Visit your Render URL → enter phone number → get pairing code
4. Open WhatsApp → Settings → Linked Devices → Link a Device → "Link with phone number instead"
5. Enter the code → bot connects **instantly** → sends **CONNECTED** message to your WhatsApp
6. Use `.menu` in WhatsApp — bot works immediately!

**No Pterodactyl. No separate repos. No SESSION_ID copy-paste. Just deploy + pair + chat.**

---

## ✨ Features

- **Official `@whiskeysockets/baileys`** with Chrome browser fingerprint
- **Built-in pairing site** — Express server serves a premium cyber UI
- **Instant connect** — once you enter the pairing code, the bot connects and sends a CONNECTED banner immediately
- **Owner-only mode** — only the owner can use commands; others get "❌ Only owner allowed"
- **Fake contact replies** — every reply shows a contact card with the bot name
- **Premium menu** with image, stats, RAM bar, two-column `.all` command list
- **60+ commands** across AI, group, anti, media, fun, admin, info categories
- **SQLite** for settings (prefix, botName, mode, auto toggles)
- **Cool fonts** — small caps in menu + command names

---

## 📋 Commands

| Category | Commands |
|----------|----------|
| **Main** | `.menu` `.all` `.ping` `.repo` `.alive` `.pair` `.owner` `.runtime` |
| **Admin** | `.setprefix` `.setbotname` `.setownername` `.setprofilepic` `.setmenuimage` `.setstatus` `.mode` |
| **Anti** | `.antidelete` `.antilink` `.antibadword` `.anticall` `.antibot` `.antispam` |
| **Auto** | `.autoread` `.autotyping` `.autorecording` `.chatbot` |
| **Group** | `.kick all\|@user\|number` `.promote` `.demote` `.tagall` `.hidetag` `.close` `.open` `.setname` `.tosgroup` |
| **Media** | `.sticker` `.vv` `.getdp` `.song` `.tls` `.qr` |
| **AI** | `.ai` `.gpt` `.gemini` `.blackbox` `.deepseek` |
| **Fun** | `.8ball` `.coinflip` `.dice` `.dare` `.truth` `.joke` `.quote` `.fact` |
| **Info** | `.whoami` `.botinfo` `.calc` |

---

## ⚙️ Environment Variables

| Var | Default | Description |
|-----|---------|-------------|
| `OWNER_NUMBER` | `254795314221` | Owner's WhatsApp number |
| `OWNER_NAME` | `killer` | Owner display name |
| `PREFIX` | `.` | Command prefix |
| `BOT_NAME` | `MEGH X-MINI` | Bot display name |
| `SESSION_ID` | _(empty)_ | Optional: set to skip pairing on restart |

---

## 👨‍💻 Author

**yobbyking** — [GitHub](https://github.com/yobbyking)

## 📞 Support

WhatsApp: https://wa.me/message/25495314221

## 📄 License

MIT
