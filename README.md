# LLM RTS: a local LLM plays OpenFront

A small agent that lets a local language model (Qwen 3.5 9B in LM Studio) play [OpenFront](https://github.com/openfrontio/OpenFrontIO), a real-time strategy game, against the game's own AI on the Australia map.

The model never sees raw tiles or engine ids. It reads:

- a **graph** of the game: one node per player, edges for shared borders, attacks and alliances, turned into a short situation text;
- a **knowledge base** of game facts (checked against the engine by tests) and strategy ideas, of which only the sections relevant to the situation are given;
- a **menu** of legal options (`expand`, `attack_queensland`, `build_city`…), so every order it gives is valid.

It plays through two roles: a **strategist** that writes a plan every 30 s of game time (or when something important happens), and a **commander** that turns the plan into orders every few seconds.

## Quick start

Requirements: Node.js 24, git, and [LM Studio](https://lmstudio.ai) with `qwen/qwen3.5-9b` downloaded and its server started.

```bash
npm install
npm run setup       # fetch the OpenFront engine and the Australia map at the pinned commit
npm test            # no LLM needed
npm run check-llm   # check that LM Studio answers
npm run play        # play one match with config/match.json
```

`play` prints one line per turn and writes everything to `runs/<date>-<seed>/`: `report.md`, `turns.jsonl` (every prompt and answer), `summary.json` and map images.

Options: `--seed <text>`, `--minutes <n>`, `--model <LM Studio id>`, `--bots <n>`, `--difficulty Easy|Medium|Hard|Impossible`, `--size Normal`, and `--mock` to run the whole pipeline without an LLM.

## Repository layout

```
src/
  engine/game.ts      the OpenFront game, headless (create, submit orders, advance)
  state/observe.ts    snapshot of the state from the LLM player's side
  state/graph.ts      the player graph and the situation text
  state/render.ts     map as PNG and as text
  actions/menu.ts     legal options, chosen sites, translation to engine orders
  knowledge/kb.ts     knowledge base loading and retrieval
  llm/lmstudio.ts     LM Studio client (JSON schema output); llm/mock.ts for tests
  agent/              events, prompts, the two-role LLM player
  match.ts, report.ts the match loop and its report
  cli/                npm run play, npm run check-llm
knowledge/            the knowledge base (Markdown)
tests/                engine, graph, menu, knowledge facts, LLM client, full match
config/               match settings, pinned OpenFront commit
```

## License

AGPL-3.0 ([LICENSE](LICENSE)), because the project runs the OpenFront engine in its own process. The engine ([OpenFrontIO](https://github.com/openfrontio/OpenFrontIO), © OpenFront and contributors, AGPL-3.0) is downloaded at setup and not redistributed here; its maps are CC BY-SA 4.0 ("OpenFront"). This is an independent project, not affiliated with OpenFront.
