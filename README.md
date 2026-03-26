# Claudesidian

Claude AI inside Obsidian, using your existing Claude Pro/Max subscription via the Claude Code OAuth token. No separate API billing.

Built for research and personal productivity, exploring how AI can integrate into a local knowledge management workflow.

---

> **Before you use this:** Claudesidian uses the OAuth token issued to Claude Code (Anthropic's official CLI) to call Anthropic's API. This token is scoped for Claude Code only, and using it in other clients is not officially sanctioned by Anthropic. It sits in a grey area of their Terms of Service. Anthropic has previously blocked third-party clients using this token (January 2026), so there is a real chance it stops working at some point, or that your account gets rate-limited. If you want something guaranteed stable, use the [official API](https://console.anthropic.com) with a paid key instead.

---

## How it works

Claudesidian authenticates with Anthropic's API on behalf of your subscription. Standard API keys (`sk-ant-...`) from console.anthropic.com and Claude Code OAuth tokens are both supported.

## Getting your API token

Go to [console.anthropic.com](https://console.anthropic.com), sign in with your Anthropic account, and create a new API key. Copy it and paste it into **Settings > Claudesidian** in Obsidian.

## Installation

This plugin is not listed in the Obsidian community plugin registry. Install it manually.

**Requirements**

- [Node.js](https://nodejs.org) v18+
- Obsidian 1.0+
- A Claude Pro or Max subscription

**Build from source**

```bash
git clone https://github.com/kpulik/claudesidian
cd claudesidian
npm install
npm run build
```

**Install into your vault**

```bash
mkdir -p /path/to/your/vault/.obsidian/plugins/claudesidian
cp main.js manifest.json styles.css /path/to/your/vault/.obsidian/plugins/claudesidian/
```

Then add `"claudesidian"` to your vault's `.obsidian/community-plugins.json`:

```json
[
  "...other plugins...",
  "claudesidian"
]
```

Restart Obsidian. The plugin will appear in **Settings > Community Plugins**.

## Usage

- Click the **bot icon** in the left ribbon to open the chat panel
- Select your model (Haiku / Sonnet / Opus) from the dropdown
- Check **Include current note** to send your active note as context
- Use **Cmd+Enter** to send a message
- Hover over any assistant message to see **Copy** and **Insert** buttons
- **Insert** puts the response at your cursor, or appends to the note if no editor is active

## Development

```bash
npm run dev   # watch mode, rebuilds on every save
```

For live reloading inside Obsidian, install the [Hot Reload](https://github.com/pjeby/hot-reload) community plugin and symlink the project folder into your vault's plugins directory:

```bash
ln -s /path/to/claudesidian /path/to/vault/.obsidian/plugins/claudesidian
```

Open Obsidian's developer tools with **Cmd+Option+I** to debug.

## License

MIT
