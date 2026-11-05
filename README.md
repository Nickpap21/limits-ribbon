# limits-ribbon

A quiet one-line ribbon above the Claude Code prompt that shows:

- **5h and weekly limits** as thin gradient gauges of what is *left*, with the time until each window resets (`↻ 2h 14m`). Teal while there is plenty, amber under 40%, red under 15%.
- **Prompt cache, warm or cold**, for the current session: a countdown to expiry (switching to `m:ss` in the last two minutes), the share of the last request served from cache, and when cold, roughly how many tokens the next turn will re-cache. A model switch or a resume after a long break shows as cold with the reason.

It draws on the terminal (thin line gauges) and in Claude Code Desktop (SVG bars and a ring, with tooltips). Collapse it with `[-]` or ctrl+x ctrl+a.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install limits-ribbon --marketplace nickpap21/limits-ribbon
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install limits-ribbon --marketplace nickpap21/limits-ribbon
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `nickpap21/limits-ribbon`, then Add plugin.

## Cache lifetime

The countdown uses the same TTL Claude Code picks: your `promptCacheTtl` setting or `CLAUDE_CODE_PROMPT_CACHE_TTL` / `FORCE_PROMPT_CACHING_5M` / `ENABLE_PROMPT_CACHING_1H` if set, otherwise 1 hour on a subscription within plan usage and 5 minutes otherwise. If that guess is wrong for you, set the ribbon's **Prompt cache lifetime** option to `5m` or `1h` in `/config`.

Rate-limit gauges only appear on claude.ai Pro/Max sessions (or behind a gateway with a spend limit), after the first reply.
