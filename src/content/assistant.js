/* global Zotero, Services, ChromeUtils, PathUtils, IOUtils, Ci, ClaudeReaderAssistant:writable */
const { Subprocess } = ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs');

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const PREF_PREFIX = 'extensions.claude-reader-assistant.';
const STYLE_ID = 'claude-reader-assistant-style';
const POPUPSET_ID = 'claude-reader-assistant-popupset';

const SYSTEM_PROMPT = `You are a research reading assistant embedded in the Zotero reader.
The user is reading the document given in <document_content>, with metadata in <document_metadata>.
Text the user highlighted in the reader is given in <selected_text>.
- Answer from the document first. Point to the section, figure, table or page when you can.
- If the document does not contain the answer, say so. You may then answer from general knowledge, but label it as such.
- Do not invent citations, numbers or quotes.
- Reply in the language the user writes in.
- Use concise GitHub-flavored Markdown. Headings, lists, tables, code blocks and links are rendered.`;

ClaudeReaderAssistant = {
	id: null,
	rootURI: null,
	_notifierID: null,
	// tabID -> state
	_states: new Map(),

	init({ id, rootURI }) {
		this.id = id;
		this.rootURI = rootURI;
		// marked is a UMD bundle; give it a CommonJS-like target to export into.
		let markedScope = { module: { exports: {} }, exports: {} };
		Services.scriptloader.loadSubScript(rootURI + 'content/lib/marked.umd.js', markedScope);
		this._marked = markedScope.module.exports;
		this._onRenderToolbar = this._onRenderToolbar.bind(this);
		this._onRenderSelectionPopup = this._onRenderSelectionPopup.bind(this);
		this._notifierID = Zotero.Notifier.registerObserver(this, ['tab'], 'claudeReaderAssistant');
		Zotero.Reader.registerEventListener('renderToolbar', this._onRenderToolbar, id);
		Zotero.Reader.registerEventListener('renderTextSelectionPopup', this._onRenderSelectionPopup, id);
		this.attachAll();
	},

	shutdown() {
		if (this._notifierID) {
			Zotero.Notifier.unregisterObserver(this._notifierID);
			this._notifierID = null;
		}
		Zotero.Reader.unregisterEventListener('renderToolbar', this._onRenderToolbar);
		Zotero.Reader.unregisterEventListener('renderTextSelectionPopup', this._onRenderSelectionPopup);
		for (let tabID of [...this._states.keys()]) {
			this._destroyState(tabID);
		}
		for (let win of Zotero.getMainWindows()) {
			win.document.getElementById(STYLE_ID)?.remove();
			win.document.getElementById(POPUPSET_ID)?.remove();
		}
	},

	attachAll() {
		for (let reader of Zotero.Reader._readers) {
			this.attach(reader);
		}
	},

	detachAll(win) {
		for (let [tabID, state] of this._states) {
			if (state.panel.ownerDocument === win.document) {
				this._destroyState(tabID);
			}
		}
	},

	// Zotero.Notifier observer
	notify(event, type, ids) {
		if (type !== 'tab') return;
		for (let tabID of ids) {
			if (event === 'close') {
				this._destroyState(tabID);
			}
			else if (event === 'add' || event === 'load' || event === 'select') {
				this._attachWhenReady(tabID);
			}
		}
	},

	_getPref(name) {
		return Zotero.Prefs.get(PREF_PREFIX + name, true);
	},

	_setPref(name, value) {
		Zotero.Prefs.set(PREF_PREFIX + name, value, true);
	},

	_attachWhenReady(tabID, tries = 0) {
		let reader = Zotero.Reader.getByTabID(tabID);
		if (reader && reader._iframe && reader._tabContainer) {
			this.attach(reader);
			return;
		}
		if (tries < 50) {
			setTimeout(() => this._attachWhenReady(tabID, tries + 1), 200);
		}
	},

	/**
	 * Insert the assistant panel to the left of the reader in a reader tab.
	 * Returns the panel state, or null for readers that are not tabs.
	 */
	attach(reader) {
		let container = reader._tabContainer;
		let iframe = reader._iframe;
		if (!container || !iframe || iframe.parentNode !== container) {
			return null;
		}
		let state = this._states.get(reader.tabID);
		if (state && state.panel.parentNode === container) {
			state.reader = reader;
			return state;
		}
		let doc = container.ownerDocument;
		this._ensureStyle(doc);
		if (!state) {
			state = this._createState(reader, doc);
			this._states.set(reader.tabID, state);
		}
		else {
			// The tab was reloaded. Keep the conversation and move the panel.
			state.reader = reader;
			state.contextLoaded = false;
		}
		container.style.display = 'flex';
		container.style.flexDirection = 'row';
		this._placePanel(state);
		this._applyVisibility(state);
		Zotero.debug(`ClaudeReaderAssistant: attached panel to ${reader.tabID} on the ${this._getPosition()}`);
		return state;
	},

	_getPosition() {
		return this._getPref('panelPosition') === 'left' ? 'left' : 'right';
	},

	/**
	 * Put the panel and its resizer on the configured side of the reader:
	 * left: [panel][resizer][reader], right: [reader][resizer][panel]
	 */
	_placePanel(state) {
		let iframe = state.reader._iframe;
		let container = iframe?.parentNode;
		if (!container) return;
		if (this._getPosition() === 'left') {
			container.insertBefore(state.panel, iframe);
			container.insertBefore(state.resizer, iframe);
		}
		else {
			iframe.after(state.resizer, state.panel);
		}
		state.els.positionButton.textContent = this._getPosition() === 'left' ? '⇥' : '⇤';
		state.els.positionButton.title = this._getPosition() === 'left'
			? 'Move panel to the right'
			: 'Move panel to the left';
	},

	_togglePosition() {
		this._setPref('panelPosition', this._getPosition() === 'left' ? 'right' : 'left');
		for (let state of this._states.values()) {
			if (state.panel.isConnected) this._placePanel(state);
		}
	},

	toggle(reader, show) {
		let state = this._states.get(reader.tabID) || this.attach(reader);
		if (!state) return null;
		state.hidden = show === undefined ? !state.hidden : !show;
		this._applyVisibility(state);
		if (!state.hidden) {
			state.els.input.focus();
		}
		return state;
	},

	_applyVisibility(state) {
		state.panel.hidden = state.hidden;
		state.resizer.hidden = state.hidden;
		if (state.toolbarButton) {
			state.toolbarButton.classList.toggle('toggled', !state.hidden);
		}
	},

	_destroyState(tabID) {
		let state = this._states.get(tabID);
		if (!state) return;
		this._stop(state);
		let container = state.panel.parentNode;
		state.panel.remove();
		state.resizer.remove();
		if (container) {
			container.style.removeProperty('display');
			container.style.removeProperty('flex-direction');
		}
		this._states.delete(tabID);
	},

	_el(doc, tag, className, text) {
		let el = doc.createElementNS(HTML_NS, tag);
		if (className) el.className = className;
		if (text !== undefined) el.textContent = text;
		return el;
	},

	_createState(reader, doc) {
		let panel = this._el(doc, 'div', 'cra-panel');
		panel.style.width = this._getPref('panelWidth') + 'px';

		let header = this._el(doc, 'div', 'cra-header');
		let titleBox = this._el(doc, 'div', 'cra-title-box');
		titleBox.append(this._el(doc, 'div', 'cra-title', 'Claude Assistant'));
		let modelLabel = this._el(doc, 'div', 'cra-model', 'Model: checking…');
		titleBox.append(modelLabel);
		let newButton = this._el(doc, 'button', 'cra-button', 'New chat');
		newButton.title = 'Clear the conversation. The next question sends the document again.';
		let positionButton = this._el(doc, 'button', 'cra-button cra-icon');
		let closeButton = this._el(doc, 'button', 'cra-button cra-icon', '×');
		closeButton.title = 'Hide panel';
		header.append(titleBox, newButton, positionButton, closeButton);

		let contextInfo = this._el(doc, 'div', 'cra-context', 'The document text is sent as context with your first question.');
		let messages = this._el(doc, 'div', 'cra-messages');

		let quote = this._el(doc, 'div', 'cra-quote');
		quote.hidden = true;
		let quoteText = this._el(doc, 'div', 'cra-quote-text');
		let quoteRemove = this._el(doc, 'button', 'cra-button cra-icon', '×');
		quoteRemove.title = 'Remove selected text';
		quote.append(quoteText, quoteRemove);

		let inputRow = this._el(doc, 'div', 'cra-input-row');
		let input = this._el(doc, 'textarea', 'cra-input');
		input.setAttribute('rows', '3');
		input.setAttribute('placeholder', 'Ask about this document (Enter to send, Shift+Enter for a new line)');
		let sendButton = this._el(doc, 'button', 'cra-button cra-send', 'Send');
		inputRow.append(input, sendButton);

		panel.append(header, contextInfo, messages, quote, inputRow);

		let resizer = this._el(doc, 'div', 'cra-resizer');

		let state = {
			reader,
			panel,
			resizer,
			els: { modelLabel, positionButton, contextInfo, messages, quote, quoteText, input, sendButton },
			toolbarButton: null,
			sessionID: null,
			contextLoaded: false,
			pendingQuote: null,
			proc: null,
			busy: false,
			stopped: false,
			hidden: false,
		};

		newButton.addEventListener('click', () => this._reset(state));
		positionButton.addEventListener('click', () => this._togglePosition());
		this._showConfiguredModel(state);
		closeButton.addEventListener('click', () => this.toggle(state.reader, false));
		quoteRemove.addEventListener('click', () => this._setQuote(state, null));
		sendButton.addEventListener('click', () => {
			if (state.busy) this._stop(state);
			else this._send(state);
		});
		input.addEventListener('keydown', (event) => {
			event.stopPropagation();
			if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
				event.preventDefault();
				this._send(state);
			}
		});
		messages.addEventListener('contextmenu', event => this._openContextMenu(state, event));
		// Links must not navigate the Zotero window. Open web links in the browser.
		messages.addEventListener('click', (event) => {
			let link = event.target.closest?.('a');
			if (!link) return;
			event.preventDefault();
			let href = link.getAttribute('href') || '';
			if (/^(https?:|mailto:)/i.test(href)) Zotero.launchURL(href);
		});
		this._initResizer(state);
		return state;
	},

	_initResizer(state) {
		let { panel, resizer } = state;
		let startX, startWidth;
		let onMove = (event) => {
			// The resizer sits on the reader side of the panel.
			let delta = event.clientX - startX;
			if (this._getPosition() === 'right') delta = -delta;
			let width = Math.min(900, Math.max(260, startWidth + delta));
			panel.style.width = width + 'px';
		};
		let onUp = (event) => {
			resizer.releasePointerCapture(event.pointerId);
			resizer.removeEventListener('pointermove', onMove);
			resizer.removeEventListener('pointerup', onUp);
			this._setPref('panelWidth', Math.round(panel.getBoundingClientRect().width));
		};
		resizer.addEventListener('pointerdown', (event) => {
			startX = event.clientX;
			startWidth = panel.getBoundingClientRect().width;
			resizer.setPointerCapture(event.pointerId);
			resizer.addEventListener('pointermove', onMove);
			resizer.addEventListener('pointerup', onUp);
			event.preventDefault();
		});
	},

	_getContextMenu(doc) {
		let popupset = doc.getElementById(POPUPSET_ID);
		if (!popupset) {
			popupset = doc.createXULElement('popupset');
			popupset.id = POPUPSET_ID;
			popupset.append(doc.createXULElement('menupopup'));
			doc.documentElement.append(popupset);
		}
		return popupset.firstChild;
	},

	// Context menu for the message list: copy the dragged selection or a whole answer.
	_openContextMenu(state, event) {
		let doc = state.panel.ownerDocument;
		let selection = doc.defaultView.getSelection();
		let selectedText = '';
		if (selection && !selection.isCollapsed
				&& state.els.messages.contains(selection.anchorNode)
				&& state.els.messages.contains(selection.focusNode)) {
			selectedText = selection.toString();
		}
		let answerEl = event.target.closest?.('.cra-assistant');
		if (!selectedText && !answerEl?._craText) return;
		event.preventDefault();
		event.stopPropagation();

		let popup = this._getContextMenu(doc);
		popup.replaceChildren();
		let addItem = (label, text) => {
			let item = doc.createXULElement('menuitem');
			item.setAttribute('label', label);
			if (!text) item.setAttribute('disabled', 'true');
			item.addEventListener('command', () => Zotero.Utilities.Internal.copyTextToClipboard(text));
			popup.append(item);
		};
		addItem('Copy', selectedText);
		if (answerEl?._craText) {
			addItem('Copy Answer as Markdown', answerEl._craText);
		}
		popup.openPopupAtScreen(event.screenX, event.screenY, true);
	},

	_reset(state) {
		this._stop(state);
		state.sessionID = null;
		state.contextLoaded = false;
		state.els.messages.replaceChildren();
		state.els.contextInfo.textContent = 'The document text is sent as context with your first question.';
		this._setQuote(state, null);
	},

	_setQuote(state, text) {
		state.pendingQuote = text || null;
		state.els.quote.hidden = !text;
		state.els.quoteText.textContent = text || '';
	},

	_onRenderToolbar(event) {
		let { reader, doc, append } = event;
		let button = doc.createElement('button');
		button.className = 'toolbar-button';
		button.title = 'Claude Assistant';
		button.textContent = '✦ Claude';
		button.style.cssText = 'width:auto;padding:0 6px;font-size:12px;';
		button.addEventListener('click', () => this.toggle(reader));
		append(button);
		setTimeout(() => {
			let state = this.attach(reader);
			if (state) {
				state.toolbarButton = button;
				this._applyVisibility(state);
			}
		});
	},

	_onRenderSelectionPopup(event) {
		let { reader, doc, params, append } = event;
		let text = params?.annotation?.text;
		if (!text) return;
		let button = doc.createElement('button');
		button.textContent = '✦ Ask Claude';
		button.style.cssText = 'margin-top:6px;width:100%;padding:4px 6px;font-size:12px;cursor:pointer;';
		button.addEventListener('click', () => {
			let state = this.toggle(reader, true);
			if (state) this._setQuote(state, text);
		});
		append(button);
	},

	_addMessage(state, role, text) {
		let doc = state.panel.ownerDocument;
		let el = this._el(doc, 'div', 'cra-message cra-' + role);
		if (role === 'assistant') this._renderMarkdown(el, text);
		else el.textContent = text;
		state.els.messages.append(el);
		state.els.messages.scrollTop = state.els.messages.scrollHeight;
		return el;
	},

	_setBusy(state, busy) {
		state.busy = busy;
		state.els.sendButton.textContent = busy ? 'Stop' : 'Send';
		state.els.sendButton.classList.toggle('cra-stop', busy);
	},

	async _send(state) {
		let input = state.els.input;
		let question = input.value.trim();
		if (!question || state.busy) return;
		input.value = '';
		let quote = state.pendingQuote;
		this._setQuote(state, null);

		this._addMessage(state, 'user', quote ? `“${quote}”\n\n${question}` : question);
		let answerEl = this._addMessage(state, 'assistant', '');
		answerEl.classList.add('cra-pending');
		this._setBusy(state, true);
		state.stopped = false;

		let answer = '';
		let renderScheduled = false;
		let render = () => {
			renderScheduled = false;
			this._renderMarkdown(answerEl, answer);
			let box = state.els.messages;
			box.scrollTop = box.scrollHeight;
		};

		try {
			let prompt = '';
			// The document goes into the first turn only. Later turns resume the same
			// Claude Code session, so the document stays in context.
			if (!state.sessionID || !state.contextLoaded) {
				prompt += await this._buildDocumentContext(state) + '\n\n';
			}
			if (quote) {
				prompt += `<selected_text>\n${quote}\n</selected_text>\n\n`;
			}
			prompt += question;

			await this._runClaude(state, prompt, (delta) => {
				answer += delta;
				answerEl.classList.remove('cra-pending');
				if (!renderScheduled) {
					renderScheduled = true;
					state.panel.ownerGlobal.requestAnimationFrame(render);
				}
			});
			state.contextLoaded = true;
			render();
		}
		catch (e) {
			Zotero.logError(e);
			if (state.stopped) {
				answer += '\n\n_(Stopped)_';
			}
			else {
				answer += (answer ? '\n\n' : '') + '**Error:** ' + (e.message || e);
			}
			render();
		}
		finally {
			answerEl.classList.remove('cra-pending');
			this._setBusy(state, false);
		}
	},

	_stop(state) {
		if (state.proc) {
			state.stopped = true;
			try {
				state.proc.kill();
			}
			catch (e) {
				Zotero.logError(e);
			}
			state.proc = null;
		}
	},

	async _buildDocumentContext(state) {
		let reader = state.reader;
		let item = Zotero.Items.get(reader.itemID);
		let parent = item.parentItem;
		let meta = [];
		meta.push('Title: ' + (parent || item).getDisplayTitle());
		if (parent) {
			let creators = parent.getCreatorsJSON()
				.map(c => c.name || [c.firstName, c.lastName].filter(Boolean).join(' '))
				.filter(Boolean);
			if (creators.length) meta.push('Authors: ' + creators.join(', '));
			let date = parent.getField('date', true, true);
			if (date) meta.push('Year: ' + date.substring(0, 4));
			let pub = parent.getField('publicationTitle', false, true);
			if (pub) meta.push('Publication: ' + pub);
			let doi = parent.getField('DOI', false, true);
			if (doi) meta.push('DOI: ' + doi);
		}
		meta.push('File type: ' + (item.attachmentContentType || 'unknown'));

		state.els.contextInfo.textContent = 'Extracting document text…';
		let text = '';
		try {
			text = (await item.attachmentText) || '';
		}
		catch (e) {
			Zotero.logError(e);
		}
		let max = this._getPref('maxContextChars') || 400000;
		let truncated = text.length > max;
		if (truncated) text = text.substring(0, max);

		let info = text
			? `Context: ${text.length.toLocaleString()} characters${truncated ? ' (truncated to the maximum length)' : ''}`
			: 'Warning: Could not extract the document text. Only metadata is sent.';
		state.els.contextInfo.textContent = info;

		return `<document_metadata>\n${meta.join('\n')}\n</document_metadata>\n\n`
			+ `<document_content${truncated ? ' truncated="true"' : ''}>\n${text}\n</document_content>`;
	},

	_homeDir() {
		return Services.env.get('HOME') || Services.dirsvc.get('Home', Ci.nsIFile).path;
	},

	_extendedPath() {
		let home = this._homeDir();
		let current = Services.env.get('PATH') || '/usr/bin:/bin:/usr/sbin:/sbin';
		return [`${home}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin', current].join(':');
	},

	async _resolveClaudePath() {
		let configured = this._getPref('claudePath');
		if (configured) return configured;
		let home = this._homeDir();
		let candidates = [
			`${home}/.local/bin/claude`,
			`${home}/.claude/local/claude`,
			'/opt/homebrew/bin/claude',
			'/usr/local/bin/claude',
		];
		for (let path of candidates) {
			if (await IOUtils.exists(path)) return path;
		}
		try {
			return await Subprocess.pathSearch('claude', { PATH: this._extendedPath() });
		}
		catch (e) {
			throw new Error('Could not find the Claude Code CLI (claude). '
				+ `Set ${PREF_PREFIX}claudePath in the Config Editor.`);
		}
	},

	/**
	 * Ask the CLI for its model list with an "initialize" control request.
	 * This starts Claude Code without sending a message, so no model request is made.
	 * Resolves to [{ value, displayName, description }], or [] on failure.
	 */
	_getModelList() {
		if (!this._modelListPromise) {
			this._modelListPromise = this._fetchModelList().catch((e) => {
				Zotero.logError(e);
				this._modelListPromise = null;
				return [];
			});
		}
		return this._modelListPromise;
	},

	async _fetchModelList() {
		let proc = await Subprocess.call({
			command: await this._resolveClaudePath(),
			arguments: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
				'--verbose', '--tools', '', '--strict-mcp-config'],
			environment: { PATH: this._extendedPath() },
			environmentAppend: true,
			workdir: await this._workdir(),
			stderr: 'pipe',
		});
		let timer = setTimeout(() => proc.kill(), 20000);
		try {
			proc.stdin.write(JSON.stringify({
				type: 'control_request',
				request_id: 'models',
				request: { subtype: 'initialize' },
			}) + '\n');
			let buffer = '';
			let str;
			while ((str = await proc.stdout.readString())) {
				buffer += str;
				let lines = buffer.split('\n');
				buffer = lines.pop();
				for (let line of lines) {
					let msg;
					try {
						msg = JSON.parse(line);
					}
					catch (e) {
						continue;
					}
					if (msg.type === 'control_response' && msg.response?.request_id === 'models') {
						return msg.response.response?.models || [];
					}
				}
			}
			return [];
		}
		finally {
			clearTimeout(timer);
			try {
				proc.kill();
			}
			catch (e) {}
		}
	},

	async _readClaudeSettingsModel() {
		try {
			let path = PathUtils.join(this._homeDir(), '.claude', 'settings.json');
			let settings = JSON.parse(await IOUtils.readUTF8(path));
			return typeof settings.model === 'string' ? settings.model : '';
		}
		catch (e) {
			return '';
		}
	},

	/**
	 * Turn a model setting such as "opus[1m]", "default" or "claude-opus-5-5" into a
	 * display name such as "Opus 5.5 (1M context)", using the CLI's model list.
	 */
	_describeModel(setting, models) {
		let base = setting.replace(/\[1m\]$/i, '');
		let suffix = /\[1m\]$/i.test(setting) ? ' (1M context)' : '';
		let entry = models.find(m => m.value === base);
		let name;
		if (entry?.value === 'default') {
			// "Default (recommended)": the description starts with the real model name.
			name = (entry.description || '').split('·')[0].trim();
		}
		else if (entry) {
			name = entry.displayName;
		}
		else {
			// Full model ID such as "claude-opus-5-5"
			let m = base.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/);
			if (m) name = m[1][0].toUpperCase() + m[1].slice(1) + ' ' + m[2] + (m[3] ? '.' + m[3] : '');
		}
		return (name || setting) + suffix;
	},

	async _showConfiguredModel(state) {
		let pref = this._getPref('model');
		let setting = pref || await this._readClaudeSettingsModel() || 'default';
		let models = await this._getModelList();
		// A real answer may already have reported the exact model.
		if (state.exactModel) return;
		let source = pref ? 'plugin setting' : 'Claude Code default';
		state.els.modelLabel.textContent = `Model: ${this._describeModel(setting, models)}`;
		state.els.modelLabel.title = `${source}: ${setting}`;
		Zotero.debug(`ClaudeReaderAssistant: ${state.els.modelLabel.textContent} (${source}: ${setting})`);
	},

	// Show the exact model ID reported by Claude Code for an answer.
	async _showModel(state, modelID) {
		state.exactModel = modelID;
		state.els.modelLabel.textContent = `Model: ${this._describeModel(modelID, [])}`;
		state.els.modelLabel.title = modelID;
		let models = await this._getModelList();
		state.els.modelLabel.textContent = `Model: ${this._describeModel(modelID, models)} · ${modelID}`;
	},

	async _workdir() {
		let dir = PathUtils.join(Zotero.DataDirectory.dir, 'claude-reader-assistant');
		await IOUtils.makeDirectory(dir, { ignoreExisting: true });
		return dir;
	},

	/**
	 * Run one turn through the Claude Code CLI in print mode and stream the reply.
	 * The CLI uses the user's Claude Code login and default model unless the
	 * model pref is set.
	 */
	async _runClaude(state, prompt, onDelta) {
		let command = await this._resolveClaudePath();
		let args = [
			'-p',
			'--output-format', 'stream-json',
			'--verbose',
			'--include-partial-messages',
			'--tools', '',
			'--strict-mcp-config',
			'--system-prompt', SYSTEM_PROMPT,
		];
		let model = this._getPref('model');
		if (model) args.push('--model', model);
		if (state.sessionID) args.push('--resume', state.sessionID);

		let proc = await Subprocess.call({
			command,
			arguments: args,
			environment: { PATH: this._extendedPath() },
			environmentAppend: true,
			workdir: await this._workdir(),
			stderr: 'pipe',
		});
		state.proc = proc;

		let stderr = '';
		let stderrDone = (async () => {
			let str;
			while ((str = await proc.stderr.readString())) stderr += str;
		})().catch(() => {});

		proc.stdin.write(prompt);
		await proc.stdin.close();

		let gotDelta = false;
		let result = null;
		let handle = (line) => {
			if (!line.trim()) return;
			let msg;
			try {
				msg = JSON.parse(line);
			}
			catch (e) {
				return;
			}
			if (msg.type === 'system' && msg.subtype === 'init' && msg.model) {
				this._showModel(state, msg.model);
			}
			else if (msg.type === 'stream_event') {
				let ev = msg.event;
				if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
					gotDelta = true;
					onDelta(ev.delta.text);
				}
			}
			else if (msg.type === 'result') {
				result = msg;
			}
		};

		let buffer = '';
		let str;
		while ((str = await proc.stdout.readString())) {
			buffer += str;
			let lines = buffer.split('\n');
			buffer = lines.pop();
			lines.forEach(handle);
		}
		handle(buffer);
		let { exitCode } = await proc.wait();
		await stderrDone;
		if (state.proc === proc) state.proc = null;

		if (state.stopped) {
			throw new Error('stopped');
		}
		if (result?.session_id) {
			state.sessionID = result.session_id;
		}
		if (!result || result.is_error || result.subtype !== 'success') {
			let detail = result?.result || stderr.trim() || `exit code ${exitCode}`;
			throw new Error(detail);
		}
		if (!gotDelta && result.result) {
			onDelta(result.result);
		}
	},

	/**
	 * Render Markdown (GFM: tables, lists, code, links) with marked.
	 * The panel lives in a privileged document, so the HTML from marked is
	 * parsed in an inert document and only allowed tags and attributes are copied.
	 */
	_renderMarkdown(el, text) {
		let doc = el.ownerDocument;
		el._craText = text;
		let html;
		try {
			html = this._marked.parse(text, { gfm: true, breaks: true, async: false });
		}
		catch (e) {
			Zotero.logError(e);
			el.textContent = text;
			return;
		}
		let parsed = new doc.defaultView.DOMParser().parseFromString(html, 'text/html');
		let fragment = doc.createDocumentFragment();
		this._copySafe(parsed.body, fragment, doc);
		el.replaceChildren(fragment);
	},

	_ALLOWED_TAGS: new Set(['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i',
		'del', 's', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th',
		'td', 'a', 'span', 'div', 'sup', 'sub', 'kbd', 'input']),
	_DROPPED_TAGS: new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'form',
		'button', 'textarea', 'select', 'img', 'svg', 'math', 'video', 'audio', 'template']),

	_copySafe(source, target, doc) {
		for (let node of source.childNodes) {
			if (node.nodeType === 3) {
				target.append(doc.createTextNode(node.data));
				continue;
			}
			if (node.nodeType !== 1) continue;
			let tag = node.localName;
			if (this._DROPPED_TAGS.has(tag)) continue;
			if (!this._ALLOWED_TAGS.has(tag)) {
				// Unknown tag: keep its content only.
				this._copySafe(node, target, doc);
				continue;
			}
			if (tag === 'input') {
				// GFM task list checkbox
				if (node.getAttribute('type') !== 'checkbox') continue;
				let box = this._el(doc, 'input');
				box.setAttribute('type', 'checkbox');
				box.setAttribute('disabled', 'true');
				if (node.hasAttribute('checked')) box.setAttribute('checked', 'true');
				target.append(box);
				continue;
			}
			let copy = this._el(doc, tag);
			if (tag === 'a') {
				let href = node.getAttribute('href') || '';
				if (/^(https?:|mailto:)/i.test(href)) {
					copy.setAttribute('href', href);
					copy.setAttribute('title', href);
				}
			}
			else if (tag === 'th' || tag === 'td') {
				let align = node.getAttribute('align');
				if (['left', 'center', 'right'].includes(align)) copy.style.textAlign = align;
			}
			else if (tag === 'ol') {
				let start = parseInt(node.getAttribute('start'));
				if (start > 0) copy.setAttribute('start', String(start));
			}
			this._copySafe(node, copy, doc);
			if (tag === 'table') {
				// Wide tables scroll horizontally inside the narrow panel.
				let wrap = this._el(doc, 'div', 'cra-table-wrap');
				wrap.append(copy);
				target.append(wrap);
			}
			else {
				target.append(copy);
			}
		}
	},

	_ensureStyle(doc) {
		if (doc.getElementById(STYLE_ID)) return;
		let style = this._el(doc, 'style');
		style.id = STYLE_ID;
		style.textContent = `
.cra-panel {
	display: flex; flex-direction: column; flex-shrink: 0; min-width: 260px;
	background: var(--material-sidepane, #f6f6f6); color: var(--fill-primary, #222);
	font: message-box; font-size: 13px; overflow: hidden;
}
.cra-panel[hidden], .cra-resizer[hidden] { display: none; }
.cra-resizer {
	width: 5px; flex-shrink: 0; cursor: col-resize;
	background: var(--fill-quinary, #ddd); border-inline: 2px solid transparent; background-clip: padding-box;
}
.cra-resizer:hover { background-color: var(--accent-blue, #4072e5); }
.cra-header {
	display: flex; align-items: center; gap: 6px; padding: 8px 10px;
	border-bottom: 1px solid var(--fill-quinary, #ddd);
}
.cra-title-box { flex: 1; min-width: 0; }
.cra-title { font-weight: 600; }
.cra-model { font-size: 11px; color: var(--fill-secondary, #777); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cra-context { padding: 6px 10px; font-size: 11px; color: var(--fill-secondary, #777); border-bottom: 1px solid var(--fill-quinary, #ddd); }
.cra-messages { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; user-select: text; }
.cra-message { padding: 8px 10px; border-radius: 8px; line-height: 1.5; overflow-wrap: anywhere; }
.cra-user { align-self: flex-end; max-width: 90%; white-space: pre-wrap; background: var(--accent-blue, #4072e5); color: #fff; }
.cra-assistant { background: var(--material-background, #fff); border: 1px solid var(--fill-quinary, #ddd); }
.cra-assistant > :first-child { margin-top: 0; }
.cra-assistant > :last-child { margin-bottom: 0; }
.cra-assistant p { margin: 0 0 8px; }
.cra-assistant h1, .cra-assistant h2, .cra-assistant h3, .cra-assistant h4, .cra-assistant h5, .cra-assistant h6 { margin: 12px 0 6px; font-weight: 600; line-height: 1.3; }
.cra-assistant h1 { font-size: 16px; } .cra-assistant h2 { font-size: 15px; } .cra-assistant h3 { font-size: 14px; }
.cra-assistant h4, .cra-assistant h5, .cra-assistant h6 { font-size: 13px; }
.cra-assistant ul, .cra-assistant ol { margin: 0 0 8px; padding-inline-start: 22px; }
.cra-assistant li { margin: 2px 0; }
.cra-assistant li > p { margin: 0; }
.cra-assistant blockquote { margin: 0 0 8px; padding: 2px 0 2px 10px; border-inline-start: 3px solid var(--fill-quarternary, #ccc); color: var(--fill-secondary, #555); }
.cra-assistant hr { border: none; border-top: 1px solid var(--fill-quinary, #ddd); margin: 10px 0; }
.cra-assistant a { color: var(--accent-blue, #4072e5); text-decoration: underline; cursor: pointer; }
.cra-assistant code { font-family: ui-monospace, Menlo, monospace; font-size: 12px; background: var(--fill-quinary, #eee); padding: 1px 4px; border-radius: 3px; }
.cra-assistant pre { font-family: ui-monospace, Menlo, monospace; font-size: 12px; background: var(--fill-quinary, #eee); padding: 8px; border-radius: 4px; overflow-x: auto; margin: 0 0 8px; }
.cra-assistant pre code { background: none; padding: 0; }
.cra-table-wrap { overflow-x: auto; margin: 0 0 8px; }
.cra-assistant table { border-collapse: collapse; font-size: 12px; min-width: 100%; }
.cra-assistant th, .cra-assistant td { border: 1px solid var(--fill-quarternary, #ccc); padding: 4px 8px; text-align: left; vertical-align: top; }
.cra-assistant th { background: var(--fill-quinary, #f0f0f0); font-weight: 600; }
.cra-assistant tbody tr:nth-child(even) td { background: color-mix(in srgb, var(--fill-quinary, #f0f0f0) 50%, transparent); }
.cra-pending::after { content: 'Thinking…'; color: var(--fill-secondary, #777); }
.cra-quote { display: flex; gap: 6px; align-items: flex-start; margin: 0 10px; padding: 6px 8px; font-size: 12px; border-inline-start: 3px solid var(--accent-blue, #4072e5); background: var(--material-background, #fff); }
.cra-quote[hidden] { display: none; }
.cra-quote-text { flex: 1; max-height: 80px; overflow-y: auto; white-space: pre-wrap; }
.cra-input-row { display: flex; gap: 6px; padding: 10px; align-items: flex-end; }
.cra-input { flex: 1; resize: none; font: inherit; padding: 6px; border-radius: 6px; border: 1px solid var(--fill-quarternary, #ccc); background: var(--material-background, #fff); color: inherit; }
.cra-button { font: inherit; font-size: 12px; padding: 3px 8px; border-radius: 5px; border: 1px solid var(--fill-quarternary, #ccc); background: var(--material-button, #fff); color: inherit; cursor: pointer; }
.cra-icon { padding: 0 6px; font-size: 15px; line-height: 20px; }
.cra-send { background: var(--accent-blue, #4072e5); color: #fff; border-color: transparent; }
.cra-send.cra-stop { background: #d9534f; }
`;
		(doc.head || doc.documentElement).append(style);
	},
};
