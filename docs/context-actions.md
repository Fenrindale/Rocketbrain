# Context Actions

Press **Ctrl+K, Ctrl+Shift+A** on Windows and Linux or **Cmd+K, Cmd+Shift+A** on macOS. You can also run **Rocketbrain: Context Actions** from the Command Palette. Type to filter the native list, use the arrow keys to choose an action, and press Enter to run it. **Open Keyboard Shortcuts** lets you change the shortcut.

In a Java or Kotlin workspace editor, the list offers source and Spring navigation. In a SQL editor, it offers actions for that editor’s console and connection. With Query Results focused, the shortcut opens actions for the selected capture. You can also run **Rocketbrain: Query Result Actions** to return to its SQL editor or copy its rows. Outside those surfaces, the list offers workspace actions and preferences. A stopped Rocketbrain Java session adds debugger actions when available.

If the selected editor, connection or result changes while the list is open, reopen it to select an action for the current target.

## Keyboard Profile

Run **Rocketbrain: Keyboard Profile** in the Command Palette or choose **Keyboard Profile** in Context Actions. Choose the OS where you use VS Code. The optional profile has 52 shortcuts for workspace and Git navigation, Java and Spring, database work, and debugging.

| First key | Area |
| --- | --- |
| Ctrl+Shift+F8 | Workspace and Git |
| Ctrl+Shift+F9 | Java, Spring and tests |
| Ctrl+Shift+F10 | Database and results |
| Ctrl+Shift+F11 | Java debugger |

Use Cmd in place of Ctrl on macOS. Press the action letter shown in the preview after the first key. For example, the database prefix followed by **R** runs the focused SQL statement. Follow it with **G** to focus Query Results or **E** to return from that view to its query editor.

Use the workspace prefix with **T** to focus the terminal and with **E** to return to the editor group. Returning from the terminal follows VS Code's terminal chord setting. [VS Code terminal shortcuts](https://code.visualstudio.com/docs/terminal/advanced#_chords)

**Preview Keyboard Profile** compares shortcuts contributed by installed extensions. To include a current or default keybindings file, open it in VS Code first, invoke Keyboard Profile, and choose **Review Active Keybindings JSONC**. The report lists identical shortcuts, chord-prefix collisions and whether available literal contexts prove the entries cannot run together. Possible overlaps still depend on VS Code's active context and shortcut order.

Choose **Export Keybindings JSONC** to open the registered shortcuts in an untitled editor. Copy the selected entries into your VS Code user keybindings when you are ready. Use **Show Same Keybindings** in Keyboard Shortcuts to review runtime settings and use **Developer: Toggle Keyboard Shortcuts Troubleshooting** to see what your physical keyboard dispatches. [VS Code keyboard shortcuts](https://code.visualstudio.com/docs/configure/keybindings) · [Focus and when-clause contexts](https://code.visualstudio.com/api/references/when-clause-contexts)
