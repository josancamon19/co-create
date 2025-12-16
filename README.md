# Co-Create: Open Source Coding Dataset

**Coding SOTA must be open-source.**

An open dataset of human and AI coding interactions, built by the community.

## The Vision

The best coding AI models are trained on data we can't see. We're changing that.

By leveraging the open source community—developers who already build in public—we can create an **infinitely scalable dataset** of real coding environments. Not synthetic benchmarks, not curated examples, but actual development sessions capturing how humans and AI agents collaborate on real software.

### What Makes This Different

- **Multi-source**: Human edits, AI agent changes, tab completions—all tracked separately
- **Multi-modal interactions**: Chat-based agents (Composer), inline edits (Cmd+K), autocomplete
- **Full context**: Not just the final code, but the prompts, responses, thinking traces, and tool usage
- **Real environments**: Actual projects with git history, file structures, and dependencies
- **Cross-referenced**: Changes linked to commits, sessions, and agent interactions

### Levels of Abstraction Captured

| Level | What's Captured |
|-------|-----------------|
| **Keystroke** | Individual edits, tab completions |
| **Interaction** | Prompts → Agent responses → Code changes |
| **Session** | Full development sessions with multiple interactions |
| **Project** | Git history, file structure, multi-session context |

## How It Works

1. **Install the Extension** in Cursor
2. **Code normally** - the extension silently tracks changes
3. **Contribute** when ready - upload your traces to the shared dataset
4. **Browse** contributions from the community

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Cursor    │────▶│  Extension  │────▶│ GCP Bucket  │
│   Editor    │     │  (SQLite)   │     │  (Dataset)  │
└─────────────┘     └─────────────┘     └─────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │  Dashboard  │
                    │  (Viewer)   │
                    └─────────────┘
```

## Data Collected

For each code change, we capture:

```typescript
{
  source: 'human' | 'agent' | 'tab-completion',
  agent_subtype: 'composer' | 'cmdk' | null,
  agent_model: string,        // e.g., "claude-sonnet-4-20250514"
  agent_prompt: string,       // User's instruction
  agent_response: string,     // Agent's full response
  agent_thinking: string,     // Extended thinking (if enabled)
  agent_tool_usage: object[], // Tools called
  agent_input_tokens: number,
  agent_output_tokens: number,
  file_path: string,
  diff: string,               // Unified diff format
  lines_added: number,
  lines_removed: number,
  commit_id: string,
  timestamp: string
}
```

## Getting Started

### Install the Extension

```bash
# Clone and build
git clone https://github.com/josancamon19/co-create
cd co-create
npm install
npm run compile

# Install in Cursor (Developer mode)
# Or install from marketplace: cursor://josancamon19.cursor-interaction-collector
```

### View the Dashboard

Visit the [Co-Create Dashboard](https://storage.googleapis.com/co-create-dataset/dashboard/index.html) to:
- Browse community contributions
- View trace data with diff visualization
- See agent interaction flows

### Contribute Your Data

In Cursor, run the command: **"Contribute Data to Research"**

This uploads your local traces to the shared dataset and creates a GitHub issue documenting your contribution.

## Project Structure

```
co-create/
├── src/
│   ├── extension.ts              # Entry point
│   ├── collectors/
│   │   └── diff.ts               # Diff tracking & classification
│   ├── agent/
│   │   └── monitor.ts            # Agent activity detection
│   ├── session/
│   │   └── manager.ts            # Session lifecycle
│   ├── database/
│   │   ├── connection.ts         # SQLite (sql.js)
│   │   └── schema.ts             # Data models
│   └── services/
│       └── contribution.ts       # GCP upload & GitHub issues
├── dashboard/
│   ├── index.html                # Landing page
│   ├── contributions.html        # Browse contributions
│   ├── viewer.html               # Trace viewer
│   └── deploy.sh                 # GCP deployment script
└── todo.md                       # Roadmap
```

## Roadmap

See [todo.md](./todo.md) for the full list. Key items:

- [ ] **Improve classification accuracy** - Better human/agent/tab-completion detection
- [ ] **Terminal command tracking** - Capture shell input/output
- [ ] **Multi-step task tracking** - Link related interactions into task sequences
- [ ] **Agent thinking & tool traces** - Full reasoning chains
- [ ] **Commit-aware sessions** - Reference git diffs between commits
- [ ] **Expand to other agents** - Claude Code, Codex CLI support
- [ ] **Contribution deduplication** - Handle overlapping uploads
- [ ] **Approval workflow** - Review process for contributions

## Privacy & Data

- **Opt-in only**: Nothing is uploaded without explicit action
- **Local first**: All data stays in `.cursor-data/collector.db` until you choose to contribute
- **Transparent**: You can inspect all collected data before uploading
- **Open**: The dataset is publicly accessible for research

## Contributing

We welcome contributions! Whether it's:
- **Code contributions** to improve the extension
- **Data contributions** from your development sessions
- **Ideas** for what to capture or how to structure the data

## License

MIT

---

*Built for researchers, by developers who believe coding AI should be open.*
