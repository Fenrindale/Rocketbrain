# Python type analysis

Set `rocketbrain.python.typeServerHome` to an installed open-source Pyright package folder. Configure the selected interpreter with **Select Python Interpreter**. Rocketbrain uses the standalone Node.js executable on PATH or the one set in `rocketbrain.python.typeNodePath`.

Open a Python source file in a trusted local workspace and run **Start Python Type Analysis**. The editor displays type diagnostics, typed completions, hover information and definitions. **Rename Symbol** uses Pyright's references and limits edits to the selected workspace. **Stop Python Type Analysis** ends the language-server session. Python tasks and debugpy use the workspace's selected interpreter.

Use `rocketbrain.python.typeCheckingMode` to choose the default checking mode. An existing Pyright project configuration can supply its own mode and import settings.
