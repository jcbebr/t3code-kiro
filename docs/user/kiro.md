# Kiro CLI

This local build supports Kiro CLI through ACP. Install Kiro CLI on the machine running the T3 server and sign in there with `kiro-cli login`. For a company account, select **Use with Your Organization** and enter the Start URL and region provided by your organization. T3 uses that existing login; credentials remain managed by Kiro.

In **Settings → Providers**, add Kiro and enable it. If the executable is not on the server's PATH, set its full path, such as `/home/you/.local/bin/kiro-cli`. Optionally enter the name of a Kiro agent configuration. One Kiro account is supported per T3 environment; multiple threads can use that account.

Select **Kiro default** for a new thread to keep the CLI's default model. After starting a session, the models reported by Kiro become available in the picker. Conversations can resume after restarting T3 as long as their Kiro session still exists.

Kiro's native tool permissions still apply. Requests sent by Kiro appear in T3 with allow-once, deny, or cancel choices. Full access automatically accepts single-use requests; auto-accept-edits accepts edit requests. Other modes display requests for review. This does not override tools already trusted or denied by your Kiro configuration or organization.

Set the text-generation model to Kiro as well if you want all auxiliary work to stay local. Source-control writing can inherit that setting. Thread titles and branch names use local text processing in this build. Automatic commit messages and pull-request descriptions are not available; enter them manually.

This preview does not yet support attachments, plan mode, conversation rewind, or the T3 browser/device MCP tools. Your Kiro-native tools and configuration remain owned by the CLI. Web and desktop share the provider settings; mobile clients can use configured instances, but this preview has not been verified on a device.

If sign-in expires, run `kiro-cli login` again on the server machine and retry. A missing native session requires a new thread. Provider checks do not start an agent session or open a login browser.
