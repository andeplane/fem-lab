# FEM Lab account and AI service

The Node host is separate from the headless Rust engine. It shares provider blocks,
completed tool/continuation events and versioned request schemas with the browser
through `@femlab/ai`. OpenAI clients, identity, storage, clock and request IDs are
host dependencies. This first slice (#546) supplies the protocol and HTTP host;
it does not yet admit an inference or claim that billing/login are implemented.

`npm run build -w packages/service`, then `PORT=8087 npm start -w packages/service`.
`GET /healthz` proves the process is live; `/readyz` remains 503 until real service
adapters are configured. Unknown routes return a structured error and never echo
request bodies or credentials. Later slices add the typed API and injected adapters.
