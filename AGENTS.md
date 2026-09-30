# AGENTS.md

- For any change, update the relevant documentation in `docs/` first.
- Follow declarative design: define the desired end state, constraints, and data-driven mappings
  (schemas, stage tables, op reducers) before implementation details.
- Every code change includes or updates the related unit, integration, and e2e tests.
- Keep code maintainable and observable: structured logs with job/project ids, metrics for new
  background work, typed errors with stable codes.
- The UI must be responsive. UI changes need e2e coverage at desktop and mobile viewports.
- Frontend work follows `docs/brand.md` (tokens, typography, components).
- Domain types live in `packages/shared` and are validated with zod at every boundary (REST, MCP,
  WebDAV documents, LLM output).
- Image/video/music generation goes through `@sloth-os/mm-gateway-js`. Every other AI call goes through
  the mm-gateway `/proxy/{domain}/{path}` surface (`packages/server/src/gateway/proxy-client.ts`).
  Never call a provider directly.
- REST handlers and MCP tools must call the same application service (`packages/server/src/domain`)
  so both surfaces behave identically.
- Before handoff, commit after the required verification passes.
