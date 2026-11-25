# Compare local SQL proposals

Run **Rocketbrain: Compare Local SQL Proposals** with a live MySQL or MariaDB catalog in a trusted workspace. Use the [local SQL assistant settings](local-sql-assistant.md) to select the loopback server and model.

1. Select **New Review** and describe two or three read-only queries or alternative approaches.
2. Choose the tables and columns the local model can see. Confirm the endpoint, model, projected schema, and each request in **Start Proposals**.
3. Compare the proposals as they arrive. Each starts with the same approved metadata and its own request. **Cancel** stops an individual pending response. **Reject** removes a completed proposal.
4. Use **Review SQL** to inspect the exact statement. **Mark Reviewed** approves those bytes for **Open in SQL Editor**, which opens an untitled SQL document. Run it separately after checking the target database.

Changing the connection, reloading the catalog, changing model settings, or closing the panel cancels outstanding requests and invalidates approvals. The review panel holds the batch in memory. A SQL document you explicitly open follows normal VS Code editor and save behavior.

The workbench starts independent requests against the selected model. Inference can run in parallel when the endpoint has multiple slots. It supports the local SQL assistant's static SELECT scope. External agent protocols, database writes, and agent-side database access are outside the current scope.
