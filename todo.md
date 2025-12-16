### TODO's:

- [ ] human/agent/tab-completion types is not super accurate, as well as agent sub types (composer, cmdk) (PRIORITY)
- [ ] collect human terminal commands as well, input <> output
- [ ] track committing and pushing as an event
- [ ] extra fields to define step i to j is atempting a task (this could happen locally or also on admin dashboard, or authenticated user)
- [ ] save into a single postgres on confirmation, that has a status there of uploads, user with only writing permissions
- [ ] Then use that to read from the dashboard.


- [ ] collect confirmed code approvals and discarded more accurately
- [ ] collect agent thinking traces, tool calls as well
- [ ] ask for committing current changes to start collection to avoid stale entry points for the initial environment
- [ ] tab completion, should store human and agents parts separately.
- [ ] can we expand this to codex/claude code usage?
- [ ] Make the dashboard from an API that reads from the buckets so we can share more stats, on how the dataset grows
- [ ] Do some sort of approval process, consider limiting permissions in file.
- [ ] how to handle if person does multiple commits in a session, or not, it'd be cool to reference commit differences