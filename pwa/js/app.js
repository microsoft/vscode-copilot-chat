(() => {
	const statusEl = document.getElementById('connection-status');
	const bannerEl = document.getElementById('connection-banner');
	const messagesEl = document.getElementById('messages');
	const conversationListEl = document.getElementById('conversation-list');
	const conversationPanelEl = document.getElementById('conversation-panel');
	const toggleConversationsEl = document.getElementById('toggle-conversations');
	const refreshConversationsEl = document.getElementById('refresh-conversations');
	const newChatEl = document.getElementById('new-chat');
	const composerEl = document.getElementById('composer');
	const modeSelectorEl = document.getElementById('mode-selector');
	const modelSelectorEl = document.getElementById('model-selector');
	const chatTitleEl = document.getElementById('chat-title');
	const attachFileEl = document.getElementById('attach-file');
	const attachSelectionEl = document.getElementById('attach-selection');
	const openModelPickerEl = document.getElementById('open-model-picker');
	const promptInputEl = document.getElementById('prompt-input');
	const conversationSearchEl = document.getElementById('conversation-search');
	const providerFilterEl = document.getElementById('provider-filter');
	const statusFilterEl = document.getElementById('status-filter');
	const clearFiltersEl = document.getElementById('clear-filters');

	const FILTER_REFRESH_DEBOUNCE_MS = 180;
	const DEFAULT_CHAT_TITLE = 'Copilot';

	// Create overlay for mobile sidebar
	const sidebarOverlay = document.createElement('div');
	sidebarOverlay.className = 'sidebar-overlay';
	document.getElementById('app').appendChild(sidebarOverlay);

	const renderer = new window.ChatRenderer(messagesEl);

	const state = {
		client: undefined,
		currentConversationId: undefined,
		conversations: [],
		optimisticByConversation: new Map(),
		pendingOptimisticContent: undefined,
		isComposingNewConversation: false,
		conversationFilter: {
			search: '',
			provider: '',
			status: '',
		},
		filterRefreshTimer: undefined,
		uiState: {
			modes: [],
			selectedModeId: undefined,
			models: [],
			selectedModelId: undefined,
		},
	};

	renderer.setCommandRunner(command => {
		if (!state.client || !command || typeof command.commandId !== 'string') {
			return;
		}

		state.client.send({
			type: 'ui:command',
			commandId: command.commandId,
			args: Array.isArray(command.args) ? command.args : undefined,
		});
	});

	function normalizeEndpoint(rawWsUrl, rawToken) {
		const wsUrl = typeof rawWsUrl === 'string' ? rawWsUrl.trim() : '';
		const token = typeof rawToken === 'string' ? rawToken.trim() : '';
		if (!wsUrl || !token) {
			return undefined;
		}
		return { wsUrl, token };
	}

	function parseQueryParams() {
		const params = new URLSearchParams(window.location.search);
		const queryEndpoint = normalizeEndpoint(params.get('ws'), params.get('token'));
		if (queryEndpoint) {
			window.localStorage.setItem('sidecar.wsUrl', queryEndpoint.wsUrl);
			window.localStorage.setItem('sidecar.token', queryEndpoint.token);
			return queryEndpoint;
		}

		const storedEndpoint = normalizeEndpoint(
			window.localStorage.getItem('sidecar.wsUrl'),
			window.localStorage.getItem('sidecar.token')
		);
		if (storedEndpoint) {
			return storedEndpoint;
		}

		const pairingInput = window.prompt('Paste the Sidecar pairing URL from VS Code');
		if (!pairingInput) {
			return undefined;
		}

		try {
			const pairingUrl = new URL(pairingInput);
			const parsedEndpoint = normalizeEndpoint(pairingUrl.searchParams.get('ws'), pairingUrl.searchParams.get('token'));
			if (parsedEndpoint) {
				window.localStorage.setItem('sidecar.wsUrl', parsedEndpoint.wsUrl);
				window.localStorage.setItem('sidecar.token', parsedEndpoint.token);
				return parsedEndpoint;
			}
		} catch {
			// No-op: invalid URL entered.
		}

		return undefined;
	}

	function formatRelativeTime(timestamp) {
		if (!timestamp) {
			return 'Unknown';
		}
		const deltaMs = Date.now() - timestamp;
		const deltaSec = Math.floor(deltaMs / 1000);
		if (deltaSec < 60) {
			return 'Now';
		}
		const deltaMin = Math.floor(deltaSec / 60);
		if (deltaMin < 60) {
			return `${deltaMin}m ago`;
		}
		const deltaHours = Math.floor(deltaMin / 60);
		if (deltaHours < 24) {
			return `${deltaHours}h ago`;
		}
		const deltaDays = Math.floor(deltaHours / 24);
		return `${deltaDays}d ago`;
	}

	function connectionStatusText(stateName, detail) {
		switch (stateName) {
			case 'connected':
				return 'Connected';
			case 'reconnecting': {
				if (detail && typeof detail.delayMs === 'number') {
					return `Reconnecting (${Math.ceil(detail.delayMs / 1000)}s)`;
				}
				return 'Reconnecting';
			}
			case 'disconnected':
				return 'Disconnected';
			default:
				return 'Connecting';
		}
	}

	function setStatus(stateName, detail) {
		statusEl.textContent = connectionStatusText(stateName, detail);
		statusEl.classList.remove('status-connecting', 'status-connected', 'status-reconnecting', 'status-disconnected');
		switch (stateName) {
			case 'connected':
				statusEl.classList.add('status-connected');
				break;
			case 'reconnecting':
				statusEl.classList.add('status-reconnecting');
				break;
			case 'disconnected':
				statusEl.classList.add('status-disconnected');
				break;
			default:
				statusEl.classList.add('status-connecting');
		}
	}

	function showBanner(text, timeoutMs = 1400) {
		bannerEl.textContent = text;
		bannerEl.classList.remove('hidden');
		window.setTimeout(() => {
			bannerEl.classList.add('hidden');
		}, timeoutMs);
	}

	function normalizeFilterValue(value) {
		if (typeof value !== 'string') {
			return '';
		}

		return value.trim().toLowerCase();
	}

	function hasActiveConversationFilters() {
		return state.conversationFilter.search.length > 0
			|| state.conversationFilter.provider.length > 0
			|| state.conversationFilter.status.length > 0;
	}

	function updateFilterClearButtonState() {
		if (!clearFiltersEl) {
			return;
		}

		const hasFilters = hasActiveConversationFilters();
		clearFiltersEl.classList.toggle('active', hasFilters);
		clearFiltersEl.disabled = !hasFilters;
	}

	function syncConversationFiltersFromInputs() {
		state.conversationFilter.search = normalizeFilterValue(conversationSearchEl?.value);
		state.conversationFilter.provider = normalizeFilterValue(providerFilterEl?.value);
		state.conversationFilter.status = normalizeFilterValue(statusFilterEl?.value);
		updateFilterClearButtonState();
	}

	function buildConversationFilterPayload() {
		const filter = {};
		if (state.conversationFilter.provider) {
			filter.providers = [state.conversationFilter.provider];
		}
		if (state.conversationFilter.status) {
			filter.statuses = [state.conversationFilter.status];
		}
		if (state.conversationFilter.search) {
			filter.search = state.conversationFilter.search;
		}

		return Object.keys(filter).length > 0 ? filter : undefined;
	}

	function requestConversationList() {
		if (!state.client) {
			return;
		}

		state.client.requestConversationList(buildConversationFilterPayload());
	}

	function scheduleConversationListRefresh() {
		if (state.filterRefreshTimer !== undefined) {
			window.clearTimeout(state.filterRefreshTimer);
		}

		state.filterRefreshTimer = window.setTimeout(() => {
			state.filterRefreshTimer = undefined;
			requestConversationList();
		}, FILTER_REFRESH_DEBOUNCE_MS);
	}

	function ensureConversation(conversationId, fallbackTitle) {
		let conversation = state.conversations.find(item => item.id === conversationId);
		if (conversation) {
			return conversation;
		}
		conversation = {
			id: conversationId,
			title: fallbackTitle || 'Untitled conversation',
			lastUpdated: Date.now(),
		};
		state.conversations.unshift(conversation);
		renderConversationList();
		return conversation;
	}

	function updateConversation(conversationId, fields = {}) {
		const conversation = ensureConversation(conversationId, fields.title || 'Untitled conversation');
		Object.assign(conversation, fields);
		state.conversations.sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0));
		renderConversationList();
	}

	function renderConversationList() {
		conversationListEl.innerHTML = '';
		if (state.conversations.length === 0) {
			const empty = document.createElement('li');
			empty.className = 'empty-state';
			empty.textContent = hasActiveConversationFilters()
				? 'No conversations match current filters.'
				: 'No conversations yet.';
			conversationListEl.appendChild(empty);
			return;
		}

		for (const conversation of state.conversations) {
			const item = document.createElement('li');
			item.className = `conversation-item${conversation.id === state.currentConversationId ? ' active' : ''}`;
			item.tabIndex = 0;
			item.setAttribute('role', 'button');
			item.dataset.conversationId = conversation.id;

			const title = document.createElement('div');
			title.className = 'conversation-title';
			title.textContent = conversation.title || 'Untitled conversation';
			item.appendChild(title);

			const time = document.createElement('div');
			time.className = 'conversation-time';
			time.textContent = formatRelativeTime(conversation.lastUpdated);
			item.appendChild(time);

			item.addEventListener('click', () => {
				selectConversation(conversation.id);
			});
			item.addEventListener('keydown', event => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					selectConversation(conversation.id);
				}
			});

			conversationListEl.appendChild(item);
		}
	}

	function renderSelector(selectEl, options, selectedId, fallbackLabel) {
		if (!selectEl) {
			return;
		}

		selectEl.innerHTML = '';
		if (!Array.isArray(options) || options.length === 0) {
			const option = document.createElement('option');
			option.value = '';
			option.textContent = fallbackLabel;
			selectEl.appendChild(option);
			selectEl.disabled = true;
			return;
		}

		for (const item of options) {
			const option = document.createElement('option');
			option.value = item.id;
			option.textContent = item.label;
			selectEl.appendChild(option);
		}

		const resolvedValue = selectedId && options.some(item => item.id === selectedId)
			? selectedId
			: options[0].id;
		selectEl.value = resolvedValue;
		selectEl.disabled = false;
	}

	function updateChatTitle(workspaceLabel) {
		if (!chatTitleEl) {
			return;
		}

		const label = typeof workspaceLabel === 'string' && workspaceLabel.trim().length > 0
			? workspaceLabel.trim()
			: DEFAULT_CHAT_TITLE;
		chatTitleEl.textContent = label;
		chatTitleEl.title = label;
	}

	function handleUiState(message) {
		state.uiState = {
			modes: Array.isArray(message.modes) ? message.modes : [],
			selectedModeId: typeof message.selectedModeId === 'string' ? message.selectedModeId : undefined,
			models: Array.isArray(message.models) ? message.models : [],
			selectedModelId: typeof message.selectedModelId === 'string' ? message.selectedModelId : undefined,
		};

		renderSelector(modeSelectorEl, state.uiState.modes, state.uiState.selectedModeId, 'Mode');
		renderSelector(modelSelectorEl, state.uiState.models, state.uiState.selectedModelId, 'Model');
		updateChatTitle(message.workspaceLabel);
	}

	function queueOptimisticMessage(conversationId, content) {
		const queue = state.optimisticByConversation.get(conversationId) || [];
		queue.push(content);
		state.optimisticByConversation.set(conversationId, queue);
	}

	function consumeOptimisticMessage(conversationId, content) {
		const queue = state.optimisticByConversation.get(conversationId);
		if (!queue || queue.length === 0) {
			return false;
		}
		if (queue[0] === content) {
			queue.shift();
			if (queue.length === 0) {
				state.optimisticByConversation.delete(conversationId);
			}
			return true;
		}
		return false;
	}

	function selectConversation(conversationId) {
		state.currentConversationId = conversationId;
		state.isComposingNewConversation = false;
		renderConversationList();
		renderer.showEmptyState('Loading conversation...');
		if (state.client) {
			state.client.send({ type: 'conversation:select', conversationId });
		}
		closeSidebar();
	}

	function handleConversationList(message) {
		if (!Array.isArray(message.conversations)) {
			return;
		}

		state.conversations = message.conversations
			.map(conversation => ({
				id: conversation.id,
				title: conversation.title,
				lastUpdated: conversation.lastUpdated,
			}))
			.sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0));

		renderConversationList();

		if (!state.currentConversationId && state.conversations.length === 0) {
			renderer.showEmptyState(hasActiveConversationFilters()
				? 'No conversations match your filters. Clear filters to view all sessions.'
				: 'No conversations yet. Start a new chat below.');
			return;
		}

		if (!state.currentConversationId && state.conversations.length > 0 && !state.isComposingNewConversation) {
			selectConversation(state.conversations[0].id);
		}
	}

	function handleConversationHistory(message) {
		if (!message || message.conversationId !== state.currentConversationId) {
			return;
		}
		renderer.renderHistory(message.turns);
	}

	function handleIncomingUserTurn(message) {
		if (!state.currentConversationId) {
			state.currentConversationId = message.conversationId;
			state.isComposingNewConversation = false;
			if (state.pendingOptimisticContent) {
				queueOptimisticMessage(message.conversationId, state.pendingOptimisticContent);
				state.pendingOptimisticContent = undefined;
			}
			renderConversationList();
		}

		updateConversation(message.conversationId, {
			lastUpdated: Date.now(),
		});

		if (message.conversationId !== state.currentConversationId) {
			return;
		}
		if (consumeOptimisticMessage(message.conversationId, message.content)) {
			return;
		}
		renderer.appendUserTurn(message.content);
	}

	function handleIncomingAssistantStart(message) {
		if (!state.currentConversationId && state.isComposingNewConversation) {
			state.currentConversationId = message.conversationId;
			state.isComposingNewConversation = false;
			renderConversationList();
		}
		updateConversation(message.conversationId, { lastUpdated: Date.now() });
		if (message.conversationId === state.currentConversationId) {
			renderer.startAssistantTurn(message.turnId);
		}
	}

	function handleIncomingAssistantChunk(message) {
		if (message.conversationId === state.currentConversationId) {
			renderer.appendAssistantChunk(message.turnId, message.content);
		}
	}

	function handleIncomingAssistantReference(message) {
		if (message.conversationId === state.currentConversationId) {
			renderer.appendAssistantReference(message.turnId, {
				label: message.label,
				uri: message.uri,
			});
		}
	}

	function handleIncomingAssistantCodeCitation(message) {
		if (message.conversationId === state.currentConversationId) {
			renderer.appendAssistantCodeCitation(message.turnId, {
				uri: message.uri,
				license: message.license,
				snippet: message.snippet,
			});
		}
	}

	function handleIncomingAssistantStatus(message) {
		if (message.conversationId === state.currentConversationId) {
			renderer.appendAssistantStatus(message.turnId, {
				kind: message.kind,
				content: message.content,
			});
		}
	}

	function handleIncomingAssistantToolInvocation(message) {
		if (message.conversationId === state.currentConversationId) {
			renderer.appendAssistantToolInvocation(message.turnId, {
				toolName: message.toolName,
				toolCallId: message.toolCallId,
				message: message.message,
				isError: message.isError,
				isComplete: message.isComplete,
			});
		}
	}

	function handleIncomingAssistantConfirmation(message) {
		if (message.conversationId === state.currentConversationId) {
			renderer.appendAssistantConfirmation(message.turnId, {
				title: message.title,
				message: message.message,
				buttons: message.buttons,
			});
		}
	}

	function handleIncomingAssistantQuestions(message) {
		if (message.conversationId === state.currentConversationId) {
			renderer.appendAssistantQuestions(message.turnId, {
				allowSkip: message.allowSkip,
				questions: message.questions,
			});
		}
	}

	function handleIncomingAssistantCommandButton(message) {
		if (message.conversationId === state.currentConversationId) {
			renderer.appendAssistantCommandButton(message.turnId, {
				commandId: message.commandId,
				title: message.title,
				args: message.args,
			});
		}
	}

	function handleIncomingAssistantExtra(message) {
		if (message.conversationId === state.currentConversationId) {
			renderer.appendAssistantExtra(message.turnId, message.extra);
		}
	}

	function handleIncomingAssistantComplete(message) {
		updateConversation(message.conversationId, { lastUpdated: Date.now() });
		if (message.conversationId === state.currentConversationId) {
			renderer.completeAssistantTurn(message.turnId);
		}
	}

	function handleBridgeMessage(message) {
		if (!message || typeof message.type !== 'string') {
			return;
		}

		switch (message.type) {
			case 'conversation:list':
				handleConversationList(message);
				break;
			case 'ui:state':
				handleUiState(message);
				break;
			case 'conversation:history':
				handleConversationHistory(message);
				break;
			case 'turn:user':
				handleIncomingUserTurn(message);
				break;
			case 'turn:start':
				handleIncomingAssistantStart(message);
				break;
			case 'turn:chunk':
				handleIncomingAssistantChunk(message);
				break;
			case 'turn:reference':
				handleIncomingAssistantReference(message);
				break;
			case 'turn:codeCitation':
				handleIncomingAssistantCodeCitation(message);
				break;
			case 'turn:status':
				handleIncomingAssistantStatus(message);
				break;
			case 'turn:tool':
				handleIncomingAssistantToolInvocation(message);
				break;
			case 'turn:confirmation':
				handleIncomingAssistantConfirmation(message);
				break;
			case 'turn:questions':
				handleIncomingAssistantQuestions(message);
				break;
			case 'turn:button':
				handleIncomingAssistantCommandButton(message);
				break;
			case 'turn:extra':
				handleIncomingAssistantExtra(message);
				break;
			case 'turn:complete':
				handleIncomingAssistantComplete(message);
				break;
		}
	}

	function submitPrompt() {
		if (!state.client) {
			return;
		}

		const content = promptInputEl.value.trim();
		if (!content) {
			return;
		}

		const conversationId = state.currentConversationId;

		renderer.appendUserTurn(content);
		if (conversationId) {
			queueOptimisticMessage(conversationId, content);
			updateConversation(conversationId, {
				lastUpdated: Date.now(),
			});
		} else {
			state.pendingOptimisticContent = content;
			state.isComposingNewConversation = true;
		}
		state.client.send({ type: 'prompt:submit', content, conversationId });
		promptInputEl.value = '';
		promptInputEl.style.height = 'auto';
	}

	function isMobileEnterNewlinePreferred() {
		if (typeof navigator.userAgentData?.mobile === 'boolean') {
			return navigator.userAgentData.mobile;
		}

		const userAgent = navigator.userAgent || '';
		return /(android|iphone|ipad|ipod|iemobile|opera mini|mobile)/i.test(userAgent);
	}

	function initializeComposer() {
		promptInputEl.addEventListener('input', () => {
			promptInputEl.style.height = 'auto';
			promptInputEl.style.height = `${Math.min(promptInputEl.scrollHeight, 200)}px`;
		});

		// Desktop: Enter sends, Shift+Enter inserts newline. Mobile: Enter inserts newline.
		promptInputEl.addEventListener('keydown', event => {
			if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !isMobileEnterNewlinePreferred()) {
				event.preventDefault();
				submitPrompt();
			}
		});

		composerEl.addEventListener('submit', event => {
			event.preventDefault();
			submitPrompt();
		});

		if (modeSelectorEl) {
			modeSelectorEl.addEventListener('change', () => {
				if (!state.client || !modeSelectorEl.value) {
					return;
				}
				state.client.send({ type: 'ui:mode:set', modeId: modeSelectorEl.value });
			});
		}

		if (modelSelectorEl) {
			modelSelectorEl.addEventListener('change', () => {
				if (!state.client || !modelSelectorEl.value) {
					return;
				}
				state.client.send({ type: 'ui:model:set', modelId: modelSelectorEl.value });
			});
		}

		if (attachFileEl) {
			attachFileEl.addEventListener('click', () => {
				state.client?.send({ type: 'ui:command', commandId: 'workbench.action.chat.attachFile' });
			});
		}

		if (attachSelectionEl) {
			attachSelectionEl.addEventListener('click', () => {
				state.client?.send({ type: 'ui:command', commandId: 'workbench.action.chat.attachSelection' });
			});
		}

		if (openModelPickerEl) {
			openModelPickerEl.addEventListener('click', () => {
				state.client?.send({ type: 'ui:command', commandId: 'github.copilot.chat.openModelPicker' });
			});
		}
	}

	function openSidebar() {
		conversationPanelEl.classList.add('open');
		sidebarOverlay.classList.add('visible');
	}

	function closeSidebar() {
		conversationPanelEl.classList.remove('open');
		sidebarOverlay.classList.remove('visible');
	}

	function initializeConversationPanel() {
		toggleConversationsEl.addEventListener('click', () => {
			if (conversationPanelEl.classList.contains('open')) {
				closeSidebar();
			} else {
				openSidebar();
			}
		});
		sidebarOverlay.addEventListener('click', () => {
			closeSidebar();
		});
		refreshConversationsEl.addEventListener('click', () => {
			requestConversationList();
		});
		if (newChatEl) {
			newChatEl.addEventListener('click', () => {
				state.currentConversationId = undefined;
				state.pendingOptimisticContent = undefined;
				state.isComposingNewConversation = true;
				renderConversationList();
				renderer.showEmptyState('Start a new conversation by typing a message.');
				promptInputEl.focus();
				closeSidebar();
			});
		}
	}

	function initializeConversationFilters() {
		syncConversationFiltersFromInputs();

		if (conversationSearchEl) {
			conversationSearchEl.addEventListener('input', () => {
				syncConversationFiltersFromInputs();
				scheduleConversationListRefresh();
			});

			conversationSearchEl.addEventListener('keydown', event => {
				if (event.key !== 'Enter') {
					return;
				}

				event.preventDefault();
				syncConversationFiltersFromInputs();
				requestConversationList();
			});
		}

		if (providerFilterEl) {
			providerFilterEl.addEventListener('change', () => {
				syncConversationFiltersFromInputs();
				requestConversationList();
			});
		}

		if (statusFilterEl) {
			statusFilterEl.addEventListener('change', () => {
				syncConversationFiltersFromInputs();
				requestConversationList();
			});
		}

		if (clearFiltersEl) {
			clearFiltersEl.addEventListener('click', () => {
				if (conversationSearchEl) {
					conversationSearchEl.value = '';
				}
				if (providerFilterEl) {
					providerFilterEl.value = '';
				}
				if (statusFilterEl) {
					statusFilterEl.value = '';
				}

				syncConversationFiltersFromInputs();
				requestConversationList();
			});
		}

		updateFilterClearButtonState();
	}

	function initializeServiceWorker() {
		if (!('serviceWorker' in navigator)) {
			return;
		}
		window.addEventListener('load', () => {
			navigator.serviceWorker.register('./sw.js').catch(() => {
				// Ignore registration failures in restricted environments.
			});
		});
	}

	function initializeConnection(endpoint) {
		state.client = new window.SidecarWebSocketClient(endpoint.wsUrl, endpoint.token);

		state.client.addEventListener('status', event => {
			setStatus(event.detail.state, event.detail);
			if (event.detail.state === 'connected' && event.detail.reconnected) {
				showBanner('Reconnected');
				requestConversationList();
			}
		});

		state.client.addEventListener('open', () => {
			requestConversationList();
			if (state.currentConversationId) {
				state.client.send({ type: 'conversation:select', conversationId: state.currentConversationId });
			}
		});

		state.client.addEventListener('message', event => {
			handleBridgeMessage(event.detail);
		});

		state.client.connect();
	}

	function bootstrap() {
		initializeServiceWorker();
		initializeConversationPanel();
		initializeConversationFilters();
		initializeComposer();
		updateChatTitle();
		renderSelector(modeSelectorEl, [], undefined, 'Mode');
		renderSelector(modelSelectorEl, [], undefined, 'Model');

		const endpoint = parseQueryParams();
		if (!endpoint) {
			setStatus('disconnected');
			renderer.showEmptyState('Missing pairing details. Open from the QR code URL or paste a pairing URL.');
			return;
		}

		initializeConnection(endpoint);
		renderer.showEmptyState('Waiting for conversations...');
	}

	bootstrap();
})();
