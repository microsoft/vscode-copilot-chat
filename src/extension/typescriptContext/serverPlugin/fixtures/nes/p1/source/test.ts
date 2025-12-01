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