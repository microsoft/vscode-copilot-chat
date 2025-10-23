/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * The type of a constructor that can be passed to `.get()` in order to receive
 * a value of the instance type.
 */
type Ctor<T> = abstract new (...args: never[]) => T;

/** The type of the instance associated with a constructor. */
type Instance<T> = T extends Ctor<infer U> ? U : never;

class UnregisteredContextError extends Error {
	constructor(readonly ctor: Ctor<unknown>) {
		super(`No instance of ${ctor.name} has been registered`);
		this.name = `UnregisteredContextErrorFor${ctor.name}`;
	}
}

/**
 * Stores a set of singletons and provides type-safe access to them. Create an
 * instance and pass it through function calls.
 */
export class Context {
	private instances = new Map<Ctor<unknown>, unknown>();

	/**
	 * Returns the instance associated with the given constructor. Throws if there
	 * is no binding for it.
	 */
	get<T>(ctor: Ctor<T>): T {
		const value = this.tryGet(ctor);
		if (value) {
			return value;
		}
		throw new UnregisteredContextError(ctor);
	}

	/**
	 * Returns the instance associated with the given constructor.
	 * Returns undefined if there is no binding for it.
	 */
	private tryGet<T>(ctor: Ctor<T>): T | undefined {
		const value = this.instances.get(ctor);
		if (value) {
			return value as T;
		}
		return undefined;
	}

	/**
	 * Associates the given constructor with the value (an instance of it). Throws
	 * if there is an existing binding.
	 */
	set<C extends Ctor<unknown>>(ctor: C, instance: Instance<C>): void {
		if (this.tryGet(ctor)) {
			throw new Error(
				`An instance of ${ctor.name} has already been registered. Use forceSet() if you're sure it's a good idea.`
			);
		}
		this.assertIsInstance(ctor, instance);
		this.instances.set(ctor, instance);
	}

	/**
	 * Associates the given constructor with the value (an instance of it).
	 * Overrides any existing binding.
	 */
	forceSet<C extends Ctor<unknown>>(ctor: C, instance: Instance<C>): void {
		this.assertIsInstance(ctor, instance);
		this.instances.set(ctor, instance);
	}

	private assertIsInstance<C extends Ctor<unknown>>(ctor: C, instance: Instance<C>): void {
		if (!(instance instanceof ctor)) {
			// It's possible that `instance` isn't really an instance of ctor,
			// either because it was explicitly typed as `any` or because it's
			// just an object whose shape matches that of Instance<C>. We don't
			// allow such usage because it can lead to surprising & subtle bugs.
			const inst = JSON.stringify(instance);
			throw new Error(
				`The instance you're trying to register for ${ctor.name} is not an instance of it (${inst}).`
			);
		}
	}
}
