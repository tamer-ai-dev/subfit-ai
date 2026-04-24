## Sources

All limits and pricing are sourced from official provider documentation where available. When a number is community-observed (not officially published), it's flagged as such.

### Anthropic (Claude)
- Pricing: https://claude.com/pricing
- About Claude's Max plan usage (225+/900+ baselines, 50 sessions/mo): https://support.claude.com/en/articles/11014257-about-claude-s-max-plan-usage
- Using Claude Code with Pro or Max plan: https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan
- Using Claude Code with Team or Enterprise plan: https://support.claude.com/en/articles/11845131-using-claude-code-with-your-team-or-enterprise-plan
- What is the Pro plan: https://support.claude.com/en/articles/8325606-what-is-the-pro-plan
- What is the Max plan: https://support.claude.com/en/articles/11049741-what-is-the-max-plan
- Claude Code usage analytics: https://support.claude.com/en/articles/12157520-claude-code-usage-analytics
- Usage limit best practices: https://support.claude.com/en/articles/9797557-usage-limit-best-practices
- Extra usage for Max 20x plans: https://support.claude.com/en/articles/12429409-extra-usage-for-max-20x-plans
- API documentation (includes rate-limit details, cache-read exclusion): https://docs.claude.com/en/docs/intro
- Peak-hour throttling (March 2026): https://www.theregister.com/2026/03/26/anthropic_tweaks_usage_limits/
- Max 5x depleting in 1 hour (March 2026): https://www.theregister.com/2026/03/31/anthropic_claude_code_limits/
- PCWorld on limit adjustments: https://www.pcworld.com/article/3100787/anthropic-confirms-its-been-adjusting-claude-usage-limits.html
- Token limits for Claude Code (community estimates): https://milvus.io/ai-quick-reference/what-are-the-token-limits-for-claude-code
- Token limits analysis (faros.ai): https://www.faros.ai/blog/claude-code-token-limits
- Claude Code pricing 2026 (ssdnodes.com): https://www.ssdnodes.com/blog/claude-code-pricing-in-2026-every-plan-explained-pro-max-api-teams/

Note: All three community references above (milvus.io, faros.ai, ssdnodes.com) converge on the same per-5h token estimates: Pro ~44,000 tokens, Max 5x ~88,000 tokens, Max 20x ~220,000 tokens. They remain community-observed figures, not Anthropic-published values.

Note: The 225+ / 900+ 5h-window baselines come from Anthropic's support article linked above and from statements by Anthropic staff. They are described as "at least" and as a "flexible benchmark", not as an SLA. Actual limits vary with model choice, context size, peak hours, and weekly caps.

### OpenAI
- ChatGPT pricing overview: https://openai.com/chatgpt/pricing/
- Codex CLI pricing: https://developers.openai.com/codex/pricing
- ChatGPT Pro tiers FAQ: https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers

Note: 5h message limits per tier (10-60 for Plus, 50-300 for Pro $100, 200-1200 for Pro $200) are community estimates. OpenAI does not publish per-window message caps on the same format as Anthropic. Verify against your own dashboard before making plan decisions.

### Google Gemini
- Gemini pricing: https://gemini.google.com/app/pricing
- Gemini API pricing: https://ai.google.dev/pricing
- Gemini API rate limits: https://ai.google.dev/gemini-api/docs/rate-limits
- Gemini CLI: https://github.com/google-gemini/gemini-cli

### Mistral
- Vibe (agent product): https://mistral.ai/products/vibe
- Pricing overview: https://mistral.ai/pricing

Note: "Unlimited" on Pro/Team/Enterprise is Mistral's claim; no public SLA or documented fair-use cap as of April 2026. Free tier caps (6 msgs/day, 5 web searches, 30 think mode, 5 deep research, 5 code interpreter) are observed in the product UI, not in a public spec document. Take all numbers as indicative.

### GitHub Copilot
- Plans overview: https://docs.github.com/en/copilot/get-started/plans
- Premium requests concept: https://docs.github.com/en/copilot/concepts/billing/copilot-requests
- Individual billing (Pro, Pro+): https://docs.github.com/en/copilot/concepts/billing/billing-for-individuals
- Organization billing (Business, Enterprise): https://docs.github.com/en/copilot/concepts/billing/organizations-and-enterprises
- Premium requests detail: https://docs.github.com/en/billing/concepts/product-billing/github-copilot-premium-requests
- Plans at github.com: https://github.com/features/copilot/plans
- Independent cross-check references: https://githubcopilotpricing.com/ and https://pecollective.com/tools/github-copilot-pricing/

Note: A Copilot "premium request" is not equivalent to a Claude "assistant message". Premium requests use model multipliers (1x for GPT-4.1, up to 20x for advanced reasoning models like Claude Opus via Copilot). Direct numeric comparison with Claude message counts is approximate and should be treated as an order-of-magnitude indicator only. Completions (inline autocomplete) are a separate metric, not counted against the monthly premium-request allowance.

Enterprise tier pricing caveat: GitHub Copilot Enterprise at $39/user/mo requires a GitHub Enterprise Cloud subscription at $21/user/mo additionally, making the effective cost $60/user/mo.

### Research and methodology
- Liu, Christian, Dumbalska, Bakker, Dubey (2026). AI Assistance Reduces Persistence and Hurts Independent Performance. arXiv: https://arxiv.org/abs/2604.04721

### Related community tools
- ccusage (Claude Code usage tracking): https://github.com/ryoppippi/ccusage

### Important caveats
1. Rate limits are not SLAs. Providers adjust them without prior announcement.
2. "Messages" are not the same unit across providers.
3. Cache-read tokens do not count toward Claude's input-token rate limits on most models.
4. Session counting is tool-dependent.
5. "Unlimited" is a marketing claim, not a technical guarantee.
