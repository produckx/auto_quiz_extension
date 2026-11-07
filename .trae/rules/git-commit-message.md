---
alwaysApply: true
scene: git_message
---

Generate short, clear, and meaningful Git commit messages.

Rules:
- Use Conventional Commits format: `type: description`.
- Keep the commit subject under 72 characters.
- Use English.
- Use imperative mood (Add, Fix, Update, Remove, Refactor).
- Describe what changed, not why.
- Avoid unnecessary details and vague words.
- Use only one subject line.
- Do not include issue numbers unless provided.
- Always generate the commit message based on the actual code changes.

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

Co-author rules:
- When DeepSeek AI contributes to writing or modifying code, add it as a co-author.
- Include the following attribution after the commit subject, separated by a blank line:
  `Co-authored-by: DeepSeek AI <deepseek-ai@users.noreply.github.com>`
- Include the DeepSeek GitHub profile URL as a reference:
  `https://github.com/deepseek-ai`
- Do not add co-author attribution when DeepSeek AI did not contribute.
- Never claim human authorship for AI-generated contributions.

Examples:

feat: add user authentication

Co-authored-by: DeepSeek AI <deepseek-ai@users.noreply.github.com>

fix: resolve login validation error

Co-authored-by: DeepSeek AI <deepseek-ai@users.noreply.github.com>

style: adjust button spacing