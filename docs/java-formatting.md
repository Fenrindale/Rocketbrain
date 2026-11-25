# Java Formatting

Use VS Code **Format Document** or **Format Selection** with Rocketbrain's Java formatter. It sends the Java source to the independent Eclipse JDT formatter and reads saved `.editorconfig` files up to the containing workspace folder or the nearest `root = true`. More local files and later matching sections take precedence. `unset` removes an inherited value. The standard JDT and editor settings apply when no supported rule matches. [EditorConfig specification](https://spec.editorconfig.org/), [JDT formatter](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/v1.63.0/org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/handlers/FormatterHandler.java)

The Java formatter uses `indent_style`, `indent_size`, `tab_width`, and `end_of_line`. It supports numbers for `indent_size` and `tab_width`, `indent_size = tab`, and `end_of_line = lf` or `crlf`. When logical indentation and tab width differ, tabs reach the requested tab stops and spaces fill the remaining columns. The conversion preserves Java text-block contents.

Choose **Rocketbrain: Preview Java Formatting** to review the generated diff and apply it as one unsaved edit. The active selection limits the change to that exact range. Select a complete statement or block if JDT needs surrounding whitespace. Line ending conversion is available when formatting the whole document. A changed Java buffer, disk source, or `.editorconfig` chain requires a new review.

## Kotlin Formatting

Start the configured open Kotlin language server for a trusted Gradle project. Use **Format Document**, **Format Selection**, or **Rocketbrain: Preview Kotlin Formatting**. Kotlin uses the same `.editorconfig` inheritance and four supported settings. The language server formats the Kotlin syntax and soft indentation. Rocketbrain converts verified leading code indentation to the requested tab stops while protecting quoted and raw strings, nested templates, and the interior lines of block comments. [Kotlin string syntax](https://kotlinlang.org/docs/strings.html)

Select complete lines containing a Kotlin statement or declaration to format part of a file. The review preserves the surrounding indentation context and keeps line ending conversion in whole-document formatting. Selections through strings or block comments, incomplete source, and provider edits that would alter a literal require a fresh, narrower selection.
