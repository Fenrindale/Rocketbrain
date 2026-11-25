# Java class diagram relationships

Run **Rocketbrain: Show Java Class Diagram** in a trusted workspace with a running Java provider. Select the imported local project to inspect. The **Relationships** selector shows all links, inheritance and nesting, field associations, or member dependencies. Use **Focus** to inspect a class and its neighbors. The external types toggle includes the attributed JDK and classpath types referenced by local declarations.

A field association points to the field's declared class or interface. It can also point to an explicit class or interface inside the field's array, generic arguments, or wildcard bounds. A member dependency points to an explicit return, parameter or throws type, an explicitly constructed class, or the declaring type of an ordinary method call. Javac resolves qualified type identities and method overloads, so identically named classes in different packages appear separately. [Javac Trees API](https://docs.oracle.com/en/java/javase/25/docs/api/jdk.compiler/com/sun/source/util/Trees.html)

Open **Relationship source links** and choose an occurrence to reveal its exact type or call in the editor. A report refers to a saved project and reviewed compiler inputs. After a source or classpath change, use **Refresh** to recompute its links. **Export Mermaid** uses the active relationship filter and external types setting. [Mermaid class diagram syntax](https://mermaid.js.org/syntax/classDiagram.html)

The diagram covers named Java declarations in the selected imported project's production source roots. Types resolved from sibling modules on that project's classpath appear as external nodes. Source navigation covers the exact local occurrence that established the link. The relationship list shows up to 100 occurrences at a time. Use the focus and relationship filters to see occurrences for a smaller part of the graph.

The current diagram represents source types and attributed ordinary calls. Runtime dependency injection, reflective references, direct method references, and project-wide JPMS topology require separate analysis. Editing the diagram does not modify Java source.
