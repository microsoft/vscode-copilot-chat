(() => {
	function escapeHtml(value) {
		return value
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/\"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	const USER_AVATAR_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM3 13s0-4 5-4 5 4 5 4H3z"/></svg>';
	const COPILOT_AVATAR_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="white"><path d="M8 1L6.5 3.5H3L1 6.5L3 9.5L1 12.5L3 15H6.5L8 12.5L9.5 15H13L15 12.5L13 9.5L15 6.5L13 3.5H9.5L8 1ZM8 4L9 5.5H11L12 7L11 8.5L12 10L11 11.5H9L8 13L7 11.5H5L4 10L5 8.5L4 7L5 5.5H7L8 4Z"/></svg>';

	class ChatRenderer {
		constructor(container) {
			this.container = container;
			this.streamingTurns = new Map();
			this.historyCounter = 0;
			this.commandRunner = undefined;
			this.configureMarkdown();
		}

		setCommandRunner(commandRunner) {
			this.commandRunner = commandRunner;
		}

		configureMarkdown() {
			if (window.marked) {
				window.marked.setOptions({
					gfm: true,
					breaks: false,
					headerIds: false,
					mangle: false,
					highlight(code, lang) {
						if (!window.hljs) {
							return code;
						}
						if (lang && window.hljs.getLanguage(lang)) {
							return window.hljs.highlight(code, { language: lang }).value;
						}
						return window.hljs.highlightAuto(code).value;
					}
				});
			}
		}

		clear() {
			this.container.innerHTML = '';
			this.streamingTurns.clear();
		}

		showEmptyState(text) {
			this.clear();
			const state = document.createElement('div');
			state.className = 'empty-state';
			state.innerHTML = `<div class="copilot-logo">${COPILOT_AVATAR_SVG}</div><div>${escapeHtml(text)}</div>`;
			this.container.appendChild(state);
		}

		renderHistory(turns) {
			this.clear();
			if (!Array.isArray(turns) || turns.length === 0) {
				this.showEmptyState('No messages yet.');
				return;
			}

			for (const turn of turns) {
				if (turn.role === 'user') {
					this.appendUserTurn(turn.content);
				} else if (turn.role === 'assistant') {
					this.appendAssistantMessage(turn.content, turn.artifacts, turn.toolLines);
				}
			}
		}

		appendUserTurn(content) {
			if (!content) {
				return;
			}
			const row = this.createMessageRow('user');
			const textEl = document.createElement('div');
			textEl.className = 'user-text';
			textEl.textContent = content;
			row.contentHost.appendChild(textEl);
			this.container.appendChild(row.element);
			this.scrollToBottom();
		}

		appendAssistantMessage(content, artifacts, toolLines) {
			const hasContent = typeof content === 'string' && content.trim().length > 0;
			const hasToolLines = Array.isArray(toolLines) && toolLines.length > 0;
			const hasArtifacts = artifacts && typeof artifacts === 'object'
				&& (
					(Array.isArray(artifacts.statuses) && artifacts.statuses.length > 0)
					|| (Array.isArray(artifacts.tools) && artifacts.tools.length > 0)
					|| (Array.isArray(artifacts.confirmations) && artifacts.confirmations.length > 0)
					|| (Array.isArray(artifacts.questionCarousels) && artifacts.questionCarousels.length > 0)
					|| (Array.isArray(artifacts.commandButtons) && artifacts.commandButtons.length > 0)
					|| (Array.isArray(artifacts.extras) && artifacts.extras.length > 0)
					|| (Array.isArray(artifacts.references) && artifacts.references.length > 0)
					|| (Array.isArray(artifacts.codeCitations) && artifacts.codeCitations.length > 0)
				);

			if (!hasContent && !hasToolLines && !hasArtifacts) {
				return;
			}

			const turnId = `history-${this.historyCounter++}`;
			this.startAssistantTurn(turnId);
			if (hasToolLines) {
				this.appendHistoryToolLines(turnId, toolLines);
			}
			if (hasContent) {
				this.appendAssistantChunk(turnId, content);
			}
			if (hasArtifacts) {
				this.appendAssistantArtifacts(turnId, artifacts);
			}
			this.completeAssistantTurn(turnId);
		}

		startAssistantTurn(turnId) {
			let entry = this.streamingTurns.get(turnId);
			if (entry) {
				return entry;
			}

			const row = this.createMessageRow('assistant');
			row.element.classList.add('streaming');

			const historyToolLinesHost = document.createElement('div');
			historyToolLinesHost.className = 'assistant-history-tool-lines';
			row.contentHost.appendChild(historyToolLinesHost);

			const markdownHost = document.createElement('div');
			markdownHost.className = 'assistant-markdown';
			row.contentHost.appendChild(markdownHost);

			const artifactsHost = document.createElement('div');
			artifactsHost.className = 'assistant-artifacts';
			row.contentHost.appendChild(artifactsHost);

			const statusHost = document.createElement('div');
			statusHost.className = 'assistant-status';
			artifactsHost.appendChild(statusHost);

			const toolHost = document.createElement('div');
			toolHost.className = 'assistant-tools';
			artifactsHost.appendChild(toolHost);

			const confirmationHost = document.createElement('div');
			confirmationHost.className = 'assistant-confirmations';
			artifactsHost.appendChild(confirmationHost);

			const questionsHost = document.createElement('div');
			questionsHost.className = 'assistant-questions';
			artifactsHost.appendChild(questionsHost);

			const commandButtonsHost = document.createElement('div');
			commandButtonsHost.className = 'assistant-command-buttons';
			artifactsHost.appendChild(commandButtonsHost);

			const extrasHost = document.createElement('div');
			extrasHost.className = 'assistant-extras';
			artifactsHost.appendChild(extrasHost);

			const referenceHost = document.createElement('div');
			referenceHost.className = 'assistant-references';
			artifactsHost.appendChild(referenceHost);

			const citationHost = document.createElement('div');
			citationHost.className = 'assistant-citations';
			artifactsHost.appendChild(citationHost);

			this.container.appendChild(row.element);

			entry = {
				element: row.element,
				contentHost: row.contentHost,
				historyToolLinesHost,
				markdownHost,
				statusHost,
				toolHost,
				confirmationHost,
				questionsHost,
				commandButtonsHost,
				extrasHost,
				referenceHost,
				citationHost,
				markdown: '',
				statusKeys: new Set(),
				toolItems: new Map(),
				confirmationKeys: new Set(),
				questionKeys: new Set(),
				commandButtonKeys: new Set(),
				extraKeys: new Set(),
				editExtraItems: new Map(),
				referenceKeys: new Set(),
				citationKeys: new Set()
			};
			this.streamingTurns.set(turnId, entry);
			this.scrollToBottom();
			return entry;
		}

		appendHistoryToolLines(turnId, lines) {
			if (!Array.isArray(lines) || lines.length === 0) {
				return;
			}
			const entry = this.startAssistantTurn(turnId);
			for (const line of lines) {
				if (typeof line !== 'string' || !line.trim()) {
					continue;
				}
				const item = document.createElement('div');
				item.className = 'history-tool-line';
				item.textContent = line.trim();
				entry.historyToolLinesHost.appendChild(item);
			}
			this.scrollToBottom();
		}

		appendAssistantChunk(turnId, chunk) {
			if (!chunk) {
				return;
			}

			const entry = this.startAssistantTurn(turnId);
			entry.markdown += chunk;
			entry.markdownHost.innerHTML = this.renderMarkdown(entry.markdown);
			this.decorateCodeBlocks(entry.markdownHost);
			this.scrollToBottom();
		}

		appendAssistantReference(turnId, reference) {
			if (!reference || (typeof reference.label !== 'string' && typeof reference.uri !== 'string')) {
				return;
			}

			const entry = this.startAssistantTurn(turnId);
			const label = typeof reference.label === 'string' ? reference.label.trim() : '';
			const uri = typeof reference.uri === 'string' && reference.uri.trim().length > 0 ? reference.uri : '';
			if (!label && !uri) {
				return;
			}

			const key = `${label}::${uri}`;
			if (entry.referenceKeys.has(key)) {
				return;
			}
			entry.referenceKeys.add(key);

			const item = document.createElement('div');
			item.className = 'assistant-reference-item';

			const content = document.createElement(uri ? 'a' : 'span');
			content.className = 'assistant-reference-link';
			content.textContent = label || uri;
			if (uri) {
				content.href = uri;
				content.target = '_blank';
				content.rel = 'noopener noreferrer';
			}

			item.appendChild(content);
			entry.referenceHost.appendChild(item);
			this.scrollToBottom();
		}

		appendAssistantCodeCitation(turnId, citation) {
			if (!citation || typeof citation.uri !== 'string') {
				return;
			}

			const entry = this.startAssistantTurn(turnId);
			const license = typeof citation.license === 'string' ? citation.license : '';
			const snippet = typeof citation.snippet === 'string' ? citation.snippet : '';
			const key = `${citation.uri}::${license}::${snippet}`;
			if (entry.citationKeys.has(key)) {
				return;
			}
			entry.citationKeys.add(key);

			const item = document.createElement('div');
			item.className = 'assistant-citation-item';

			const meta = document.createElement('div');
			meta.className = 'assistant-citation-meta';

			const link = document.createElement('a');
			link.className = 'assistant-citation-link';
			link.href = citation.uri;
			link.target = '_blank';
			link.rel = 'noopener noreferrer';
			link.textContent = 'Code citation';
			meta.appendChild(link);

			if (license) {
				const badge = document.createElement('span');
				badge.className = 'assistant-citation-license';
				badge.textContent = license;
				meta.appendChild(badge);
			}

			item.appendChild(meta);

			if (snippet) {
				const snippetHost = document.createElement('pre');
				snippetHost.className = 'assistant-citation-snippet';
				const code = document.createElement('code');
				code.textContent = snippet;
				snippetHost.appendChild(code);
				item.appendChild(snippetHost);
			}

			entry.citationHost.appendChild(item);
			this.scrollToBottom();
		}

		appendAssistantArtifacts(turnId, artifacts) {
			if (!artifacts || typeof artifacts !== 'object') {
				return;
			}

			if (Array.isArray(artifacts.statuses)) {
				for (const status of artifacts.statuses) {
					this.appendAssistantStatus(turnId, status);
				}
			}

			if (Array.isArray(artifacts.tools)) {
				for (const tool of artifacts.tools) {
					this.appendAssistantToolInvocation(turnId, tool);
				}
			}

			if (Array.isArray(artifacts.confirmations)) {
				for (const confirmation of artifacts.confirmations) {
					this.appendAssistantConfirmation(turnId, confirmation);
				}
			}

			if (Array.isArray(artifacts.questionCarousels)) {
				for (const questionCarousel of artifacts.questionCarousels) {
					this.appendAssistantQuestions(turnId, questionCarousel);
				}
			}

			if (Array.isArray(artifacts.commandButtons)) {
				for (const commandButton of artifacts.commandButtons) {
					this.appendAssistantCommandButton(turnId, commandButton);
				}
			}

			if (Array.isArray(artifacts.extras)) {
				for (const extra of artifacts.extras) {
					this.appendAssistantExtra(turnId, extra);
				}
			}

			if (Array.isArray(artifacts.references)) {
				for (const reference of artifacts.references) {
					this.appendAssistantReference(turnId, reference);
				}
			}

			if (Array.isArray(artifacts.codeCitations)) {
				for (const citation of artifacts.codeCitations) {
					this.appendAssistantCodeCitation(turnId, citation);
				}
			}
		}

		appendAssistantStatus(turnId, status) {
			if (!status || typeof status.content !== 'string') {
				return;
			}

			const entry = this.startAssistantTurn(turnId);
			const content = status.content.trim();
			if (!content) {
				return;
			}

			const kind = typeof status.kind === 'string' ? status.kind : 'progress';
			const key = `${kind}::${content}`;
			if (entry.statusKeys.has(key)) {
				return;
			}
			entry.statusKeys.add(key);

			const item = document.createElement('div');
			item.className = `assistant-status-item assistant-status-${kind}`;

			const kindLabel = document.createElement('span');
			kindLabel.className = 'assistant-status-kind';
			kindLabel.textContent = kind;
			item.appendChild(kindLabel);

			const text = document.createElement('span');
			text.className = 'assistant-status-text';
			text.textContent = content;
			item.appendChild(text);

			entry.statusHost.appendChild(item);
			this.scrollToBottom();
		}

		appendAssistantToolInvocation(turnId, tool) {
			if (!tool || typeof tool.toolCallId !== 'string' || typeof tool.toolName !== 'string') {
				return;
			}

			const entry = this.startAssistantTurn(turnId);
			const toolCallId = tool.toolCallId.trim();
			const toolName = tool.toolName.trim();
			if (!toolCallId || !toolName) {
				return;
			}

			let item = entry.toolItems.get(toolCallId);
			if (!item) {
				item = document.createElement('div');
				item.className = 'assistant-tool-item';
				entry.toolItems.set(toolCallId, item);
				entry.toolHost.appendChild(item);
			}

			item.classList.toggle('is-error', Boolean(tool.isError));
			item.classList.toggle('is-complete', Boolean(tool.isComplete));

			const statusText = tool.isError ? 'error' : tool.isComplete ? 'done' : 'running';
			const summary = typeof tool.message === 'string' && tool.message.trim().length > 0
				? tool.message.trim()
				: `${toolName} (${statusText})`;

			item.textContent = `${toolName}: ${summary}`;
			this.scrollToBottom();
		}

		appendAssistantConfirmation(turnId, confirmation) {
			if (!confirmation || (typeof confirmation.title !== 'string' && typeof confirmation.message !== 'string')) {
				return;
			}

			const entry = this.startAssistantTurn(turnId);
			const title = typeof confirmation.title === 'string' ? confirmation.title.trim() : '';
			const message = typeof confirmation.message === 'string' ? confirmation.message.trim() : '';
			const buttons = Array.isArray(confirmation.buttons) ? confirmation.buttons : [];
			if (!title && !message && buttons.length === 0) {
				return;
			}

			const key = `${title}::${message}::${buttons.join('::')}`;
			if (entry.confirmationKeys.has(key)) {
				return;
			}
			entry.confirmationKeys.add(key);

			const item = document.createElement('div');
			item.className = 'assistant-confirmation-item';

			if (title) {
				const titleEl = document.createElement('div');
				titleEl.className = 'assistant-confirmation-title';
				titleEl.textContent = title;
				item.appendChild(titleEl);
			}

			if (message) {
				const messageEl = document.createElement('div');
				messageEl.className = 'assistant-confirmation-message';
				messageEl.textContent = message;
				item.appendChild(messageEl);
			}

			if (buttons.length > 0) {
				const buttonRow = document.createElement('div');
				buttonRow.className = 'assistant-confirmation-buttons';
				for (const buttonText of buttons) {
					const buttonEl = document.createElement('span');
					buttonEl.className = 'assistant-confirmation-button';
					buttonEl.textContent = buttonText;
					buttonRow.appendChild(buttonEl);
				}
				item.appendChild(buttonRow);
			}

			entry.confirmationHost.appendChild(item);
			this.scrollToBottom();
		}

		appendAssistantQuestions(turnId, questionCarousel) {
			if (!questionCarousel || !Array.isArray(questionCarousel.questions) || questionCarousel.questions.length === 0) {
				return;
			}

			const entry = this.startAssistantTurn(turnId);
			const key = JSON.stringify({
				allowSkip: Boolean(questionCarousel.allowSkip),
				questions: questionCarousel.questions,
			});
			if (entry.questionKeys.has(key)) {
				return;
			}
			entry.questionKeys.add(key);

			const item = document.createElement('div');
			item.className = 'assistant-questions-item';

			const titleEl = document.createElement('div');
			titleEl.className = 'assistant-questions-title';
			titleEl.textContent = questionCarousel.allowSkip ? 'Questions (optional)' : 'Questions';
			item.appendChild(titleEl);

			const list = document.createElement('ul');
			list.className = 'assistant-questions-list';
			for (const question of questionCarousel.questions) {
				if (!question || typeof question.title !== 'string') {
					continue;
				}

				const questionItem = document.createElement('li');
				questionItem.className = 'assistant-question-item';
				const questionTitle = document.createElement('div');
				questionTitle.className = 'assistant-question-title';
				questionTitle.textContent = `${question.title} (${question.type || 'unknown'})`;
				questionItem.appendChild(questionTitle);

				if (typeof question.message === 'string' && question.message.trim().length > 0) {
					const questionMessage = document.createElement('div');
					questionMessage.className = 'assistant-question-message';
					questionMessage.textContent = question.message;
					questionItem.appendChild(questionMessage);
				}

				if (Array.isArray(question.options) && question.options.length > 0) {
					const options = document.createElement('div');
					options.className = 'assistant-question-options';
					options.textContent = `Options: ${question.options.join(', ')}`;
					questionItem.appendChild(options);
				}

				list.appendChild(questionItem);
			}

			if (list.childNodes.length > 0) {
				item.appendChild(list);
			}

			entry.questionsHost.appendChild(item);
			this.scrollToBottom();
		}

		appendAssistantCommandButton(turnId, commandButton) {
			if (!commandButton || typeof commandButton.commandId !== 'string') {
				return;
			}

			const entry = this.startAssistantTurn(turnId);
			const commandId = commandButton.commandId.trim();
			if (!commandId) {
				return;
			}

			const title = typeof commandButton.title === 'string' && commandButton.title.trim().length > 0
				? commandButton.title.trim()
				: commandId;
			const args = Array.isArray(commandButton.args) ? [...commandButton.args] : undefined;
			const key = `${commandId}::${title}::${JSON.stringify(args ?? [])}`;
			if (entry.commandButtonKeys.has(key)) {
				return;
			}
			entry.commandButtonKeys.add(key);

			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'assistant-command-button';
			button.textContent = title;
			button.addEventListener('click', () => {
				if (typeof this.commandRunner === 'function') {
					this.commandRunner({ commandId, args });
				}
			});

			entry.commandButtonsHost.appendChild(button);
			this.scrollToBottom();
		}

		appendAssistantExtra(turnId, extra) {
			if (!extra || typeof extra.kind !== 'string') {
				return;
			}

			const entry = this.startAssistantTurn(turnId);
			if (extra.kind === 'textEdit' || extra.kind === 'notebookEdit') {
				if (typeof extra.uri !== 'string') {
					return;
				}

				const key = `${extra.kind}::${extra.uri}`;
				let item = entry.editExtraItems.get(key);
				if (!item) {
					item = document.createElement('div');
					item.className = 'assistant-extra-item';
					entry.editExtraItems.set(key, item);
					entry.extrasHost.appendChild(item);
				}

				const kindLabel = extra.kind === 'textEdit' ? 'Text edits' : 'Notebook edits';
				const editCount = Number.isFinite(extra.editCount) ? extra.editCount : 0;
				const countLabel = `${editCount} ${editCount === 1 ? 'edit' : 'edits'}`;
				const doneSuffix = extra.isDone ? ', done' : '';
				item.textContent = `${kindLabel}: ${this.uriLabel(extra.uri)} (${countLabel}${doneSuffix})`;
				item.classList.toggle('is-complete', Boolean(extra.isDone));
				this.scrollToBottom();
				return;
			}

			const key = JSON.stringify(extra);
			if (entry.extraKeys.has(key)) {
				return;
			}
			entry.extraKeys.add(key);

			const item = document.createElement('div');
			item.className = 'assistant-extra-item';

			switch (extra.kind) {
				case 'anchor': {
					const label = typeof extra.label === 'string' && extra.label.trim().length > 0
						? extra.label.trim()
						: (typeof extra.uri === 'string' ? this.uriLabel(extra.uri) : 'Anchor');
					if (typeof extra.uri === 'string' && extra.uri.trim().length > 0) {
						const link = document.createElement('a');
						link.className = 'assistant-reference-link';
						link.href = extra.uri;
						link.target = '_blank';
						link.rel = 'noopener noreferrer';
						link.textContent = label;
						item.appendChild(link);
					} else {
						item.textContent = label;
					}
					break;
				}
				case 'fileTree': {
					const title = document.createElement('div');
					title.className = 'assistant-extra-title';
					title.textContent = `File tree (${this.uriLabel(extra.baseUri)})`;
					item.appendChild(title);

					const tree = document.createElement('pre');
					tree.className = 'assistant-extra-tree';
					tree.textContent = extra.tree;
					item.appendChild(tree);
					break;
				}
				case 'codeblockUri': {
					const link = document.createElement('a');
					link.className = 'assistant-reference-link';
					link.href = extra.uri;
					link.target = '_blank';
					link.rel = 'noopener noreferrer';
					const prefix = extra.isEdit ? 'Edited file' : 'File';
					link.textContent = `${prefix}: ${this.uriLabel(extra.uri)}`;
					item.appendChild(link);
					break;
				}
				case 'workspaceEdit': {
					const edits = Array.isArray(extra.edits) ? extra.edits : [];
					const operations = edits.map(edit => {
						if (typeof edit.oldUri === 'string' && typeof edit.newUri === 'string') {
							return `Rename ${this.uriLabel(edit.oldUri)} -> ${this.uriLabel(edit.newUri)}`;
						}

						if (typeof edit.newUri === 'string') {
							return `Create ${this.uriLabel(edit.newUri)}`;
						}

						if (typeof edit.oldUri === 'string') {
							return `Delete ${this.uriLabel(edit.oldUri)}`;
						}

						return '';
					}).filter(Boolean);
					if (operations.length === 0) {
						return;
					}

					item.textContent = `Workspace edit: ${operations.join('; ')}`;
					break;
				}
				case 'move': {
					const range = extra.startLine === extra.endLine
						? `#L${extra.startLine}`
						: `#L${extra.startLine}-${extra.endLine}`;
					const link = document.createElement('a');
					link.className = 'assistant-reference-link';
					link.href = extra.uri;
					link.target = '_blank';
					link.rel = 'noopener noreferrer';
					link.textContent = `Move target: ${this.uriLabel(extra.uri)}${range}`;
					item.appendChild(link);
					break;
				}
				case 'extensions': {
					if (!Array.isArray(extra.extensions) || extra.extensions.length === 0) {
						return;
					}

					item.textContent = `Suggested extensions: ${extra.extensions.join(', ')}`;
					break;
				}
				case 'pullRequest': {
					const title = typeof extra.title === 'string' ? extra.title.trim() : '';
					const description = typeof extra.description === 'string' ? extra.description.trim() : '';
					const author = typeof extra.author === 'string' ? extra.author.trim() : '';
					const linkTag = typeof extra.linkTag === 'string' ? extra.linkTag.trim() : '';

					const titleEl = document.createElement('div');
					titleEl.className = 'assistant-extra-title';
					titleEl.textContent = title || 'Pull request';
					item.appendChild(titleEl);

					const meta = [];
					if (author) {
						meta.push(`author: ${author}`);
					}
					if (linkTag) {
						meta.push(linkTag);
					}
					if (meta.length > 0) {
						const metaEl = document.createElement('div');
						metaEl.className = 'assistant-extra-meta';
						metaEl.textContent = meta.join(' • ');
						item.appendChild(metaEl);
					}

					if (description) {
						const descriptionEl = document.createElement('div');
						descriptionEl.className = 'assistant-extra-description';
						descriptionEl.textContent = description;
						item.appendChild(descriptionEl);
					}

					if (typeof extra.commandId === 'string' && extra.commandId.trim().length > 0 && typeof this.commandRunner === 'function') {
						const openButton = document.createElement('button');
						openButton.type = 'button';
						openButton.className = 'assistant-command-button';
						openButton.textContent = 'Open pull request';
						openButton.addEventListener('click', () => {
							this.commandRunner({
								commandId: extra.commandId,
								args: Array.isArray(extra.commandArgs) ? extra.commandArgs : undefined,
							});
						});
						item.appendChild(openButton);
					}
					break;
				}
				case 'externalEdit': {
					const uris = Array.isArray(extra.uris) ? extra.uris : [];
					if (uris.length === 0) {
						return;
					}

					item.textContent = `External edits applied: ${uris.map(uri => this.uriLabel(uri)).join(', ')}`;
					break;
				}
				case 'multiDiff': {
					const title = typeof extra.title === 'string' && extra.title.trim().length > 0
						? extra.title.trim()
						: 'Changes';
					const entries = Array.isArray(extra.entries) ? extra.entries : [];

					const titleEl = document.createElement('div');
					titleEl.className = 'assistant-extra-title';
					titleEl.textContent = `Multi diff: ${title}`;
					item.appendChild(titleEl);

					if (entries.length > 0) {
						const summaryEl = document.createElement('div');
						summaryEl.className = 'assistant-extra-meta';
						summaryEl.textContent = `${entries.length} ${entries.length === 1 ? 'file' : 'files'}${extra.readOnly ? ' • read-only' : ''}`;
						item.appendChild(summaryEl);

						const listEl = document.createElement('ul');
						listEl.className = 'assistant-extra-list';
						for (const diffEntry of entries) {
							const listItem = document.createElement('li');
							listItem.className = 'assistant-extra-list-item';
							const sourceUri = typeof diffEntry.modifiedUri === 'string'
								? diffEntry.modifiedUri
								: typeof diffEntry.originalUri === 'string'
									? diffEntry.originalUri
									: diffEntry.goToFileUri;
							if (typeof sourceUri === 'string') {
								let label = this.uriLabel(sourceUri);
								const changes = [];
								if (typeof diffEntry.added === 'number') {
									changes.push(`+${diffEntry.added}`);
								}
								if (typeof diffEntry.removed === 'number') {
									changes.push(`-${diffEntry.removed}`);
								}
								if (changes.length > 0) {
									label = `${label} (${changes.join(' ')})`;
								}
								listItem.textContent = label;
								listEl.appendChild(listItem);
							}
						}

						if (listEl.childNodes.length > 0) {
							item.appendChild(listEl);
						}
					}
					break;
				}
				default:
					return;
			}

			entry.extrasHost.appendChild(item);
			this.scrollToBottom();
		}

		completeAssistantTurn(turnId) {
			const entry = this.streamingTurns.get(turnId);
			if (!entry) {
				return;
			}
			entry.element.classList.remove('streaming');
			this.decorateCodeBlocks(entry.markdownHost);
			this.streamingTurns.delete(turnId);
			this.scrollToBottom();
		}

		renderMarkdown(markdownText) {
			if (!window.marked) {
				return `<pre>${escapeHtml(markdownText)}</pre>`;
			}
			return window.marked.parse(markdownText);
		}

		uriLabel(uri) {
			if (typeof uri !== 'string') {
				return '';
			}

			try {
				const parsed = new URL(uri);
				const segments = parsed.pathname.split('/').filter(Boolean);
				return segments[segments.length - 1] || parsed.pathname || uri;
			} catch {
				const segments = uri.split('/').filter(Boolean);
				return segments[segments.length - 1] || uri;
			}
		}

		decorateCodeBlocks(container) {
			const blocks = container.querySelectorAll('pre');
			for (const block of blocks) {
				if (block.querySelector('.code-header')) {
					continue;
				}

				const code = block.querySelector('code');
				if (!code) {
					continue;
				}

				// Detect language from class
				let language = '';
				for (const cls of code.classList) {
					if (cls.startsWith('language-')) {
						language = cls.replace('language-', '');
						break;
					} else if (cls.startsWith('hljs')) {
						continue;
					}
				}

				const header = document.createElement('div');
				header.className = 'code-header';

				const langLabel = document.createElement('span');
				langLabel.className = 'code-language';
				langLabel.textContent = language || 'text';
				header.appendChild(langLabel);

				const copyButton = document.createElement('button');
				copyButton.type = 'button';
				copyButton.className = 'copy-code';
				copyButton.textContent = 'Copy';
				copyButton.addEventListener('click', async () => {
					try {
						await navigator.clipboard.writeText(code.textContent || '');
						copyButton.textContent = 'Copied!';
						window.setTimeout(() => {
							copyButton.textContent = 'Copy';
						}, 1200);
					} catch {
						copyButton.textContent = 'Error';
						window.setTimeout(() => {
							copyButton.textContent = 'Copy';
						}, 1200);
					}
				});
				header.appendChild(copyButton);

				block.insertBefore(header, block.firstChild);
			}
		}

		createMessageRow(role) {
			const row = document.createElement('div');
			row.className = `chat-message ${role}-message`;

			const avatar = document.createElement('div');
			avatar.className = `chat-avatar ${role === 'assistant' ? 'copilot-avatar' : ''}`;
			avatar.innerHTML = role === 'assistant' ? COPILOT_AVATAR_SVG : USER_AVATAR_SVG;
			row.appendChild(avatar);

			const content = document.createElement('div');
			content.className = 'chat-content';

			const senderName = document.createElement('span');
			senderName.className = `sender-name ${role === 'assistant' ? 'copilot' : ''}`;
			senderName.textContent = role === 'assistant' ? 'Copilot' : 'You';
			content.appendChild(senderName);

			const contentHost = document.createElement('div');
			contentHost.className = role === 'assistant' ? 'assistant-content' : '';
			content.appendChild(contentHost);

			row.appendChild(content);

			return { element: row, contentHost };
		}

		scrollToBottom() {
			window.requestAnimationFrame(() => {
				this.container.scrollTop = this.container.scrollHeight;
			});
		}
	}

	window.ChatRenderer = ChatRenderer;
})();
