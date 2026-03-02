/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ITelemetryService } from '../../telemetry/common/telemetry';

interface IChatWebSocketBaseTelemetryProperties {
	conversationId: string;
	turnId: string;
}

export interface IChatWebSocketConnectedTelemetryProperties extends IChatWebSocketBaseTelemetryProperties {
	connectDurationMs: number;
}

export interface IChatWebSocketConnectErrorTelemetryProperties extends IChatWebSocketBaseTelemetryProperties {
	error: string;
	connectDurationMs: number;
}

export interface IChatWebSocketCloseTelemetryProperties extends IChatWebSocketBaseTelemetryProperties {
	closeCode: number;
	closeReason: string;
	closeEventReason: string;
	closeEventWasClean: string;
	connectionDurationMs: number;
	totalSentMessageCount: number;
	totalReceivedMessageCount: number;
	totalSentCharacters: number;
	totalReceivedCharacters: number;
}

export interface IChatWebSocketErrorTelemetryProperties extends IChatWebSocketBaseTelemetryProperties {
	error: string;
	connectionDurationMs: number;
	totalSentMessageCount: number;
	totalReceivedMessageCount: number;
	totalSentCharacters: number;
	totalReceivedCharacters: number;
}

export interface IChatWebSocketCloseDuringSetupTelemetryProperties extends IChatWebSocketBaseTelemetryProperties {
	closeCode: number;
	closeReason: string;
	closeEventReason: string;
	closeEventWasClean: string;
	connectDurationMs: number;
}

export interface IChatWebSocketRequestSentTelemetryProperties extends IChatWebSocketBaseTelemetryProperties {
	connectionDurationMs: number;
	totalSentMessageCount: number;
	totalReceivedMessageCount: number;
	sentMessageCharacters: number;
	totalSentCharacters: number;
	totalReceivedCharacters: number;
}

export interface IChatWebSocketMessageParseErrorTelemetryProperties extends IChatWebSocketBaseTelemetryProperties {
	error: string;
	connectionDurationMs: number;
	totalSentMessageCount: number;
	totalReceivedMessageCount: number;
	receivedMessageCharacters: number;
	totalSentCharacters: number;
	totalReceivedCharacters: number;
}

export type ChatWebSocketRequestOutcome = 'completed' | 'server_error' | 'canceled' | 'superseded' | 'connection_closed' | 'connection_disposed' | 'connection_error';

export interface IChatWebSocketRequestOutcomeTelemetryProperties extends IChatWebSocketBaseTelemetryProperties {
	requestOutcome: ChatWebSocketRequestOutcome;
	connectionDurationMs: number;
	requestDurationMs: number;
	totalSentMessageCount: number;
	totalReceivedMessageCount: number;
	totalSentCharacters: number;
	totalReceivedCharacters: number;
	requestSentMessageCount: number;
	requestReceivedMessageCount: number;
	requestSentCharacters: number;
	requestReceivedCharacters: number;
	closeCode?: number;
}

export class ChatWebSocketTelemetrySender {

	public static sendConnectedTelemetry(
		telemetryService: ITelemetryService,
		properties: IChatWebSocketConnectedTelemetryProperties,
	) {
		/* __GDPR__
			"websocket.connected" : {
				"owner": "chrmarti",
				"comment": "Report a successful WebSocket connection.",
				"conversationId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Id of the conversation" },
				"turnId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Id of the turn" },
				"connectDurationMs": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Time to establish the WebSocket connection in milliseconds", "isMeasurement": true }
			}
		*/
		telemetryService.sendTelemetryEvent('websocket.connected', { github: true, microsoft: true }, {
			conversationId: properties.conversationId,
			turnId: properties.turnId,
		}, {
			connectDurationMs: properties.connectDurationMs,
		});
	}

	public static sendConnectErrorTelemetry(
		telemetryService: ITelemetryService,
		properties: IChatWebSocketConnectErrorTelemetryProperties,
	) {
		/* __GDPR__
			"websocket.connectError" : {
				"owner": "chrmarti",
				"comment": "Report a failed WebSocket connection attempt.",
				"conversationId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Id of the conversation" },
				"turnId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Id of the turn" },
				"error": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Error message for the failed connection" },
				"connectDurationMs": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Time until the connection error in milliseconds", "isMeasurement": true }
			}
		*/
		telemetryService.sendTelemetryErrorEvent('websocket.connectError', { github: true, microsoft: true }, {
			conversationId: properties.conversationId,
			turnId: properties.turnId,
			error: properties.error,
		}, {
			connectDurationMs: properties.connectDurationMs,
		});
	}

	public static sendCloseTelemetry(
		telemetryService: ITelemetryService,
		properties: IChatWebSocketCloseTelemetryProperties,
	) {
		/* __GDPR__
			"websocket.close" : {
				"owner": "chrmarti",
				"comment": "Report a WebSocket connection close event.",
				"conversationId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Id of the conversation" },
				"turnId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Id of the turn" },
				"closeReason": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Human-readable description of the close code" },
				"closeEventReason": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Close event reason string from server" },
				"closeEventWasClean": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Whether the connection closed cleanly" },
				"closeCode": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "WebSocket close code", "isMeasurement": true },
				"totalSentMessageCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of messages sent over this connection", "isMeasurement": true },
				"totalReceivedMessageCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of messages received over this connection", "isMeasurement": true },
				"totalSentCharacters": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Total characters sent over this connection", "isMeasurement": true },
				"totalReceivedCharacters": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Total characters received over this connection", "isMeasurement": true },
				"connectionDurationMs": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "How long the connection was open in milliseconds", "isMeasurement": true }
			}
		*/
		telemetryService.sendTelemetryEvent('websocket.close', { github: true, microsoft: true }, {
			conversationId: properties.conversationId,
			turnId: properties.turnId,
			closeReason: properties.closeReason,
			closeEventReason: properties.closeEventReason,
			closeEventWasClean: properties.closeEventWasClean,
		}, {
			closeCode: properties.closeCode,
			totalSentMessageCount: properties.totalSentMessageCount,
			totalReceivedMessageCount: properties.totalReceivedMessageCount,
			totalSentCharacters: properties.totalSentCharacters,
			totalReceivedCharacters: properties.totalReceivedCharacters,
			connectionDurationMs: properties.connectionDurationMs,
		});
	}

	public static sendErrorTelemetry(
		telemetryService: ITelemetryService,
		properties: IChatWebSocketErrorTelemetryProperties,
	) {
		/* __GDPR__
			"websocket.error" : {
				"owner": "chrmarti",
				"comment": "Report a runtime error on an established WebSocket connection.",
				"conversationId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Id of the conversation" },
				"turnId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Id of the turn" },
				"error": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Error message" },
				"totalSentMessageCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of messages sent over this connection", "isMeasurement": true },
				"totalReceivedMessageCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of messages received over this connection", "isMeasurement": true },
				"totalSentCharacters": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Total characters sent over this connection", "isMeasurement": true },
				"totalReceivedCharacters": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Total characters received over this connection", "isMeasurement": true },
				"connectionDurationMs": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "How long the connection was open before the error in milliseconds", "isMeasurement": true }
			}
		*/
		telemetryService.sendTelemetryErrorEvent('websocket.error', { github: true, microsoft: true }, {
			conversationId: properties.conversationId,
			turnId: properties.turnId,
			error: properties.error,
		}, {
			totalSentMessageCount: properties.totalSentMessageCount,
			totalReceivedMessageCount: properties.totalReceivedMessageCount,
			totalSentCharacters: properties.totalSentCharacters,
			totalReceivedCharacters: properties.totalReceivedCharacters,
			connectionDurationMs: properties.connectionDurationMs,
		});
	}

	public static sendCloseDuringSetupTelemetry(
		telemetryService: ITelemetryService,
		properties: IChatWebSocketCloseDuringSetupTelemetryProperties,
	) {
		/* __GDPR__
			"websocket.closeDuringSetup" : {
				"owner": "chrmarti",
				"comment": "Report when a WebSocket connection is closed during setup before fully opening.",
				"conversationId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Id of the conversation" },
				"turnId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Id of the turn" },
				"closeReason": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Human-readable description of the close code" },
				"closeEventReason": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Close event reason string from server" },
				"closeEventWasClean": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Whether the connection closed cleanly" },
				"closeCode": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "WebSocket close code", "isMeasurement": true },
				"connectDurationMs": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Time until the connection was closed during setup in milliseconds", "isMeasurement": true }
			}
		*/
		telemetryService.sendTelemetryErrorEvent('websocket.closeDuringSetup', { github: true, microsoft: true }, {
			conversationId: properties.conversationId,
			turnId: properties.turnId,
			closeReason: properties.closeReason,
			closeEventReason: properties.closeEventReason,
			closeEventWasClean: properties.closeEventWasClean,
		}, {
			closeCode: properties.closeCode,
			connectDurationMs: properties.connectDurationMs,
		});
	}

	public static sendRequestSentTelemetry(
		telemetryService: ITelemetryService,
		properties: IChatWebSocketRequestSentTelemetryProperties,
	) {
		/* __GDPR__
			"websocket.requestSent" : {
				"owner": "chrmarti",
				"comment": "Report when a request is sent over the WebSocket connection.",
				"conversationId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Id of the conversation" },
				"turnId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Id of the turn" },
				"totalSentMessageCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of messages sent over this connection", "isMeasurement": true },
				"totalReceivedMessageCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of messages received over this connection", "isMeasurement": true },
				"sentMessageCharacters": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Character count of this sent message payload", "isMeasurement": true },
				"totalSentCharacters": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Total characters sent over this connection", "isMeasurement": true },
				"totalReceivedCharacters": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Total characters received over this connection", "isMeasurement": true },
				"connectionDurationMs": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "How long the connection has been open when the request is sent in milliseconds", "isMeasurement": true }
			}
		*/
		telemetryService.sendTelemetryEvent('websocket.requestSent', { github: true, microsoft: true }, {
			conversationId: properties.conversationId,
			turnId: properties.turnId,
		}, {
			totalSentMessageCount: properties.totalSentMessageCount,
			totalReceivedMessageCount: properties.totalReceivedMessageCount,
			sentMessageCharacters: properties.sentMessageCharacters,
			totalSentCharacters: properties.totalSentCharacters,
			totalReceivedCharacters: properties.totalReceivedCharacters,
			connectionDurationMs: properties.connectionDurationMs,
		});
	}

	public static sendMessageParseErrorTelemetry(
		telemetryService: ITelemetryService,
		properties: IChatWebSocketMessageParseErrorTelemetryProperties,
	) {
		/* __GDPR__
			"websocket.messageParseError" : {
				"owner": "chrmarti",
				"comment": "Report when a received websocket message fails JSON parsing.",
				"conversationId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Id of the conversation" },
				"turnId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Id of the turn" },
				"error": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Parse error message" },
				"totalSentMessageCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of messages sent over this connection", "isMeasurement": true },
				"totalReceivedMessageCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of messages received over this connection", "isMeasurement": true },
				"receivedMessageCharacters": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Character count of the received message that failed parsing", "isMeasurement": true },
				"totalSentCharacters": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Total characters sent over this connection", "isMeasurement": true },
				"totalReceivedCharacters": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Total characters received over this connection", "isMeasurement": true },
				"connectionDurationMs": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "How long the connection has been open when parsing fails in milliseconds", "isMeasurement": true }
			}
		*/
		telemetryService.sendTelemetryErrorEvent('websocket.messageParseError', { github: true, microsoft: true }, {
			conversationId: properties.conversationId,
			turnId: properties.turnId,
			error: properties.error,
		}, {
			totalSentMessageCount: properties.totalSentMessageCount,
			totalReceivedMessageCount: properties.totalReceivedMessageCount,
			receivedMessageCharacters: properties.receivedMessageCharacters,
			totalSentCharacters: properties.totalSentCharacters,
			totalReceivedCharacters: properties.totalReceivedCharacters,
			connectionDurationMs: properties.connectionDurationMs,
		});
	}

	public static sendRequestOutcomeTelemetry(
		telemetryService: ITelemetryService,
		properties: IChatWebSocketRequestOutcomeTelemetryProperties,
	) {
		/* __GDPR__
			"websocket.requestOutcome" : {
				"owner": "chrmarti",
				"comment": "Report terminal outcome for a websocket request.",
				"conversationId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Id of the conversation" },
				"turnId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Id of the turn" },
				"requestOutcome": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Terminal outcome of the websocket request" },
				"totalSentMessageCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of messages sent over this connection", "isMeasurement": true },
				"totalReceivedMessageCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of messages received over this connection", "isMeasurement": true },
				"totalSentCharacters": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Total characters sent over this connection", "isMeasurement": true },
				"totalReceivedCharacters": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Total characters received over this connection", "isMeasurement": true },
				"requestSentMessageCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of messages sent during this request", "isMeasurement": true },
				"requestReceivedMessageCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of messages received during this request", "isMeasurement": true },
				"requestSentCharacters": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of characters sent during this request", "isMeasurement": true },
				"requestReceivedCharacters": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of characters received during this request", "isMeasurement": true },
				"connectionDurationMs": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "How long the connection has been open when the request ended in milliseconds", "isMeasurement": true },
				"requestDurationMs": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "How long the request took before terminal outcome in milliseconds", "isMeasurement": true },
				"closeCode": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "WebSocket close code when outcome is connection_closed", "isMeasurement": true }
			}
		*/
		telemetryService.sendTelemetryEvent('websocket.requestOutcome', { github: true, microsoft: true }, {
			conversationId: properties.conversationId,
			turnId: properties.turnId,
			requestOutcome: properties.requestOutcome,
		}, {
			totalSentMessageCount: properties.totalSentMessageCount,
			totalReceivedMessageCount: properties.totalReceivedMessageCount,
			totalSentCharacters: properties.totalSentCharacters,
			totalReceivedCharacters: properties.totalReceivedCharacters,
			requestSentMessageCount: properties.requestSentMessageCount,
			requestReceivedMessageCount: properties.requestReceivedMessageCount,
			requestSentCharacters: properties.requestSentCharacters,
			requestReceivedCharacters: properties.requestReceivedCharacters,
			connectionDurationMs: properties.connectionDurationMs,
			requestDurationMs: properties.requestDurationMs,
			closeCode: properties.closeCode,
		});
	}
}
