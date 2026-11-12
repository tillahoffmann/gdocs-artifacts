# Contributing

## Setup

Node 22 or later. `npm install`, then `pipx run pre-commit install` (or `pre-commit install`) to run lint,
format, typecheck and tests before each commit.

## Tests

`npm test` runs everything. Tests that call Google run once per account configured in `.env` (see
`.env.example`) and are skipped without one, as in CI. The first run signs in through the browser and saves
the refresh token to `.env`.

## Renderer fixture

The renderer tests run offline on `test/fixtures/doc.json`, the JSON of a real doc built by
`test/render.test.ts`. To see what the fixture looks like in Google Docs, open the doc:
https://docs.google.com/document/d/17WiXL47IJFSgzTREfMWyaSBnbBlFgdw15tRsr3VeXvs/edit

To rebuild it (for example after adding a case), run `GDOCS_REGENERATE=1 npx vitest run test/render.test.ts`
with the personal account configured. It creates a new doc and prints its URL: update the link above,
update the IDs in the expected output in `test/render.test.ts`, and delete the old doc.
