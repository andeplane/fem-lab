# Using the Assistant

The Assistant can discuss a Model, inspect it with Queries, propose changes and execute permitted registry operations. It is optional: geometry, meshing, solving and export remain available without AI. You remain responsible for deciding whether its assumptions and engineering conclusions are appropriate.

## Hosted access

On the public app, sign in through Account using Google or an email link. Accept the hosted-data disclosure before sending a request. You also need an available free or paid allowance; signup alone grants none. See [accounts and credits](./accounts-billing.md).

Your messages and the context needed for the request pass through FEM Lab to the configured model provider. Context can include Model definitions, earlier messages, tool arguments/results, project-file excerpts and screenshots. Local storage does not mean an Assistant request stays on the device. Read the [Privacy notice](https://femlab.app/privacy.html) before including confidential data.

On the start screen, describing an analysis creates an **unsent draft**. **Sign in to continue** opens Account; the same-tab draft remains editable after authentication. **Review in assistant** moves it into the Assistant without sending it. Nothing goes to hosted AI until you choose **Send** there and complete the disclosure/allowance requirements. Starting local modeling does not require using that draft or signing in.

## Give a bounded engineering task

A useful prompt names the objective, units, simplification and check. For example:

> Inspect this cantilever's active supports and Loads. Report the total applied force and support reaction, compare the tip displacement with beam theory, and explain any assumptions before changing the Model.

Use the tree's `@` buttons to reference a Body, Material, Set, Load, Step, Mesh or retained Result. An immutable Result reference belongs to that solve/session; if evicted or cleared, it becomes unresolved rather than silently selecting another solve. For names with spaces, quoted references preserve the exact target.

Ask for observations before a large edit, review the proposed material/units and read tool output. Tool availability is a capability, not an independent proof that a generated analysis is correct. Account identity, payment, free eligibility and disclosure actions require explicit user operations; the Assistant cannot award itself credits or complete Checkout.

## Messages, tools and stopping

Choose a model from the menu. Enter sends; Shift+Enter adds a newline. During an active answer, Enter can queue a message; an empty composer can interrupt and advance the queue after the current tool finishes. Tool cards show arguments/results, with large or image payloads handled separately.

Stopping a stream does not guarantee zero supplier usage. A request may already have consumed tokens or completed a tool. The service settles authoritative usage or holds it for reconciliation; reconnecting or retrying should not be treated as a new free request. Inspect the account's remaining/reserved balance when unsure.

## Hosted versus direct/development mode

The production hosted route uses account identity and service-owned providers. Direct/development hosts can expose provider-key settings and a different model catalogue. Direct keys are persisted in that browser's storage and are not production account credentials. Do not put keys into Scripts, Journals, Model names or shared links. A development-only control being present in source does not mean the public product exposes it.

Use [verification](./results-verification.md), mesh/time studies and independent references for numerical decisions. The Assistant does not replace those checks.
