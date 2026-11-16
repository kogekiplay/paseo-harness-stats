Harness Stats shows DeepSeek Harness-style session readings beside the Paseo composer: turns, model steps, output speed, token totals and cache hit. Each reading opens its own anchored popover. The footer keeps a fixed height, cached readings survive workspace switches, and colors and highlighted states follow the active Paseo theme. A settings page controls visibility and mobile placement.

Requires Paseo 0.15.4 or later and local Codex or Claude Code session logs on the connected daemon. Desktop and web use a composer footer. Current 0.15.4 native clients use the track above the input; positioning them below requires a client build with the footer extension supplied in the repository.

History from before installation is included. Visible sessions refresh every two seconds. Token totals include input and output, counting cache reads and writes once. Model steps count responses with usage; requests without usage cannot be counted. Subagent sessions are separate.

TTFT is inferred where supported: Codex requires model-output start timestamps in newer logs; Claude requires an initial thinking block with a duration. Unavailable metrics show a dash. Time and speed use log timestamps and are not equivalent to live upstream instrumentation. The interface keeps the DSH labels without extra markers.

The plugin reads CODEX_HOME or ~/.codex and CLAUDE_CONFIG_DIR or ~/.claude. It sends aggregate readings only to the connected Paseo client, makes no external statistics requests and does not alter session files. The desktop footer uses a DOM adapter that may need updates when the host layout changes.
