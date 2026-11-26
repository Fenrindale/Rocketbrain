# Angular template analysis

Open a file in a trusted local Angular 22 TypeScript project. Install matching Angular core, compiler, compiler CLI, language server, and language service packages in the project. The language server's declared TypeScript 6 version must be installed there as well. Use a supported standalone Node.js on PATH or set `rocketbrain.angular.nodePath`.

Run **Start Angular Template Analysis** and verify the project, TypeScript configuration, Node executable, and tool versions in the approval dialog. **Go to Definition** and hover use the Angular language service for external HTML templates and inline TypeScript templates. They resolve Angular component selectors, bindings, and template variables using the project model.

Save edits and run **Check Angular Templates** to populate Problems with Angular compiler diagnostics. The check uses a private snapshot and the project's actual template checking flags. Editing the project clears saved diagnostics. The compiler runs with emission disabled. Run **Stop Angular Template Analysis** to close the owned language server and clear its diagnostics.

The analysis is scoped to a local project with a physical installation under its `node_modules`. Navigation returns physical source locations inside that project. The verified fixture uses Angular 22.3.0, TypeScript 6.0.3 and Node.js 24.22.3. [Angular language service](https://angular.dev/tools/language-service) · [Angular template type checking](https://angular.dev/tools/cli/template-typecheck)
