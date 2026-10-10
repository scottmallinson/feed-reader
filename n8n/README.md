# n8n: feed research to Obsidian and email

[`feed-research.workflow.json`](feed-research.workflow.json) is an n8n workflow that runs a
research prompt against your feeds and sends you the result:

```
Every morning (07:00) ─┐
                       ├─▶ Config ─▶ Research agent ─▶ Build note ─┬─▶ Save to Obsidian (Personal/Research)
Run manually ──────────┘              │         │                  └─▶ Markdown to HTML ─▶ Email results
                                      │         └─ Feed reader MCP (reader.scottmallinson.com/mcp)
                                      └─ Gemma (Ollama)
```

1. **Config** holds the prompt and the destinations.
2. **Research agent** (n8n's AI Agent) runs Gemma through Ollama. It can call three of the
   feed reader's MCP tools: `list_feeds`, `search_feed_items` and `get_full_article`.
   `mark_as_read` is left out, so a scheduled run never changes your reader state.
3. **Build note** takes the agent's Markdown answer and adds front matter (`created`, `source`,
   `tags`) and the prompt as a collapsed callout. It names the note
   `Research/<yyyy-MM-dd HHmm> <title>.md`, using the title from the answer's first heading.
4. **Save to Obsidian** writes the note into the Personal vault through the
   [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin.
   **Email results** sends the same answer to scott@scottmallinson.com as HTML, with an
   `obsidian://` link to the saved note. Both steps run from **Build note**, and **Save to
   Obsidian** is set to continue on error, so if Obsidian is unreachable you still get the email.

## Setup

The workflow is already in the n8n instance at automation.scottmallinson.com, as **Feed reader
research → Obsidian + email** (inactive). It uses the existing **Ollama account** and **Gmail
account** credentials there. To set it up somewhere else, import the file in n8n (**Workflows → Import from File**). It needs a recent n8n whose MCP Client
Tool node is version 1.2 or later, for the HTTP Streamable transport. Then fill in the following.

### The prompt (TBD)

Open **Config** and replace the placeholder `prompt`. Until you do, the workflow runs a generic
"briefing on this week's unread articles" prompt, so you can test it end to end. You can name
feeds or boards in the prompt ("from my Arxiv and r/LocalAI feeds") and the agent will pass them
to `search_feed_items`. The system message (**Research agent → Options**) covers how to use the
tools and the output format, so the prompt only has to say what to research.

### Gemma via Ollama

- Create an **Ollama** credential whose base URL points at your Ollama server (for example
  `http://ollama:11434` when n8n and Ollama share a Docker network), and select it on
  **Gemma (Ollama)**.
- On that server, run `ollama pull gemma4`. The agent depends on tool calling. Gemma 4 supports
  it in Ollama; no Gemma 3 tag does, and Ollama rejects them with "does not support tools". For
  a specific size, change the model on the node (for example `gemma4:e4b` for a small GPU, or a
  larger tag if you have the memory). Larger models follow multi-step tool use more reliably.
- The node sets `numCtx` to 32768, because Ollama's default context is too small for the tool
  definitions plus several full articles. Lower it if the model runs out of memory.

### Feed reader MCP

Create a **Bearer Auth** credential with the deployment's `API_TOKEN` and select it on
**Feed reader MCP**. Use a credential made for the feed reader only. n8n preselects whichever
Bearer credential already exists, and any other service's token would be sent to the feed reader. The endpoint is `https://reader.scottmallinson.com/mcp`, the stateless
Streamable HTTP server described in the [main README](../README.md#mcp-server).

### Obsidian (Personal vault, Research folder)

1. In the **Personal** vault, install and enable the **Local REST API** community plugin and
   copy its API key. The plugin serves the vault it is enabled in, so it has to be this one.
2. Set `obsidianApiUrl` in **Config** to the address where n8n can reach the plugin, by default
   `https://<host>:27124`. n8n has to reach that machine, for example over your LAN or
   Tailscale, and Obsidian must be running when the workflow runs.
3. Create a **Bearer Auth** credential with the API key and select it on **Save to Obsidian**.
   (The live copy uses n8n's templated custom auth instead, because n8n's builder won't create
   new plain bearer credentials on HTTP Request nodes. Give it the header
   `Authorization: Bearer <API key>`.)
   That node accepts the plugin's self-signed certificate. If you enable the plugin's HTTP port
   (27123), use `http://` instead.

The node `PUT`s to `/vault/Research/<file>.md`. If the first run fails with a missing-folder error,
create `Research` in the vault. To write somewhere else, change `obsidianFolder` (and `obsidianVault`, which only
feeds the `obsidian://` link in the email).

If n8n can see the vault's folder on disk instead (a synced or mounted directory), you can swap
**Save to Obsidian** for a **Read/Write Files from Disk** node that writes `{{ $json.content }}`
to `<vault path>/{{ $json.notePath }}`.

### Email

**Email results** is a Gmail node: select a Gmail credential on it. `emailTo` in **Config** is
scott@scottmallinson.com. To send through SMTP or Outlook instead, replace the node and keep its
subject and HTML expressions.

### Schedule

**Every morning** fires daily at 07:00 in the workflow's time zone (**Workflow settings →
Timezone**, or the instance default). Change the rule or delete the node and use **Run manually**
alone. Activate the workflow to start the schedule.

## Troubleshooting

- **"does not support tools"** comes from Ollama: the model on **Gemma (Ollama)** can't call
  tools. Use a `gemma4` tag.
- **The agent answers without searching**, or invents articles: open the execution, check the
  agent's tool calls, and try a larger Gemma tag or a more specific prompt (name the feeds or
  boards and the time window).
- **401 from Feed reader MCP**: the Bearer credential doesn't match `API_TOKEN`.
- **Save to Obsidian times out**: n8n can't reach `obsidianApiUrl`, or Obsidian isn't running.
