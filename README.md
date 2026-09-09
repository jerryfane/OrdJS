
# OrdJS Library

## Description

OrdJS is a JavaScript library designed to provide a convenient interface for interacting with the Ordinals Recursive Endpoints. It offers a suite of methods to facilitate the retrieval of block information, inscription metadata, and content associated with satoshis. This library itself is inscribed and supports recursive importation by other inscriptions.

**Note:** This is a beta version and may contain bugs. Please use it with caution and consider contributing improvements if you encounter any issues.

---

## Version History

Below is the version history of the OrdJS library, including the inscription IDs associated with each version and additional notes or highlights.

| Version | Inscription ID                                                       | Notes                |
|---------|----------------------------------------------------------------------|----------------------|
| 0.1.0   | `3280180e7872eaef3cae589f3122f2f9527d3c1c30445cb13fc6eef03435aa66i0` | Initial beta release |
| 0.1.1   | `f35346db0fc826e3270b984c8cc219114e24321916ae19eb75ee22c7e55c6a1ei0` | Decode CBOR |
| 0.1.2   | `4123e324aa3508ae7021a43a1dfc2d9d83fc35029d092877c57234f729068526i0` | Fix getInscriptionId | 

## Usage

To use OrdJS in your project, you can import it via CDN like so:

```html
<script src="/content/<OrdJS Inscription ID>"></script>
```

An example usage is provided in the repository under `/src/content/example.html`. This demonstrates how to set up and use the library in your applications.

Once `OrdJS` is included in your project, initialize it with:

```javascript
const ord = new OrdJS('');
```

You can then use `ord` within an asynchronous function to access the library's functionality:

```javascript
async function main() {
  try {
    const inscriptionId = await ord.getInscriptionId();
    console.log('Current InscriptionId', inscriptionId);

    // Additional method calls can be made here...

  } catch (error) {
    console.error('Error:', error);
  }
}
```

This example outlines the basic structure for utilizing OrdJS within an asynchronous function, allowing for the execution of various methods provided by the library.

## Behavior notes (0.1.3-beta, not yet inscribed)

- `getSatInscriptions(sat, page, index)` treats only `''`, `null`, `undefined` and
  `NaN` as absent, so `index` `0` selects `/r/sat/<sat>/at/0` and `page` `0` lists the
  first page. Passing both `page` and `index` rejects before any request, because they
  are separate endpoints.
- `getSatLastInscriptionContent(sat)` resolves to `null` when the sat carries no
  inscription (`/r/sat/<sat>/at/-1` answers `{"id": null}`). Transport and server
  errors still throw.
- `getInscriptionContent(id)` builds its base64 payload in bounded slices, so large
  inscriptions no longer overflow the call stack.
- Only decoded metadata loads a dependency. `getDecodedMetadata` validates the hex
  first, then loads the inscribed CBOR decoder once, on demand, sharing that load
  across concurrent callers; a failed load can be retried. The Buffer polyfill
  inscription is no longer referenced at all: hex is decoded natively and rejected
  when malformed, and **no method publishes a `Buffer` global any more** — a consumer
  that relied on `init()` providing one must supply its own. `CBOR` is still reachable,
  via `getDecodedMetadata` or an explicit `loadAndUseDependency()`.
- `init()` is now a no-op that only sets `isInitialized`, and `request()` no longer
  calls it. The flag no longer implies that any dependency is loaded; do not branch on
  it to decide whether `CBOR` exists.
- The pinned CBOR decoder still loses precision on 64-bit integers and collapses
  distinct map keys. Fixing that needs a separate audited decoder inscription.

## Endpoint coverage (0.1.3-beta)

Every route below was checked against mainnet `ordinals.com` before being wrapped.

| Method | Route | Notes |
|---|---|---|
| `getBlockhash(height?)` | `/r/blockhash[/<height>]` | |
| `getBlockheight()` | `/r/blockheight` | |
| `getBlocktime()` | `/r/blocktime` | |
| `getBlockInfo(query)` | `/r/blockinfo/<height\|hash\|latest>` | a block hash is an art seed, not secure randomness |
| `getInscription(id)` | `/r/inscription/<id>` | type, length, delegate, sat, location; location is mutable |
| `getMetadata(id)` | `/r/metadata/<id>` | hex CBOR |
| `getDecodedMetadata(id)` | `/r/metadata/<id>` | decodes via the CBOR inscription, loaded lazily |
| `getChildren(id, page?)` | `/r/children/<id>[/<page>]` | IDs only |
| `getChildrenInscriptions(id, page?)` | `/r/children/<id>/inscriptions[/<page>]` | full details; paginates with `page` |
| `getParents(id, page?)` | `/r/parents/<id>[/<page>]` | paginates with `page_index`, not `page` |
| `getSatInscriptions(sat, page?, index?)` | `/r/sat/<sat>[/<page>][/at/<index>]` | page and index are mutually exclusive |
| `getSatLastInscription(sat)` | `/r/sat/<sat>/at/-1` | may answer `{"id": null}` |
| `getSatLastInscriptionContent(sat)` | above, then `/content/<id>` | resolves `null` for an empty sat |
| `getInscriptionContent(id)` | `/content/<id>` | follows a delegate; returns `{mime, base64}` |
| `getUndelegatedContent(id)` | `/r/undelegated-content/<id>` | the inscription's own bytes, delegate not followed |
| `getSatInscriptionContent(sat, index?)` | `/r/sat/<sat>/at/<index>/content` | one request instead of two; needs the sat index; defaults to `-1` |

`request(endpoint)` remains available for any JSON route without a wrapper.

### Errors

Every failing request throws `OrdJS <status> <endpoint>: <ord's own message>` with a
`status` property, for example
`OrdJS 404 /r/sat/1/at/0/content: inscription on sat 1 not found`. Branch on
`error.status`, not on message text. Note that a 404 from
`getSatInscriptionContent` means either an empty sat **or** a server running
without the sat index; ord's message distinguishes them, so it is preserved rather
than collapsed into "not found".

## The metadata decoder

`getDecodedMetadata` loads a decoder inscription lazily, once, from
`OrdJS.decoderUrl`. The default is the currently inscribed `cbor-js`
(`a9f6a9b0…308566i0`), which **decodes some metadata incorrectly**:

| Input | Inscribed decoder | Consequence |
|---|---|---|
| `9007199254740993` | `9007199254740992` | integers above 2^53 silently round: nanosecond timestamps, 18-decimal token amounts, snowflake IDs |
| map with key `1` and key `"1"` | `{"1": …}` | one entry silently disappears |
| map with key `__proto__` | no own keys, prototype changed | the value stops being data |
| ~1 MiB CBOR text | `RangeError` | large metadata cannot be decoded at all |

### The replacement candidate

`vendor/cbor2-decoder.js` is the proposed replacement, built by
`node scripts/build-decoder.mjs` from `cbor2@2.3.0` (MIT, notice retained in the
artifact). `vendor/cbor2-decoder.json` records its bytes, sha256 and build
command. **It is not inscribed yet**, so `inscription_id` is `null`.

To use it locally, serve the file and point the library at it:

```javascript
OrdJS.decoderUrl = '/vendor/cbor2-decoder.js';   // or /content/<id> once inscribed
```

`node scripts/decoder-smoke.mjs` decodes the RFC 8949 Appendix A vectors in
Chromium through that exact path: **59/59 correct**, integers above 2^53 arrive as
`BigInt`, mixed-type keys survive as a `Map`, and `__proto__` stays an own key with
a clean prototype. The same run against the currently inscribed decoder fails with
eight findings, so the check discriminates rather than decorates.

Migration is narrower than it looks: ordinary string-keyed metadata still decodes
to a plain object, so `meta.foo` keeps working. Only genuinely ambiguous maps
become a `Map`, and only integers beyond 2^53 become `BigInt` — precisely the cases
that are wrong today.



## Tests and the release gate

`test/` runs on Node's built-in runner with no dependencies:

```sh
node --test test/ordjs.test.mjs
```

Before inscribing, run the full gate. It runs the tests, minifies with a pinned
configuration, re-runs the tests against the **minified** artifact, enforces a byte
budget against the size of the live inscription, drives a real Chromium that loads
the library through `/content/<id>` exactly as an inscription does, and prints the
byte counts, hash and dependency inscription IDs a release record needs:

```sh
bun install                          # playwright, dev-only
npx playwright install chromium
node scripts/gate.mjs                # --no-browser skips only the Chromium stage
```

CI runs the same gate on every push and pull request.

The gate does not cover, and a release still requires: a real ord server with the
sat index both enabled and disabled, Firefox and WebKit, and a commit/reveal fee
dry-run at the chosen rate.

Tests, examples, tooling and this README are repository files only; inscribing the
library uses a minified `src/content/OrdJS.js` and nothing else.

## Contributing

Contributions to the OrdJS library are welcome. If you have suggestions for improvements or have identified bugs, please feel free to contribute. You can do so by creating issues or pull requests on the repository. Your input is valuable in enhancing the functionality and reliability of this library.

## License

The OrdJS Library is open source, provided under the [MIT license](https://opensource.org/license/mit/).