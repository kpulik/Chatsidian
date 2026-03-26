import {
  App,
  Component,
  ItemView,
  MarkdownRenderer,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
} from 'obsidian';

// ─── Constants ────────────────────────────────────────────────────────────────

const VIEW_TYPE_CHAT = 'claudesidian-chat';
const ANTHROPIC_API  = 'https://api.anthropic.com/v1/messages';

const MODELS = [
  { id: 'claude-haiku-4-5',   label: 'Haiku 4.5  ·  fast' },
  { id: 'claude-sonnet-4-6',  label: 'Sonnet 4.6  ·  balanced' },
  { id: 'claude-opus-4-6',    label: 'Opus 4.6  ·  powerful' },
];

// Token auto-detect paths (Claude Code stores creds here on macOS)
function getTokenPaths(): string[] {
  try {
    const home = (process as NodeJS.Process).env?.HOME ?? '';
    return [
      `${home}/.claude/.credentials.json`,
      `${home}/.claude/auth.json`,
      `${home}/.config/claude/credentials.json`,
    ];
  } catch {
    return [];
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface ClaudesidianSettings {
  token: string;
  model: string;
  systemPrompt: string;
  maxTokens: number;
}

const DEFAULT_SETTINGS: ClaudesidianSettings = {
  token: '',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You are a helpful assistant integrated into Obsidian. Be concise and precise.',
  maxTokens: 4096,
};

// ─── API ─────────────────────────────────────────────────────────────────────

async function streamClaude(
  settings: ClaudesidianSettings,
  messages: Message[],
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (msg: string) => void,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        // Standard API keys (sk-ant-...) use x-api-key; OAuth tokens use Bearer
        ...(settings.token.startsWith('sk-')
          ? { 'x-api-key': settings.token }
          : { 'Authorization': `Bearer ${settings.token}`, 'anthropic-beta': 'oauth-2025-04-20' }),
        'Content-Type':      'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      settings.model,
        max_tokens: settings.maxTokens,
        system:     settings.systemPrompt,
        messages,
        stream:     true,
      }),
    });
  } catch (e) {
    onError(`Network error: ${(e as Error).message}`);
    return;
  }

  if (!response.ok) {
    const body = await response.text();
    let hint = '';
    if (response.status === 401) hint = ' — check your token in Claudesidian settings';
    if (response.status === 403) hint = ' — token may be expired or restricted';
    onError(`API ${response.status}${hint}: ${body}`);
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) { onError('No response stream'); return; }

  const dec = new TextDecoder();
  let buf = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') { onDone(); return; }
        try {
          const evt = JSON.parse(payload);
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            onChunk(evt.delta.text);
          }
        } catch { /* ignore SSE parse errors */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
  onDone();
}

// ─── Token Auto-Detect ────────────────────────────────────────────────────────

function tryFindToken(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = (window as Window & { require?: NodeRequire }).require?.('fs') as typeof import('fs') | undefined;
    if (!fs) return null;
    for (const p of getTokenPaths()) {
      try {
        const raw = fs.readFileSync(p, 'utf-8');
        const parsed = JSON.parse(raw);
        const tok =
          parsed?.token ??
          parsed?.access_token ??
          parsed?.claudeAiOauthToken ??
          parsed?.oauth_token ??
          null;
        if (tok && typeof tok === 'string') return tok;
      } catch { /* file not found or parse error — try next */ }
    }
  } catch { /* Node.js not available */ }
  return null;
}

// ─── Chat View ────────────────────────────────────────────────────────────────

class ClaudesidianView extends ItemView {
  private plugin: ClaudesidianPlugin;
  private history: Message[] = [];
  private streaming = false;

  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private includeNoteEl!: HTMLInputElement;
  private modelSelectEl!: HTMLSelectElement;

  constructor(leaf: WorkspaceLeaf, plugin: ClaudesidianPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType()    { return VIEW_TYPE_CHAT; }
  getDisplayText() { return 'Claudesidian'; }
  getIcon()        { return 'bot'; }

  async onOpen() {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('cs-root');

    // ── Header ──
    const header = root.createDiv('cs-header');
    header.createSpan({ cls: 'cs-logo', text: '◆' });
    header.createSpan({ cls: 'cs-title', text: 'Claude' });

    const controls = header.createDiv('cs-controls');

    this.modelSelectEl = controls.createEl('select', { cls: 'cs-model-select' });
    for (const m of MODELS) {
      const opt = this.modelSelectEl.createEl('option', { value: m.id, text: m.label });
      if (m.id === this.plugin.settings.model) opt.selected = true;
    }
    this.modelSelectEl.addEventListener('change', () => {
      this.plugin.settings.model = this.modelSelectEl.value;
      this.plugin.saveSettings();
    });

    const clearBtn = controls.createEl('button', {
      cls:  'cs-icon-btn',
      text: '⌫',
      attr: { title: 'Clear conversation' },
    });
    clearBtn.addEventListener('click', () => this.clear());

    // ── Messages ──
    this.messagesEl = root.createDiv('cs-messages');
    this.renderWelcome();

    // ── Footer ──
    const footer = root.createDiv('cs-footer');

    const ctxRow = footer.createDiv('cs-ctx-row');
    this.includeNoteEl = ctxRow.createEl('input', { type: 'checkbox', cls: 'cs-ctx-check' });
    this.includeNoteEl.id = 'cs-include-note';
    ctxRow.createEl('label', {
      text: 'Include current note',
      attr: { for: 'cs-include-note' },
      cls:  'cs-ctx-label',
    });

    const inputRow = footer.createDiv('cs-input-row');
    this.inputEl = inputRow.createEl('textarea', {
      cls:  'cs-input',
      attr: { placeholder: 'Message Claude… (⌘↵ to send)', rows: '3' },
    });
    this.sendBtn = inputRow.createEl('button', {
      cls:  'cs-send-btn',
      text: '↑',
      attr: { title: 'Send (⌘↵)' },
    });

    this.inputEl.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        this.send();
        return;
      }
      // Auto-resize textarea
      requestAnimationFrame(() => {
        this.inputEl.style.height = 'auto';
        this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 180) + 'px';
      });
    });
    this.sendBtn.addEventListener('click', () => this.send());
  }

  private renderWelcome() {
    const el = this.messagesEl.createDiv('cs-welcome');
    el.createDiv({ cls: 'cs-welcome-icon', text: '◆' });
    el.createDiv({ cls: 'cs-welcome-text', text: 'What can I help you with?' });
  }

  private clear() {
    this.history = [];
    this.messagesEl.empty();
    this.renderWelcome();
  }

  private async send() {
    const text = this.inputEl.value.trim();
    if (!text || this.streaming) return;

    if (!this.plugin.settings.token) {
      new Notice('Claudesidian: Add your token in Settings → Claudesidian');
      return;
    }

    // Build user content (optionally include current note)
    let userContent = text;
    if (this.includeNoteEl.checked) {
      const file = this.app.workspace.getActiveFile();
      if (file) {
        const raw = await this.app.vault.read(file);
        userContent = `<note title="${file.basename}">\n${raw}\n</note>\n\n${text}`;
      }
    }

    this.inputEl.value = '';
    this.inputEl.style.height = 'auto';

    // Remove welcome screen on first message
    this.messagesEl.querySelector('.cs-welcome')?.remove();

    this.history.push({ role: 'user', content: userContent });
    this.appendUserBubble(text);

    this.streaming = true;
    this.sendBtn.disabled = true;
    this.sendBtn.textContent = '…';

    // Create assistant bubble
    const bubble  = this.messagesEl.createDiv('cs-msg cs-msg--assistant');
    const bodyEl  = bubble.createDiv('cs-msg-body');
    let acc = '';

    await streamClaude(
      this.plugin.settings,
      this.history,
      chunk => {
        acc += chunk;
        bodyEl.empty();
        MarkdownRenderer.render(this.app, acc, bodyEl, '', new Component());
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      },
      () => {
        this.history.push({ role: 'assistant', content: acc });
        this.streaming = false;
        this.sendBtn.disabled = false;
        this.sendBtn.textContent = '↑';

        const actions = bubble.createDiv('cs-msg-actions');

        const copyBtn = actions.createEl('button', { cls: 'cs-action-btn', text: 'Copy' });
        copyBtn.addEventListener('click', async () => {
          await navigator.clipboard.writeText(acc);
          copyBtn.textContent = '✓ Copied';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
        });

        const insertBtn = actions.createEl('button', { cls: 'cs-action-btn', text: 'Insert' });
        insertBtn.addEventListener('click', () => this.insertIntoNote(acc));
      },
      err => {
        bodyEl.addClass('cs-msg-error');
        bodyEl.textContent = `⚠ ${err}`;
        this.streaming = false;
        this.sendBtn.disabled = false;
        this.sendBtn.textContent = '↑';
      },
    );

    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private appendUserBubble(text: string) {
    const bubble = this.messagesEl.createDiv('cs-msg cs-msg--user');
    bubble.createDiv({ cls: 'cs-msg-body', text });
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private async insertIntoNote(text: string) {
    const editor = this.app.workspace.activeEditor?.editor;
    if (editor) {
      editor.replaceSelection(text);
      new Notice('Inserted at cursor');
    } else {
      const file = this.app.workspace.getActiveFile();
      if (!file) { new Notice('No active note'); return; }
      const cur = await this.app.vault.read(file);
      await this.app.vault.modify(file, cur + '\n\n' + text);
      new Notice('Appended to note');
    }
  }
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class ClaudesidianSettingsTab extends PluginSettingTab {
  plugin: ClaudesidianPlugin;

  constructor(app: App, plugin: ClaudesidianPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Claudesidian' });

    containerEl.createEl('p', {
      text: 'Get your API key from console.anthropic.com and paste it below.',
      cls:  'cs-settings-note',
    });

    new Setting(containerEl)
      .setName('API token')
      .setDesc('Standard API key (sk-ant-api03-...) from console.anthropic.com, or Claude Code OAuth token (sk-ant-oat01-...) from running "claude setup-token" in your terminal.')
      .addText(text =>
        text
          .setPlaceholder('Paste token here…')
          .setValue(this.plugin.settings.token)
          .onChange(async v => {
            this.plugin.settings.token = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    // Model
    new Setting(containerEl)
      .setName('Default model')
      .addDropdown(dd => {
        for (const m of MODELS) dd.addOption(m.id, m.label);
        dd.setValue(this.plugin.settings.model);
        dd.onChange(async v => {
          this.plugin.settings.model = v;
          await this.plugin.saveSettings();
        });
      });

    // System prompt
    new Setting(containerEl)
      .setName('System prompt')
      .addTextArea(ta => {
        ta.setValue(this.plugin.settings.systemPrompt).onChange(async v => {
          this.plugin.settings.systemPrompt = v;
          await this.plugin.saveSettings();
        });
        ta.inputEl.rows = 5;
        ta.inputEl.style.width = '100%';
      });

    // Max tokens
    new Setting(containerEl)
      .setName('Max tokens')
      .setDesc('Maximum response length (default 4096)')
      .addText(t =>
        t.setValue(String(this.plugin.settings.maxTokens)).onChange(async v => {
          const n = parseInt(v);
          if (!isNaN(n) && n > 0) {
            this.plugin.settings.maxTokens = n;
            await this.plugin.saveSettings();
          }
        }),
      );

  }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default class ClaudesidianPlugin extends Plugin {
  settings!: ClaudesidianSettings;

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_CHAT, leaf => new ClaudesidianView(leaf, this));

    this.addRibbonIcon('bot', 'Open Claudesidian', () => this.activateView());

    this.addCommand({
      id:       'open-claudesidian',
      name:     'Open chat',
      callback: () => this.activateView(),
    });

    this.addSettingTab(new ClaudesidianSettingsTab(this.app, this));
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
