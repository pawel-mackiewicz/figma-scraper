# figma-scraper

Export a Figma or FigJam file, board, slide deck, or selected node to compact JSON for LLM Harness context.

## Usage

1. 
```bash
FIGMA_TOKEN="figd_..." node figma_scraper.mjs "FIGMA_URL"
```

(Use a URL with `node-id` to export only one frame or section.)

2. Tell codex/CC/whatever_harness_you_use to implement output file

### How to get `FIGMA_TOKEN`?!?
#### LMGTFY:
`To generate a Personal Access Token in Figma, navigate to your account Settings, open the Security tab, and click Generate new token.`

## Options

```bash
node figma_scraper.mjs "FIGMA_URL" --out output.json
node figma_scraper.mjs --include-variable-aliases "FIGMA_URL"
```

By default, output goes to `<figma-file-name>-llm.json`. Use `--out <file>` to pick the output file.

`VARIABLE_ALIAS` objects are omitted by default. Use `--include-variable-aliases` to keep them in the JSON.
(not useful if you have STARTER license)

## Requirements

- Node.js 20+
- Figma access token with `file_content:read` permission

## Notes
Figma restrict to 6 API calls/month/account - I just create temp accounts to use this script. It takes about 5 minutes.

Vibe-Coded. WOMM.

## License
Do whatever you want.
