
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

## Contributing

Contributions to the OrdJS library are welcome. If you have suggestions for improvements or have identified bugs, please feel free to contribute. You can do so by creating issues or pull requests on the repository. Your input is valuable in enhancing the functionality and reliability of this library.

## License

The OrdJS Library is open source, provided under the [MIT license](https://opensource.org/license/mit/).