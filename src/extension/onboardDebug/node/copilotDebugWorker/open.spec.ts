
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as child_process from 'child_process';
import { openVscodeUri } from './open';

vi.mock('child_process', () => ({
    spawn: vi.fn(() => ({
        stdout: { setEncoding: vi.fn().mockReturnThis(), on: vi.fn() },
        stderr: { setEncoding: vi.fn().mockReturnThis(), on: vi.fn() },
        on: vi.fn((event, cb) => {
            if (event === 'exit') {
                cb(0);
            }
        })
    }))
}));

describe('openVscodeUri', () => {
    const originalPlatform = process.platform;

    afterEach(() => {
        Object.defineProperty(process, 'platform', {
            value: originalPlatform
        });
        vi.clearAllMocks();
    });

    it('should use cmd /c start "" uri with shell: false on win32', async () => {
        Object.defineProperty(process, 'platform', {
            value: 'win32'
        });

        const uri = 'vscode://example.com';
        await openVscodeUri(undefined, uri);

        expect(child_process.spawn).toHaveBeenCalledWith(
            'cmd',
            ['/c', 'start', '""', uri],
            expect.objectContaining({ shell: false })
        );
    });

    it('should handle uri with quotes safely on win32 (relying on spawn escaping)', async () => {
        Object.defineProperty(process, 'platform', {
            value: 'win32'
        });

        const uri = 'vscode://example.com" & calc.exe & "';
        await openVscodeUri(undefined, uri);

        expect(child_process.spawn).toHaveBeenCalledWith(
            'cmd',
            ['/c', 'start', '""', uri],
            expect.objectContaining({ shell: false })
        );
    });
});
