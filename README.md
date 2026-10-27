# gainforest-infra

Operational tooling for GainForest that runs outside the web app.

| Directory | What it does | Where it runs |
|---|---|---|
| [`audio-archive/`](audio-archive/) | Backs up AudioMoth original recordings from Cloudflare R2 to the shared archive bucket | bumi-0, hourly via launchd |
| [`hyperindex-lexicon-updates/`](hyperindex-lexicon-updates/) | Lexicon zips and upload scripts applied to the GainForest Hyperindex (api-hi) | run by hand |
