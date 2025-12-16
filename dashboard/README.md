# Trace Viewer Dashboard

A web-based dashboard for visualizing SQLite traces collected by the Cursor Interaction Collector extension.

## Features

- **Load databases from URL or file**: Fetch SQLite databases directly from GCP buckets or upload local files
- **Project overview**: View repository info with links to GitHub
- **Statistics**: See breakdown of human vs agent vs tab-completion changes
- **Interactive timeline**: Browse through all code changes chronologically
- **Diff viewer**: Syntax-highlighted diff display for each change
- **Agent interaction panel**: View prompts, responses, model used, token counts, and tool usage
- **Interaction flow diagram**: Visual representation of user → agent → code flow
- **Commit links**: Direct links to GitHub commits

## Usage

### Quick Start (Static)

Simply open `index.html` in a browser. You can:
- Upload a local `.db` file
- Enter a publicly accessible URL (with CORS enabled)

### With Local Server (Recommended)

For loading databases from GCP buckets or other sources with CORS restrictions:

```bash
cd dashboard
node server.js
```

Then open http://localhost:3000

### URL Parameter

You can link directly to a database by adding a `db` query parameter:

```
http://localhost:3000?db=https://storage.googleapis.com/bucket/database.db
```

This is useful for including in PR descriptions so reviewers can view traces.

## Integration with PRs

When creating a PR, include a link to the trace viewer:

```markdown
## Trace Data
[View agent interactions](https://your-deployed-dashboard.com?db=https://storage.googleapis.com/co-create-dataset/contributions/username/timestamp.db)
```

## Deploying

The dashboard is a static single-page application. You can deploy it to:

- **GitHub Pages**: Push to a `gh-pages` branch
- **Vercel/Netlify**: Connect your repo
- **GCP Cloud Storage**: Host as a static website

For the proxy functionality (needed for CORS), deploy `server.js` to:
- Google Cloud Run
- AWS Lambda
- Any Node.js hosting

## Data Displayed

### Per Session
- Start/end times
- Total changes count
- Agent changes count

### Per Change (Diff)
- **Source**: Human, Agent (composer/cmdk), or Tab Completion
- **File path**: Full path to modified file
- **Diff**: Unified diff format with additions/deletions
- **Timestamp**: When the change occurred
- **Commit ID**: Git commit SHA (with link if GitHub)

### Agent Interactions
- **Model**: e.g., claude-opus-4.5, gpt-4, etc.
- **Prompt**: User's instruction to the agent
- **Response**: Agent's full response
- **Extended Thinking**: Agent's reasoning (if enabled)
- **Tool Usage**: List of tools called with arguments
- **Token Counts**: Input and output tokens
