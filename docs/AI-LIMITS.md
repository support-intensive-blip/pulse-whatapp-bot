# AI bot limits and prompt guidelines

Open AI Bots → User guide for prompt examples and testing advice. Team admins can edit a bot’s settings under Behavior → AI limits, or use the corresponding controls on Testing bot. AI Bots → Team AI budget applies to the selected team. Each limit has a clickable information button.

- Input characters: blocks oversized chat text before AI processing. The playground also keeps its existing 2,000-character ceiling.
- Context tokens: a conservative UTF-8-based estimate of the request, including system instructions, knowledge and history. The app removes older history first and rejects a request if the required messages still exceed the limit. This is not a model-specific tokenizer count.
- Output tokens: sets the provider completion limit per task. The reply limit applies even when the reply uses knowledge. A response stopped at the limit is not sent as a partial structured reply.
- Daily bot and team tokens: text-completion budgets include both live and test calls and reset at midnight IST. Either budget can stop a request. Checks use recorded usage and reserve estimated input plus output capacity for in-flight calls in the same backend process.

Zero leaves a limit unset. Keep role, tone, coding guidance, and refusal examples in the bot prompt. Call-to-Action conditions have a separate prompt.

These are text-token controls, not an exact billing cap. Audio, embeddings and unattributed traffic are outside the enforcement path. Provider token estimates and retries can differ from recorded usage. In-flight reservations are process-local; the current single-instance deployment is the supported scope.

Validation: run `node scripts/test-ai-limits.js` from backend. Tests use in-memory SQLite and a mocked model response.
