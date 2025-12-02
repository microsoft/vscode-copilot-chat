enum MyEnum {
	//// { "title": "Enum - rename", "oldName": "One", "newName": "Four", "expected": "yes" }
	One,
	Two,
	//// { "title": "Enum - no rename", "oldName": "Three", "newName": "Two", "expected": "no" }
	Three
}

class Base {
	public foo() { }
}

class Derived extends Base {
	//// { "title": "Method - rename", "oldName": "bar", "newName": "bazz", "expected": "yes" }
	bar() { }

	//// { "title": "Method - no rename", "oldName": "baz", "newName": "bar", "expected": "no" }
	baz() { }

	//// { "title": "Method - no rename inherited", "oldName": "faz", "newName": "foo", "expected": "no" }
	faz() { }
}

namespace MyNamespace {
	function foo() { }

	function
		//// { "title": "Function - rename", "oldName": "bar", "newName": "bazz", "expected": "yes" }
		bar() { }

	function
		//// { "title": "Function - no rename", "oldName": "baz", "newName": "bar", "expected": "no" }
		baz() { }
}

function main() {
	const
		//// { "title": "Variable - rename", "oldName": "x", "newName": "y", "expected": "yes" }
		x = 10;

	const
		//// { "title": "Variable - no rename", "oldName": "z", "newName": "x", "expected": "no" }
		z = 20;
}

type MyType = {
}

//// { "title": "Type - rename", "oldName": "TypeOne", "newName": "YourType", "expected": "yes", "delta": 5 }
type TypeOne = {
}

//// { "title": "Type - no rename", "oldName": "TypeTwo", "newName": "MyType", "expected": "no", "delta": 5 }
type TypeTwo = {
}

// Interface tests
interface IBase {
	baseProp: string;
	baseMethod(): void;
}

interface IDerived extends IBase {
	//// { "title": "Interface method - rename", "oldName": "derivedMethod", "newName": "newMethod", "expected": "yes" }
	derivedMethod(): void;

	//// { "title": "Interface method - no rename to existing", "oldName": "otherMethod", "newName": "derivedMethod", "expected": "no" }
	otherMethod(): void;

	//// { "title": "Interface method - no rename inherited", "oldName": "someMethod", "newName": "baseMethod", "expected": "no" }
	someMethod(): void;
}

// Property tests
class PropertyClass {
	//// { "title": "Property - rename", "oldName": "propA", "newName": "propC", "expected": "yes" }
	propA: number = 1;

	//// { "title": "Property - no rename to existing", "oldName": "propB", "newName": "propA", "expected": "no" }
	propB: string = "test";
}

// Accessor tests
class AccessorClass {
	private _value: number = 0;

	//// { "title": "Getter - no rename conflicts with _value", "oldName": "getValue", "newName": "_value", "expected": "no" }
	get getValue(): number {
		return this._value;
	}

	set setValue(v: number) {
		this._value = v;
	}

	//// { "title": "Getter - no rename to existing accessor", "oldName": "anotherGetter", "newName": "getValue", "expected": "no" }
	get anotherGetter(): number {
		return this._value * 2;
	}
}

// Parameter tests
function parameterTest(
	//// { "title": "Parameter - rename", "oldName": "paramA", "newName": "paramC", "expected": "yes" }
	paramA: number,
	paramB: string
) {
	return paramA + paramB.length;
}

function parameterConflict(
	firstParam: number,
	//// { "title": "Parameter - no rename to existing", "oldName": "secondParam", "newName": "firstParam", "expected": "no" }
	secondParam: string
) {
	return firstParam + secondParam.length;
}

// Nested scope tests
function outerFunction() {
	const outerVar = 10;

	function innerFunction() {
		const
			//// { "title": "Nested variable - rename", "oldName": "innerVar", "newName": "newInnerVar", "expected": "yes" }
			innerVar = 20;

		const
			//// { "title": "Nested variable - no rename to outer scope", "oldName": "anotherInnerVar", "newName": "outerVar", "expected": "no" }
			anotherInnerVar = 30;

		return innerVar + anotherInnerVar;
	}

	return outerVar + innerFunction();
}

// Arrow function tests
const arrowFunc = (
	//// { "title": "Arrow function parameter - rename", "oldName": "arrowParam", "newName": "newArrowParam", "expected": "yes" }
	arrowParam: number
) => {
	return arrowParam * 2;
};

// Multiple inheritance (extends + implements)
class MultiInheritBase {
	baseClassMethod(): void { }
}

interface MultiInheritInterface {
	interfaceMethod(): string;
}

class MultiInheritDerived extends MultiInheritBase implements MultiInheritInterface {
	interfaceMethod(): string { return ""; }

	//// { "title": "Multi-inherit - rename", "oldName": "ownMethod", "newName": "uniqueMethod", "expected": "yes" }
	ownMethod(): void { }

	//// { "title": "Multi-inherit - no rename to base class", "oldName": "anotherOwnMethod", "newName": "baseClassMethod", "expected": "no" }
	anotherOwnMethod(): void { }

	//// { "title": "Multi-inherit - no rename to interface", "oldName": "yetAnotherMethod", "newName": "interfaceMethod", "expected": "no" }
	yetAnotherMethod(): void { }
}

// Const enum tests
const enum ConstEnum {
	//// { "title": "Const enum - rename", "oldName": "A", "newName": "D", "expected": "yes" }
	A = 1,
	B = 2,
	//// { "title": "Const enum - no rename to existing", "oldName": "C", "newName": "B", "expected": "no" }
	C = 3
}

// Deep inheritance hierarchy tests
class GrandBase {
	grandMethod(): void { }
}

class ParentClass extends GrandBase {
	parentMethod(): void { }
}

class ChildClass extends ParentClass {
	//// { "title": "Deep inheritance - rename", "oldName": "childMethod", "newName": "newChildMethod", "expected": "yes" }
	childMethod(): void { }

	//// { "title": "Deep inheritance - no rename to grandparent", "oldName": "anotherChildMethod", "newName": "grandMethod", "expected": "no" }
	anotherChildMethod(): void { }

	//// { "title": "Deep inheritance - no rename to parent", "oldName": "thirdChildMethod", "newName": "parentMethod", "expected": "no" }
	thirdChildMethod(): void { }
}

// Interface inheritance chain
interface ILevel1 {
	level1Method(): void;
}

interface ILevel2 extends ILevel1 {
	level2Method(): void;
}

interface ILevel3 extends ILevel2 {
	//// { "title": "Interface chain - rename", "oldName": "level3Method", "newName": "uniqueLevel3", "expected": "yes" }
	level3Method(): void;

	//// { "title": "Interface chain - no rename to grandparent interface", "oldName": "otherLevel3", "newName": "level1Method", "expected": "no" }
	otherLevel3(): void;
}

// Static members tests
class StaticClass {
	static staticPropA: number = 1;

	//// { "title": "Static property - no rename to existing", "oldName": "staticPropB", "newName": "staticPropA", "expected": "no" }
	static staticPropB: string = "test";

	static staticMethodA(): void { }

	//// { "title": "Static method - no rename to existing", "oldName": "staticMethodB", "newName": "staticMethodA", "expected": "no" }
	static staticMethodB(): void { }
}

// Private member tests
class PrivateClass {
	private privatePropA: number = 1;

	//// { "title": "Private property - no rename to existing", "oldName": "privatePropB", "newName": "privatePropA", "expected": "no" }
	private privatePropB: string = "test";

	private privateMethodA(): void { }

	//// { "title": "Private method - no rename to existing", "oldName": "privateMethodB", "newName": "privateMethodA", "expected": "no" }
	private privateMethodB(): void { }
}

// Protected member tests
class ProtectedClass {
	protected protectedPropA: number = 1;

	//// { "title": "Protected property - no rename to existing", "oldName": "protectedPropB", "newName": "protectedPropA", "expected": "no" }
	protected protectedPropB: string = "test";
}

// Module export tests
namespace ExportModule {
	export function exportedFuncA() { }

	//// { "title": "Module export function - no rename to existing", "oldName": "exportedFuncB", "newName": "exportedFuncA", "expected": "no" }
	export function exportedFuncB() { }

	export class ExportedClassA { }

	//// { "title": "Module export class - no rename to existing", "oldName": "ExportedClassB", "newName": "ExportedClassA", "expected": "no" }
	export class ExportedClassB { }
}

// Optional member tests
interface OptionalInterface {
	//// { "title": "Optional property - rename", "oldName": "optionalPropA", "newName": "optionalPropC", "expected": "yes" }
	optionalPropA?: string;

	//// { "title": "Optional property - no rename to existing", "oldName": "optionalPropB", "newName": "optionalPropA", "expected": "no" }
	optionalPropB?: number;
}

// Computed property tests
class ComputedPropertyClass {
	readonly NAME_KEY = "name" as const;

	readonly readonlyPropA: string = "test";

	//// { "title": "Readonly property - no rename to existing", "oldName": "readonlyPropB", "newName": "readonlyPropA", "expected": "no" }
	readonly readonlyPropB: number = 42;
}