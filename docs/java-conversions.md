# Java lambda, anonymous class and loop conversions

In an imported Java project, save the source, place the caret in the initializer or supported loop, and run **Rocketbrain: Convert Java Lambda, Anonymous Class or Loop**. Review the before and after diff, then apply it. The editor buffer retains control of saving the change.

The action can convert a local lambda into an anonymous class or reverse the conversion when the variable is used only to call its single abstract method in the same execution boundary. It supports selected standard interfaces and named project interfaces with a single effective abstract method, including parameterized interfaces and source-visible parents. Javac compares the target interface, parameters, body, captured locals and bound method overloads across the change.

The action checks single-expression implementations and the supported one-statement bodies. It requires saved project sources, a JDT edit limited to the selected syntax and an unchanged classpath. It rejects receiver-sensitive bodies, escaping or identity-sensitive variables, comments inside the replacement, and custom interfaces with nonconstant fields or unresolved parent source. Generic abstract methods and general loop rewrites are outside the supported range.

The loop action converts a primitive-array index loop into enhanced for when the index only selects the array element and the loop body adds that element to a local accumulator.

## Extract Java Method

Select two or more complete trailing statements in a saved, non-void Java method, including its final return. Run **Rocketbrain: Extract Java Method** from the editor code action or Command Palette and name the new private helper. Review the two edits before applying them. The helper moves the selected statements with their comments. It carries over the method's type parameters and declared exceptions and passes captured method parameters and locals by their attributed types.

The action checks conditional return and throw paths, local declarations and ordinary expressions. Javac verifies the moved syntax, referenced declarations, selected overloads, and the new call and its arguments. The action refuses captured assignments, name conflicts, partial selections and constructs with nonlocal control flow. It operates on saved production sources in imported classpath projects. JDT's existing expression extraction remains available.
