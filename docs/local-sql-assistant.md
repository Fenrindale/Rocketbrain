# Local SQL drafting and explanation

Point `rocketbrain.localSqlAssistant.endpoint` to a local Chat Completions server at `http://127.0.0.1:<port>/v1/chat/completions` or `http://[::1]:<port>/v1/chat/completions`. Set `rocketbrain.localSqlAssistant.model` to the model name the server exposes. The server needs to accept Chat Completions with JSON Schema output. The extension sends requests directly to the numeric loopback endpoint. [llama.cpp Chat Completions documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#post-v1chatcompletions-openai-compatible-chat-completions-api)

Connect to MySQL or MariaDB and use **Rocketbrain: Draft SQL with Local Model**. Describe the query and choose the tables and columns to share. **Rocketbrain: Explain SQL with Local Model** uses a selected read-only SELECT in the SQL editor. Explanation input omits literals and comments and replaces local aliases. The confirmation shows the exact request data, including the chosen schema metadata. Add only information you intend to share in a draft request.

The assistant sends selected table and column names, basic type names and relationships fully contained in that selection. It uses one statement at a time. A draft must pass Rocketbrain’s read-only SQL policy and static checks against the approved set. Review a draft in the SQL editor before running it. The assistant opens drafts and plain-text explanations and reports its model and context.

Requests cover up to six tables, 48 columns, 8 KiB of metadata and 4 KiB of input. A local model can decline a request, return invalid output, or time out after 30 seconds. The assistant reports those failures without opening an SQL draft. Model quality depends on the selected model and supported query grammar.

The test fixture uses a separately obtained llama.cpp CPU runtime and Qwen2.5-Coder‑1.5B‑Instruct weights. The installed extension uses the local endpoint you configure. The integration test requires `ROCKETBRAIN_LOCAL_MODEL_BIN` and `ROCKETBRAIN_LOCAL_MODEL_GGUF` with absolute fixture paths. [Qwen model card](https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF)

## Explore related tables

Run **Rocketbrain: Explore Schema with Local SQL Model** in a trusted workspace connected to MySQL or MariaDB. Choose the first table, then select the observed foreign keys that extend the route. Each join picker shows the constraint and its column pairs. Choose the columns the model can use, describe the query, and review the metadata and request before sending them to the local endpoint.

The model requests columns, standard aggregates, grouping, sorting, and a bounded result size. Rocketbrain builds the SQL from the approved columns and joins. Review the exact draft in the SQL editor. **Refine with Same Schema** carries forward the prior reviewed plan choices. The next request preview shows those choices alongside the follow-up. Model inference sends the shown identifiers, types, selected key mappings, plan choices, and the current prompt. Database rows, column defaults, column comments, and the prior explanation stay local to their original surfaces.

Use **Rocketbrain: Continue Grounded SQL Exploration** to resume from the latest reviewed draft after leaving the prompt or closing its tab. Rocketbrain checks the selected connection, model, schema and foreign keys, then reopens the exact reviewed SQL if the tab was closed. A change to the open draft blocks continuation until you close it and reopen the reviewed SQL. **Rocketbrain: Show Grounded SQL Exploration Transcript** opens a read-only record of the approved scope, reviewed drafts and changes in selected columns, aggregates, sorting and limits.

The workspace window retains up to four explorations for ten minutes from the first preview. Each allows four reviewed turns and six model requests. Changing the connection or model settings clears the in-memory history. Follow-ups send the currently approved prompt and the previous structured plan. Prior SQL, model explanations and transcript contents remain local.

**Inspect Estimated Plan** asks for separate approval. It obtains an estimated JSON plan using a dedicated read-only database transaction and checks the selected table and foreign-key metadata with the tables pinned. The generated `SELECT` remains a draft for manual use. This workflow covers two to four distinct InnoDB tables in one schema, up to 24 selected and join columns, foreign-key inner joins, and 1 to 500 results. Complex filters, outer joins, views, and cross-schema routes are outside its structured query model. Correct interpretation of a natural-language request still requires reviewing the SQL and its result expectations.

To compare separate requests assigned to locally configured ACP peers, open [Database ACP task review](acp-database-tasks.md).
