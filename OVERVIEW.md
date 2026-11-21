Harness Stats shows DeepSeek Harness-style session readings beside the Paseo composer: turns, model steps, output speed, token totals and cache hit. Each reading opens its own anchored popover. The footer keeps a fixed height, cached readings survive workspace switches, and colors and highlighted states follow the active Paseo theme. A settings page controls visibility and mobile placement.

Requires Paseo 0.15.4 or later and local Codex, Claude Code or Antigravity session records on the connected daemon. Antigravity support requires the daemon's built-in Node SQLite module and was verified with Antigravity CLI 1.5.13. Desktop and web use a composer footer. The 0.15.4 native clients use the track above the input. Positioning the readings below requires a client build with the footer extension supplied in the repository.

History from before installation is included. Visible sessions refresh every two seconds. Token totals include input and output, counting cache reads and writes once. Model steps count responses with usage; requests without usage cannot be counted. Subagent sessions are separate.

Codex infers TTFT from model-output start timestamps in newer logs. Claude uses the duration of an initial thinking block. Antigravity reads CLI-recorded TTFT and adds it to streaming duration for model time. Unavailable timing metrics show a dash.

The plugin reads local records under CODEX_HOME or ~/.codex, CLAUDE_CONFIG_DIR or ~/.claude, and ~/.gemini/antigravity-cli/conversations. It sends aggregate readings only to the connected Paseo client, makes no external statistics requests and does not alter session records. The desktop footer uses a DOM adapter that may need updates when the host layout changes.
