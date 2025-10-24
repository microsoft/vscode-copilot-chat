/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Context } from '../context';

class Foo {
	bar = 1;
}

class FooArg {
	constructor(public bar: number) { }
}

suite('Context', function () {
	test('should round-trip instances', function () {
		const foo = new Foo();
		const ctx = new Context();
		ctx.set(Foo, foo);
		assert.strictEqual(ctx.get(Foo), foo);
	});

	test('should error for get() of unregistered class', function () {
		const ctx = new Context();
		assert.throws(() => ctx.get(Foo), /No instance of Foo has been registered/); // ensure the error message contains the requested class name
	});

	test('should error for second set() of same class', function () {
		const ctx = new Context();
		ctx.set(Foo, new Foo());
		assert.throws(() => ctx.set(Foo, new Foo()));
	});

	test('should work with constructors that take parameters', function () {
		const ctx = new Context();
		ctx.set(FooArg, new FooArg(1));
		assert.strictEqual(ctx.get(FooArg).bar, 1);
	});

	test('set should not allow setting a non-instance as the instance', function () {
		const ctx = new Context();
		assert.throws(() => ctx.set(Foo, { bar: 1 }));
	});

	test('forceSet should not allow setting a non-instance as the instance', function () {
		const ctx = new Context();
		assert.throws(() => ctx.set(Foo, { bar: 1 }));
	});
});
