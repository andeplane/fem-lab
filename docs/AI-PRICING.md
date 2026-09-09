# Assistant model pricing

Issues: #25, #486. Rates checked on 2026-09-09. The OpenAI Responses adapter is introduced
by #156 / PR #160; this change uses that adapter and its opaque reasoning continuation.

The displayed cost is an estimate in USD for Standard text/image-token requests,
not an invoice. OpenAI requests explicitly select `service_tier: "default"`.
Account-specific discounts, regional processing surcharges, taxes and separately
billed tools are not included. Model IDs are checked against the installed SDK's
closed `ChatModel` union; that checks spelling, not account access.

| Model | Input / million | Cached read / million | Cache write / million | Output / million |
| --- | ---: | ---: | ---: | ---: |
| [gpt-6-astra](https://developers.openai.com/api/docs/models/gpt-6-astra) | $10 | $1 | $12.50 | $50 |
| [gpt-5.6-sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol) | $4 | $0.40 | $5 | $20 |
| [gpt-5.6-terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra) | $2 | $0.20 | $2.50 | $12 |
| [gpt-5.6-luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) | $0.20 | $0.02 | $0.25 | $1.20 |
| [gpt-5.5](https://developers.openai.com/api/docs/models/gpt-5.5) | $5 | $0.50 | unknown | $30 |
| [gpt-5.4-mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini) | $0.75 | $0.075 | unknown | $4.50 |

For Astra, Sol, Terra, Luna and 5.5, requests with more than 272,000 input tokens, including
cache reads, charge twice the input/cache rates and 1.5 times the output rate
for the whole request. The published mini rates have no corresponding uplift.
The agent prices each request separately before adding costs across tool rounds;
summing token counts first would incorrectly turn several short contexts into a
long one. Output usage includes reasoning tokens reported by the API.

`Usage.input` excludes cached reads but includes cache writes. `Usage.cacheWrite`
is the write subset of that input, so writes are charged once at their write rate.
An unknown model or a nonzero cache-write count without a verified write rate
returns an unknown cost rather than inventing a rate. Existing Anthropic rates
are outside this issue's pricing update.

When updating the SDK or model list, check the official model pages and
[pricing documentation](https://developers.openai.com/api/docs/pricing), update
`PRICES` and this date/table together, and run the pricing, provider and agent
regressions. Include threshold, cached-token and multiple-tool-round cases.
The adapter's mocked Responses tests validate request shapes and usage mapping;
they do not establish live account availability.
