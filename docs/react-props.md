# React props in TSX

Use **Check React Props** in a trusted React project with project-local TypeScript and a JSX-enabled `tsconfig.json` or `tsconfig.app.json`. The command reports real TypeScript diagnostics on JSX opening tags in the current file. It includes the current editor contents.

Enable **Rocketbrain › React › Enable Props** to use the same compiler for completion, definition and references on component attributes. Rocketbrain reports the prop type and whether it is optional, and opens locations inside the selected project. Set **Rocketbrain › React › Node Path** if the standalone Node.js executable is outside PATH.

This workflow covers TSX components with typed, named props. It uses a bounded TypeScript program rooted at the React package. Complex project references, JavaScript JSX, string-based dynamic prop names, and source edits are outside this workflow. [React TypeScript guide](https://react.dev/learn/typescript) · [TypeScript Language Service API](https://github.com/Microsoft/TypeScript/wiki/Using-the-Language-Service-API)
