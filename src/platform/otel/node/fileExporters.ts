/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';

interface ExportResult {
	code: number;
	error?: Error;
}

const SUCCESS = 0;
const FAILED = 1;

function safeStringify(data: unknown): string {
	try {
		return JSON.stringify(data);
	} catch {
		return '{}';
	}
}

abstract class BaseFileExporter {
	protected readonly writeStream: fs.WriteStream;

	constructor(filePath: string) {
		this.writeStream = fs.createWriteStream(filePath, { flags: 'a' });
	}

	shutdown(): Promise<void> {
		return new Promise(resolve => this.writeStream.end(resolve));
	}
}

export class FileSpanExporter extends BaseFileExporter {
	export(spans: readonly unknown[], resultCallback: (result: ExportResult) => void): void {
		const data = spans.map(s => safeStringify(s) + '\n').join('');
		this.writeStream.write(data, err => {
			resultCallback({ code: err ? FAILED : SUCCESS, error: err ?? undefined });
		});
	}
}

export class FileLogExporter extends BaseFileExporter {
	export(logs: readonly unknown[], resultCallback: (result: ExportResult) => void): void {
		const data = logs.map(l => safeStringify(l) + '\n').join('');
		this.writeStream.write(data, err => {
			resultCallback({ code: err ? FAILED : SUCCESS, error: err ?? undefined });
		});
	}
}

export class FileMetricExporter extends BaseFileExporter {
	export(metrics: unknown, resultCallback: (result: ExportResult) => void): void {
		const data = safeStringify(metrics) + '\n';
		this.writeStream.write(data, err => {
			resultCallback({ code: err ? FAILED : SUCCESS, error: err ?? undefined });
		});
	}

	selectAggregationTemporality(): number {
		return 0; // CUMULATIVE
	}

	async forceFlush(): Promise<void> { }
}
