/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { encodeUrlHostname } from '../../common/toolUtils';

describe('encodeUrlHostname', () => {
	describe('ASCII URLs', () => {
		it('handles standard ASCII domain', () => {
			const result = encodeUrlHostname('https://example.com');
			expect(result.encoded).toBe('https://example.com');
			expect(result.isDifferent).toBe(false);
		});

		it('handles ASCII domain with path', () => {
			const result = encodeUrlHostname('https://example.com/path/to/page');
			expect(result.encoded).toBe('https://example.com/path/to/page');
			expect(result.isDifferent).toBe(false);
		});

		it('handles ASCII domain with query string', () => {
			const result = encodeUrlHostname('https://example.com/page?foo=bar&baz=qux');
			expect(result.encoded).toBe('https://example.com/page?foo=bar&baz=qux');
			expect(result.isDifferent).toBe(false);
		});

		it('handles ASCII domain with fragment', () => {
			const result = encodeUrlHostname('https://example.com/page#section');
			expect(result.encoded).toBe('https://example.com/page#section');
			expect(result.isDifferent).toBe(false);
		});

		it('handles http scheme', () => {
			const result = encodeUrlHostname('http://example.com');
			expect(result.encoded).toBe('http://example.com');
			expect(result.isDifferent).toBe(false);
		});
	});

	describe('internationalized domain names (IDN)', () => {
		it('encodes Cyrillic domain', () => {
			const result = encodeUrlHostname('https://пример.рф');
			expect(result.encoded).toBe('https://xn--e1afmkfd.xn--p1ai');
			expect(result.isDifferent).toBe(true);
		});

		it('encodes Chinese domain', () => {
			const result = encodeUrlHostname('https://例え.jp');
			expect(result.encoded).toBe('https://xn--r8jz45g.jp');
			expect(result.isDifferent).toBe(true);
		});

		it('encodes German domain with umlaut', () => {
			const result = encodeUrlHostname('https://müller.de');
			expect(result.encoded).toBe('https://xn--mller-kva.de');
			expect(result.isDifferent).toBe(true);
		});

		it('encodes Arabic domain', () => {
			const result = encodeUrlHostname('https://مثال.السعودية');
			expect(result.encoded).toBe('https://xn--mgbh0fb.xn--mgberp4a5d4ar');
			expect(result.isDifferent).toBe(true);
		});

		it('preserves path when encoding IDN', () => {
			const result = encodeUrlHostname('https://пример.рф/path/to/page');
			expect(result.encoded).toBe('https://xn--e1afmkfd.xn--p1ai/path/to/page');
			expect(result.isDifferent).toBe(true);
		});

		it('preserves query string when encoding IDN', () => {
			const result = encodeUrlHostname('https://пример.рф?foo=bar');
			expect(result.encoded).toBe('https://xn--e1afmkfd.xn--p1ai?foo=bar');
			expect(result.isDifferent).toBe(true);
		});
	});

	describe('URLs with port', () => {
		it('handles ASCII domain with port', () => {
			const result = encodeUrlHostname('https://example.com:8080');
			expect(result.encoded).toBe('https://example.com:8080');
			expect(result.isDifferent).toBe(false);
		});

		it('encodes IDN with port', () => {
			const result = encodeUrlHostname('https://пример.рф:8080');
			expect(result.encoded).toBe('https://xn--e1afmkfd.xn--p1ai:8080');
			expect(result.isDifferent).toBe(true);
		});

		it('handles port with path', () => {
			const result = encodeUrlHostname('https://пример.рф:8080/path');
			expect(result.encoded).toBe('https://xn--e1afmkfd.xn--p1ai:8080/path');
			expect(result.isDifferent).toBe(true);
		});
	});

	describe('URLs with userinfo', () => {
		it('handles userinfo with ASCII domain', () => {
			const result = encodeUrlHostname('https://user:pass@example.com');
			expect(result.encoded).toBe('https://user:pass@example.com');
			expect(result.isDifferent).toBe(false);
		});

		it('encodes IDN with userinfo', () => {
			const result = encodeUrlHostname('https://user:pass@пример.рф');
			expect(result.encoded).toBe('https://user:pass@xn--e1afmkfd.xn--p1ai');
			expect(result.isDifferent).toBe(true);
		});

		it('handles userinfo with port', () => {
			const result = encodeUrlHostname('https://user:pass@пример.рф:8080');
			expect(result.encoded).toBe('https://user:pass@xn--e1afmkfd.xn--p1ai:8080');
			expect(result.isDifferent).toBe(true);
		});

		it('handles username without password', () => {
			const result = encodeUrlHostname('https://user@пример.рф');
			expect(result.encoded).toBe('https://user@xn--e1afmkfd.xn--p1ai');
			expect(result.isDifferent).toBe(true);
		});
	});

	describe('subdomain handling', () => {
		it('encodes subdomain with non-ASCII characters', () => {
			const result = encodeUrlHostname('https://поддомен.пример.рф');
			expect(result.encoded).toBe('https://xn--d1aad1agbce.xn--e1afmkfd.xn--p1ai');
			expect(result.isDifferent).toBe(true);
		});

		it('handles mixed ASCII and non-ASCII subdomains', () => {
			const result = encodeUrlHostname('https://www.пример.рф');
			expect(result.encoded).toBe('https://www.xn--e1afmkfd.xn--p1ai');
			expect(result.isDifferent).toBe(true);
		});
	});

	describe('edge cases', () => {
		it('handles localhost', () => {
			const result = encodeUrlHostname('http://localhost:3000');
			expect(result.encoded).toBe('http://localhost:3000');
			expect(result.isDifferent).toBe(false);
		});

		it('handles IP address', () => {
			const result = encodeUrlHostname('http://192.168.1.1:8080');
			expect(result.encoded).toBe('http://192.168.1.1:8080');
			expect(result.isDifferent).toBe(false);
		});

		it('handles IPv6 address', () => {
			const result = encodeUrlHostname('http://[::1]:8080');
			expect(result.encoded).toBe('http://[::1]:8080');
			expect(result.isDifferent).toBe(false);
		});

		it('handles empty authority gracefully', () => {
			const result = encodeUrlHostname('file:///path/to/file');
			expect(result.encoded).toBe('file:///path/to/file');
			expect(result.isDifferent).toBe(false);
		});

		it('handles invalid URL gracefully', () => {
			const result = encodeUrlHostname('not a url');
			expect(result.encoded).toBe('not a url');
			expect(result.isDifferent).toBe(false);
		});
	});

	describe('homograph attack prevention', () => {
		it('encodes Cyrillic "a" that looks like Latin "a"', () => {
			// Cyrillic а (U+0430) vs Latin a (U+0061)
			const result = encodeUrlHostname('https://exаmple.com'); // Contains Cyrillic а
			expect(result.isDifferent).toBe(true);
			expect(result.encoded).toContain('xn--');
		});

		it('encodes Greek omicron that looks like Latin "o"', () => {
			// Greek ο (U+03BF) vs Latin o (U+006F)
			const result = encodeUrlHostname('https://gοοgle.com'); // Contains Greek ο
			expect(result.isDifferent).toBe(true);
			expect(result.encoded).toContain('xn--');
		});
	});
});
