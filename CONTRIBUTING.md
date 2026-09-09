# Contributing

Thanks for your interest in contributing to **AI Usage Monitor for Stream Deck+**.

## Reporting Issues

Use the GitHub issue tracker to report bugs, feature requests, or questions.
Include as much detail as possible:

- Steps to reproduce the issue
- Expected vs. actual behavior
- Plugin version and Stream Deck+ firmware
- Relevant log files (`com.barbatdev.ai-usage.sdPlugin/logs/`)

## Pull Requests

1. Fork the repository and create a feature branch from `main`.
2. Make your changes. Ensure the build passes:

   ```sh
   pnpm install --frozen-lockfile
   pnpm check:workspace
   pnpm test:workspace
   pnpm build
   ```

3. Add tests for new functionality. Run the full test suite:

   ```sh
   pnpm test:workspace
   ```

4. Submit a pull request with a clear description and any relevant screenshots or logs.

## Code Style

- TypeScript strict mode is enforced.
- Follow existing patterns in the codebase — no comments in production code.
- Keep changes focused and reviewable.

## License

By contributing, you agree that your contributions will be licensed under the
MIT License.

## Package metadata

All packages in this workspace are marked `private: true` and are not published to npm.
They are internal modules consumed by the Stream Deck plugin bundle.
The `@barbatdev` scope matches the GitHub organization and provides a consistent name for internal development.