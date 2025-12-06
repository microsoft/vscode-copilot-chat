/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { TreeSitterOffsetRange } from '../../../../../platform/parser/node/nodes';
import { removeBodiesOutsideRange } from '../inlineChatSelection';

describe('removeBodiesOutsideRange', () => {
	describe('basic functionality', () => {
		it('handles empty source string', () => {
			const result = removeBodiesOutsideRange(
				'',
				[],
				{ startOffset: 0, endOffset: 0 },
				'...'
			);
			expect(result.outlineAbove).toBe('');
			expect(result.outlineBelow).toBe('');
		});

		it('returns source unchanged when no function bodies provided', () => {
			const src = 'function foo() { return 1; }\nfunction bar() { return 2; }';
			const result = removeBodiesOutsideRange(
				src,
				[],
				{ startOffset: 0, endOffset: 28 },
				'...'
			);
			// When no bodies to remove, above should contain everything up to startOffset
			// and below should contain everything from endOffset
			expect(result.outlineAbove).toBe('');
			expect(result.outlineBelow).toBe('\nfunction bar() { return 2; }');
		});

		it('removes function body above rangeToMaintain', () => {
			// Example code structure:
			// 0-10: "function a" (keep)
			// 10-20: "() { x; }" (body - remove)
			// 20-30: "\nfunction b" (keep)
			// 30-40: "() { y; }" (maintain - keep)
			const src = 'function a() { x; }\nfunction b() { y; }';
			const functionBodyAbove: TreeSitterOffsetRange = {
				startIndex: 13, // start of "{ x; }"
				endIndex: 19    // end of "{ x; }"
			};
			const result = removeBodiesOutsideRange(
				src,
				[functionBodyAbove],
				{ startOffset: 20, endOffset: 40 },  // The range containing function b
				'{ ... }'
			);

			expect(result.outlineAbove).toContain('function a()');
			expect(result.outlineAbove).toContain('{ ... }');
			expect(result.outlineAbove).not.toContain('{ x; }');
		});

		it('removes function body below rangeToMaintain', () => {
			// Example code structure:
			// 0-20: "function a() { x; }" (maintain - keep)
			// 20-40: "\nfunction b() { y; }" (body in here - remove)
			const src = 'function a() { x; }\nfunction b() { y; }';
			const functionBodyBelow: TreeSitterOffsetRange = {
				startIndex: 33, // start of "{ y; }"
				endIndex: 39    // end of "{ y; }"
			};
			const result = removeBodiesOutsideRange(
				src,
				[functionBodyBelow],
				{ startOffset: 0, endOffset: 19 },  // The range containing function a
				'{ ... }'
			);

			expect(result.outlineBelow).toContain('function b()');
			expect(result.outlineBelow).toContain('{ ... }');
			expect(result.outlineBelow).not.toContain('{ y; }');
		});

		it('preserves body that intersects with rangeToMaintain', () => {
			// When a function body overlaps with rangeToMaintain, it should NOT be removed
			const src = 'function a() { x; }';
			const functionBody: TreeSitterOffsetRange = {
				startIndex: 13,
				endIndex: 19
			};
			const result = removeBodiesOutsideRange(
				src,
				[functionBody],
				{ startOffset: 10, endOffset: 19 },  // Overlaps with the function body
				'{ ... }'
			);

			// Since the body intersects with rangeToMaintain, it shouldn't be replaced
			expect(result.outlineAbove).toBe('function a');
			expect(result.outlineBelow).toBe('');
		});
	});

	describe('multiple function bodies', () => {
		it('removes multiple bodies above rangeToMaintain', () => {
			// Code with two functions above the range of interest
			const src = 'function a() { x; }\nfunction b() { y; }\nfunction c() { z; }';
			const bodies: TreeSitterOffsetRange[] = [
				{ startIndex: 13, endIndex: 19 },   // { x; }
				{ startIndex: 33, endIndex: 39 },   // { y; }
			];
			const result = removeBodiesOutsideRange(
				src,
				bodies,
				{ startOffset: 40, endOffset: 60 },  // Range containing function c
				'...'
			);

			// Both bodies above should be replaced
			expect(result.outlineAbove).toContain('function a()');
			expect(result.outlineAbove).toContain('function b()');
			expect(result.outlineAbove).not.toContain('{ x; }');
			expect(result.outlineAbove).not.toContain('{ y; }');
			expect(result.outlineAbove.match(/\.\.\./g)?.length).toBe(2);
		});

		it('removes bodies both above and below rangeToMaintain', () => {
			const src = 'function a() { x; }\nfunction b() { y; }\nfunction c() { z; }';
			const bodies: TreeSitterOffsetRange[] = [
				{ startIndex: 13, endIndex: 19 },   // { x; } - above
				{ startIndex: 53, endIndex: 59 },   // { z; } - below
			];
			const result = removeBodiesOutsideRange(
				src,
				bodies,
				{ startOffset: 20, endOffset: 39 },  // Range containing function b
				'...'
			);

			expect(result.outlineAbove).toContain('...');
			expect(result.outlineAbove).not.toContain('{ x; }');
			expect(result.outlineBelow).toContain('...');
			expect(result.outlineBelow).not.toContain('{ z; }');
		});
	});

	describe('edge cases', () => {
		it('handles rangeToMaintain at the beginning of source', () => {
			const src = 'function a() { x; }\nfunction b() { y; }';
			const body: TreeSitterOffsetRange = {
				startIndex: 33, // { y; }
				endIndex: 39
			};
			const result = removeBodiesOutsideRange(
				src,
				[body],
				{ startOffset: 0, endOffset: 19 },
				'...'
			);

			expect(result.outlineAbove).toBe('');
			expect(result.outlineBelow).toContain('function b()');
			expect(result.outlineBelow).toContain('...');
		});

		it('handles rangeToMaintain at the end of source', () => {
			const src = 'function a() { x; }\nfunction b() { y; }';
			const body: TreeSitterOffsetRange = {
				startIndex: 13, // { x; }
				endIndex: 19
			};
			const result = removeBodiesOutsideRange(
				src,
				[body],
				{ startOffset: 20, endOffset: 39 },
				'...'
			);

			expect(result.outlineAbove).toContain('function a()');
			expect(result.outlineAbove).toContain('...');
			expect(result.outlineBelow).toBe('');
		});

		it('handles adjacent function bodies correctly', () => {
			// Two functions with bodies well-separated from rangeToMaintain
			// The key is that body.endIndex < rangeToMaintain.startOffset (strict less than)
			// src: 'fn a(){x}fn b(){y}fn c(){z}'
			// indices: 0-5 = 'fn a()', 6-9 = '{x}', 9-14 = 'fn b()', 15-18 = '{y}', 18-23 = 'fn c()', 24-27 = '{z}'
			const src = 'fn a(){x}fn b(){y}fn c(){z}';
			const bodies: TreeSitterOffsetRange[] = [
				{ startIndex: 6, endIndex: 9 },   // {x} - ends at 9, which is < 10 (startOffset of rangeToMaintain)
				{ startIndex: 24, endIndex: 27 }  // {z} - starts at 24, which is > 18 (endOffset of rangeToMaintain)
			];
			const result = removeBodiesOutsideRange(
				src,
				bodies,
				{ startOffset: 10, endOffset: 18 },  // 'n b(){y}' - starts at 10, ends at 18
				'...'
			);

			// outlineAbove: src[0:6] + '...' + src[9:10] = 'fn a()' + '...' + 'f' = 'fn a()...f'
			// But wait, let's trace the algorithm:
			// lastOffsetAbove = 0
			// For {6,9}: endIndex(9) < startOffset(10) -> yes, it's above
			//   outlineAbove += src[0:6] = 'fn a()'
			//   outlineAbove += '...'
			//   lastOffsetAbove = 9
			// outlineAbove += src[9:10] = 'f'
			// Final: 'fn a()...f'
			expect(result.outlineAbove).toBe('fn a()...f');

			// outlineBelow: src[18:24] + '...' + src[27:27]
			// lastOffsetBelow = 18
			// For {24,27}: startIndex(24) > endOffset(18) -> yes, it's below
			//   outlineBelow += src[18:24] = 'fn c()'
			//   outlineBelow += '...'
			//   lastOffsetBelow = 27
			// outlineBelow += src[27:27] = ''
			// Final: 'fn c()...'
			expect(result.outlineBelow).toBe('fn c()...');
		});

		it('handles custom replacement string', () => {
			const src = 'function a() { x; }\nfunction b() { y; }';
			const body: TreeSitterOffsetRange = {
				startIndex: 13,
				endIndex: 19
			};
			const result = removeBodiesOutsideRange(
				src,
				[body],
				{ startOffset: 20, endOffset: 39 },
				'{ /* body omitted */ }'
			);

			expect(result.outlineAbove).toContain('{ /* body omitted */ }');
		});

		it('handles empty replacement string', () => {
			const src = 'function a() { x; }\nfunction b() { y; }';
			const body: TreeSitterOffsetRange = {
				startIndex: 13,
				endIndex: 19
			};
			const result = removeBodiesOutsideRange(
				src,
				[body],
				{ startOffset: 20, endOffset: 39 },
				''
			);

			// The body is removed, leaving just the part before the body + part between body end and startOffset
			// "function a() " (0-13) + "" (replacement) + "\n" (19-20)
			expect(result.outlineAbove).toBe('function a() \n');
		});
	});

	describe('range boundary conditions', () => {
		it('body ending exactly at rangeToMaintain.startOffset is NOT removed (boundary exclusive)', () => {
			// The condition is endIndex < startOffset (strictly less than)
			// So if endIndex == startOffset, the body is NOT removed (it's considered as intersecting)
			const src = 'AAABBB';
			const body: TreeSitterOffsetRange = {
				startIndex: 0,
				endIndex: 3
			};
			const result = removeBodiesOutsideRange(
				src,
				[body],
				{ startOffset: 3, endOffset: 6 },
				'X'
			);

			// Body ends at 3, rangeToMaintain starts at 3, so endIndex is NOT < startOffset
			// Therefore body is not removed
			expect(result.outlineAbove).toBe('AAA');
			expect(result.outlineBelow).toBe('');
		});

		it('body starting exactly at rangeToMaintain.endOffset is NOT removed (boundary exclusive)', () => {
			// The condition is startIndex > endOffset (strictly greater than)
			// So if startIndex == endOffset, the body is NOT removed (it's considered as intersecting)
			const src = 'AAABBB';
			const body: TreeSitterOffsetRange = {
				startIndex: 3,
				endIndex: 6
			};
			const result = removeBodiesOutsideRange(
				src,
				[body],
				{ startOffset: 0, endOffset: 3 },
				'X'
			);

			// Body starts at 3, rangeToMaintain ends at 3, so startIndex is NOT > endOffset
			// Therefore body is not removed
			expect(result.outlineAbove).toBe('');
			expect(result.outlineBelow).toBe('BBB');
		});

		it('body ending one before rangeToMaintain.startOffset IS removed', () => {
			// When endIndex < startOffset, the body should be removed
			const src = 'AAABBB';
			const body: TreeSitterOffsetRange = {
				startIndex: 0,
				endIndex: 2  // Ends at 2, which is < 3
			};
			const result = removeBodiesOutsideRange(
				src,
				[body],
				{ startOffset: 3, endOffset: 6 },
				'X'
			);

			expect(result.outlineAbove).toBe('XA');  // X replaces 0-2, then src[2:3] = 'A'
			expect(result.outlineBelow).toBe('');
		});

		it('body starting one after rangeToMaintain.endOffset IS removed', () => {
			// When startIndex > endOffset, the body should be removed
			const src = 'AAABBB';
			const body: TreeSitterOffsetRange = {
				startIndex: 4,  // Starts at 4, which is > 3
				endIndex: 6
			};
			const result = removeBodiesOutsideRange(
				src,
				[body],
				{ startOffset: 0, endOffset: 3 },
				'X'
			);

			expect(result.outlineAbove).toBe('');
			expect(result.outlineBelow).toBe('BX');  // src[3:4] = 'B', then X replaces 4-6
		});

		it('body exactly matching rangeToMaintain is preserved', () => {
			const src = 'AAABBB';
			const body: TreeSitterOffsetRange = {
				startIndex: 0,
				endIndex: 3
			};
			const result = removeBodiesOutsideRange(
				src,
				[body],
				{ startOffset: 0, endOffset: 3 },
				'X'
			);

			// Body intersects with rangeToMaintain, so it should not be replaced
			expect(result.outlineAbove).toBe('');
			expect(result.outlineBelow).toBe('BBB');
		});
	});
});
