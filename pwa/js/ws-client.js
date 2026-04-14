(() => {
	class SidecarWebSocketClient extends EventTarget {
		constructor(wsBaseUrl, token) {
			super();
			this.wsBaseUrl = wsBaseUrl;
			this.token = token;
			this.socket = undefined;
			this.manualClose = false;
			this.reconnectAttempt = 0;
			this.reconnectTimer = undefined;
			this.connectedOnce = false;
		}

		setEndpoint(wsBaseUrl, token) {
			this.wsBaseUrl = wsBaseUrl;
			this.token = token;
		}

		connect() {
			if (!this.wsBaseUrl) {
				this.emitStatus('disconnected');
				return;
			}

			this.manualClose = false;
			this.clearReconnectTimer();

			const socketUrl = this.createSocketUrl();
			if (!socketUrl) {
				this.emitStatus('disconnected');
				return;
			}

			this.emitStatus(this.connectedOnce ? 'reconnecting' : 'connecting');

			const socket = new WebSocket(socketUrl);
			this.socket = socket;

			socket.addEventListener('open', () => {
				const reconnected = this.connectedOnce;
				this.connectedOnce = true;
				this.reconnectAttempt = 0;
				this.emitStatus('connected', { reconnected });
				this.dispatchEvent(new CustomEvent('open', { detail: { reconnected } }));
			});

			socket.addEventListener('message', event => {
				let payload;
				try {
					payload = JSON.parse(event.data);
				} catch {
					return;
				}
				this.dispatchEvent(new CustomEvent('message', { detail: payload }));
			});

			socket.addEventListener('close', () => {
				if (this.socket === socket) {
					this.socket = undefined;
				}
				if (this.manualClose) {
					this.emitStatus('disconnected');
					return;
				}
				this.scheduleReconnect();
			});

			socket.addEventListener('error', () => {
				if (!this.manualClose) {
					this.emitStatus('reconnecting');
				}
			});
		}

		disconnect() {
			this.manualClose = true;
			this.clearReconnectTimer();
			if (this.socket) {
				this.socket.close();
				this.socket = undefined;
			}
			this.emitStatus('disconnected');
		}

		send(message) {
			if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
				return false;
			}
			this.socket.send(JSON.stringify(message));
			return true;
		}

		requestConversationList(filter) {
			const message = { type: 'conversation:list:request' };
			if (filter && typeof filter === 'object') {
				message.filter = filter;
			}
			this.send(message);
		}

		scheduleReconnect() {
			this.clearReconnectTimer();
			const delayMs = Math.min(1000 * (2 ** this.reconnectAttempt), 30000);
			this.reconnectAttempt += 1;
			this.emitStatus('reconnecting', { attempt: this.reconnectAttempt, delayMs });
			this.reconnectTimer = window.setTimeout(() => this.connect(), delayMs);
		}

		clearReconnectTimer() {
			if (this.reconnectTimer !== undefined) {
				window.clearTimeout(this.reconnectTimer);
				this.reconnectTimer = undefined;
			}
		}

		emitStatus(state, extra = {}) {
			this.dispatchEvent(new CustomEvent('status', { detail: { state, ...extra } }));
		}

		createSocketUrl() {
			try {
				const url = new URL(this.wsBaseUrl);
				if (url.protocol === 'https:') {
					url.protocol = 'wss:';
				} else if (url.protocol === 'http:') {
					url.protocol = 'ws:';
				}

				if (this.token) {
					url.searchParams.set('token', this.token);
				}
				return url.toString();
			} catch {
				return undefined;
			}
		}
	}

	window.SidecarWebSocketClient = SidecarWebSocketClient;
})();
