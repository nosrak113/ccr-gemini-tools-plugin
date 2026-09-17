# Security policy

## Reporting a vulnerability

Please do not report security vulnerabilities in public GitHub Issues.

Use the repository's **Security** tab and select **Report a vulnerability** to submit a private report. Include a clear description, affected version or commit, reproduction steps, potential impact, and any suggested mitigation. Do not include live API keys, session data, or private conversation content.

We will acknowledge the report, investigate it privately, and coordinate disclosure after a fix or mitigation is available.

## Scope

This policy covers the source in this repository, including the local CCR gateway routes, request translation, native-tool bridge, replay database handling, and configuration guidance.

It does not cover vulnerabilities in CCR, Claude Code, Claude Desktop, Google Gemini, the operating system, or third-party services. If a report primarily affects one of those projects, report it through that project's security channel as well.

## Sensitive information

Never include Gemini API keys, local CCR configuration databases, replay databases, full prompts, tool results, or logs containing private user data in a public report. Redact them before submitting a private report whenever possible.
