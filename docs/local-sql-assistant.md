# Local SQL drafting and explanation

Point `rocketbrain.localSqlAssistant.endpoint` to a local Chat Completions server at `http://127.0.0.1:<port>/v1/chat/completions` or `http://[::1]:<port>/v1/chat/completions`. Set `rocketbrain.localSqlAssistant.model` to the model name the server exposes. The server needs to accept Chat Completions with JSON Schema output. The extension sends requests directly to the numeric loopback endpoint. [llama.cpp Chat Completions documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#post-v1chatcompletions-openai-compatible-chat-completions-api)

Connect to MySQL or MariaDB and use **Rocketbrain: Draft SQL with Local Model**. Describe the query and choose the tables and columns to share. **Rocketbrain: Explain SQL with Local Model** uses a selected read-only SELECT in the SQL editor. Explanation input omits literals and comments and replaces local aliases. The confirmation shows the exact request data, including the chosen schema metadata. Add only information you intend to share in a draft request.

The assistant sends selected table and column names, basic type names and relationships fully contained in that selection. It uses one statement at a time. A draft must pass Rocketbrain’s read-only SQL policy and static checks against the approved set. Review a draft in the SQL editor before running it. The assistant opens drafts and plain-text explanations and reports its model and context.

Requests cover up to six tables, 48 columns, 8 KiB of metadata and 4 KiB of input. A local model can decline a request, return invalid output, or time out after 30 seconds. The assistant reports those failures without opening an SQL draft. Model quality depends on the selected model and supported query grammar.

The test fixture uses a separately obtained llama.cpp CPU runtime and Qwen2.5-Coder‑1.5B‑Instruct weights. The installed extension uses the local endpoint you configure. The integration test requires `ROCKETBRAIN_LOCAL_MODEL_BIN` and `ROCKETBRAIN_LOCAL_MODEL_GGUF` with absolute fixture paths. [Qwen model card](https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF)
