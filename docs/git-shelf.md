# Git Shelf

In a trusted local workspace, run **Rocketbrain: Shelve Git Worktree Hunks**. Select saved text hunks and review the exact patch. Give the shelf a name and confirm. Rocketbrain saves a copy before asking Git to remove the chosen hunks. Independently staged changes, unselected hunks and untracked files stay in the worktree.

Run **Rocketbrain: Manage Git Shelf** and select the target working tree, including an open linked worktree of the same repository. Choose a saved shelf and review the restore. Its original branch, commit and saved time remain available. Git applies the patch to the current files and leaves the staging area intact. A second review detects an already restored patch. A conflict or ambiguous placement leaves the saved shelf available for another review. [Git patch application](https://git-scm.com/docs/git-apply)

The shelf is stored in VS Code's local workspace state. It remains available until you choose **Delete Shelf**. If Git cannot confirm removal after saving, the shelf displays its saved-copy status so you can check the working tree before retrying.

The workflow covers ordinary tracked UTF-8 text files with consistent Git-compatible line endings, including LF and CRLF. File additions, deletions, renames, executable-mode changes, binaries, unmerged index entries, Git conversion attributes, unsaved buffers and linked file paths require a different workflow.
