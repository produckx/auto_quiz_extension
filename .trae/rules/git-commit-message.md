---
alwaysApply: true
scene: git_message
---

Generate short, clear, and meaningful Git commit messages.

Rules:
- Use Conventional Commits format: `type: description`.
- Keep the message under 72 characters.
- Use English.
- Use imperative mood (Add, Fix, Update, Remove, Refactor).
- Describe what changed, not why.
- Avoid unnecessary details and vague words.
- Use only one line.
- Do not include issue numbers unless provided.

Commit types:
- `feat`: Add new features.
- `fix`: Fix bugs.
- `update`: Update existing functionality.
- `refactor`: Improve code without changing behavior.
- `style`: UI or formatting changes.
- `docs`: Documentation changes.
- `test`: Add or update tests.
- `chore`: Configuration, dependencies, or maintenance.
- `perf`: Performance improvements.
- `remove`: Remove unused code or files.

Examples:
- `feat: add user authentication`
- `fix: resolve login validation error`
- `update: improve dashboard layout`
- `refactor: simplify API response handling`
- `style: adjust button spacing`
- `docs: update installation guide`
- `chore: update dependencies`

Always generate the commit message based on the actual code changes.