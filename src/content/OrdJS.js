/**
 * OrdJS Library
 * Version: 0.1.3-beta
 * Author: Jerry the Martian
 *
 * Description:
 * This JavaScript library provides a convenient interface for interacting with the Ordinals Recursive Endpoints.
 * It includes methods for fetching block information, inscription metadata, and content associated with satoshis.
 * This library is inscribed and can be recursively imported by other Inscriptions.
 *
 * Note: This is a beta version and might contain bugs. Use with caution and contribute improvements if you find any.
 */

class OrdJS {
    constructor(baseURL) {
      this.baseURL = baseURL;
      this.isInitialized = false;
      this.decoderPromise = null;
    }

    async init() {
      this.isInitialized = true;
    }

    // The CBOR decoder is inscribed on Bitcoin mainnet and loaded only when
    // decoded metadata is requested. Concurrent callers share one load.
    loadAndUseDependency() {
      if (!this.decoderPromise) {
        this.decoderPromise = this.loadScript('/content/a9f6a9b050af3de1a4ce714978c1f2231ba731f1f46731a16d0e411f89308566i0')
          .catch((error) => {
            this.decoderPromise = null;
            throw error;
          });
      }
      return this.decoderPromise;
    }

    getInscriptionId() {
      const inscriptionId = window.location.pathname.split("/").pop();
      return inscriptionId || (console.error("URL does not contain a valid inscription ID."), null);
    }

    async request(endpoint) {
      const response = await fetch(this.baseURL + endpoint);
      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }
      return response.json();
    }

    getBlockhash(height = '') {
      const endpoint = OrdJS.given(height) ? `/r/blockhash/${height}` : '/r/blockhash';
      return this.request(endpoint);
    }

    getBlockheight() {
      return this.request('/r/blockheight');
    }

    getBlocktime() {
      return this.request('/r/blocktime');
    }

    getChildren(inscriptionId, page = '') {
      const endpoint = `/r/children/${inscriptionId}${OrdJS.given(page) ? `/${page}` : ''}`;
      return this.request(endpoint);
    }

    getMetadata(inscriptionId) {
      return this.request(`/r/metadata/${inscriptionId}`);
    }

    // page lists inscriptions on the sat; index selects a single one. They are
    // separate routes, so supplying both is rejected instead of building an
    // undocumented URL. Numeric 0 is a valid page and a valid index.
    getSatInscriptions(satNumber, page = '', index = '') {
      const hasPage = OrdJS.given(page);
      const hasIndex = OrdJS.given(index);
      if (hasPage && hasIndex) {
        return Promise.reject(new Error('Provide either page or index, not both.'));
      }
      const endpoint = `/r/sat/${satNumber}${hasPage ? `/${page}` : ''}${hasIndex ? `/at/${index}` : ''}`;
      return this.request(endpoint);
    }

    async getInscriptionContent(inscriptionId) {
      const response = await fetch(this.baseURL + `/content/${inscriptionId}`);
      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }
      const contentType = response.headers.get('Content-Type');
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        mime: contentType,
        base64: OrdJS.toBase64(bytes)
      };
    }

    async getSatLastInscription(satNumber) {
      return this.request(`/r/sat/${satNumber}/at/-1`);
    }

    // Resolves to null when the sat carries no inscription, which the endpoint
    // reports as {"id": null}. Transport and server errors still throw.
    async getSatLastInscriptionContent(satNumber) {
      const last = await this.getSatLastInscription(satNumber);
      const id = last && last.id;
      return id == null ? null : this.getInscriptionContent(id);
    }

    async getDecodedMetadata(inscriptionId) {
      const encodedMetadata = await this.getMetadata(inscriptionId);
      await this.loadAndUseDependency();
      return CBOR.decode(OrdJS.fromHex(encodedMetadata).buffer);
    }

    loadScript(url, isModule = false) {
      return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        if (isModule) {
          script.type = 'module';
        }
        script.src = url;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
    }

    // Treats only '', null and undefined as absent, so numeric 0 is kept.
    static given(value) {
      return value !== '' && value !== null && value !== undefined;
    }

    // Builds the binary string in bounded slices: spreading a whole inscription
    // into String.fromCharCode overflows the call stack on large content.
    static toBase64(bytes) {
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
      }
      return btoa(binary);
    }

    // Native hex decoding, so no Buffer polyfill inscription is required.
    static fromHex(hex) {
      if (typeof hex !== 'string' || hex.length % 2 || /[^0-9a-fA-F]/.test(hex)) {
        throw new Error('Metadata is not a hex string.');
      }
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
      }
      return bytes;
    }

}
