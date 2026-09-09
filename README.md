
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

## Tests

`test/` runs on Node's built-in runner with no dependencies:

```sh
node --test test/ordjs.test.mjs
```

Tests, examples and this README are repository files only; inscribing the library
should use a minified `src/content/OrdJS.js`.

## Contributing

Contributions to the OrdJS library are welcome. If you have suggestions for improvements or have identified bugs, please feel free to contribute. You can do so by creating issues or pull requests on the repository. Your input is valuable in enhancing the functionality and reliability of this library.

## License

The OrdJS Library is open source, provided under the [MIT license](https://opensource.org/license/mit/).