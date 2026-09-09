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

    // Kept for compatibility: nothing needs initialising and no method waits on
    // it, but the flag is still set so an existing caller that awaits init() and
    // reads it sees true.
    async init() {
      this.isInitialized = true;
    }

    // The CBOR decoder is inscribed on Bitcoin mainnet and loaded only when
    // decoded metadata is requested. Concurrent callers share one load, and a
    // failed load is retried rather than cached.
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
        throw await OrdJS.httpError(endpoint, response);
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

    // Inscription details: content type, length, delegate, sat, location. Fields
    // may be null, and location/address are mutable even though the ID is not.
    getInscription(inscriptionId) {
      return this.request(`/r/inscription/${inscriptionId}`);
    }

    // Parent IDs. This endpoint paginates with page_index, unlike children's page.
    getParents(inscriptionId, page = '') {
      return this.request(`/r/parents/${inscriptionId}${OrdJS.given(page) ? `/${page}` : ''}`);
    }

    // Child details rather than bare IDs: one request instead of N getInscription
    // calls. Paginates with page.
    getChildrenInscriptions(inscriptionId, page = '') {
      return this.request(`/r/children/${inscriptionId}/inscriptions${OrdJS.given(page) ? `/${page}` : ''}`);
    }

    // Block statistics for a height or a 64-character block hash. ord parses this
    // segment as a height or hash only: 'latest' is rejected with 400.
    getBlockInfo(query) {
      return this.request(`/r/blockinfo/${query}`);
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

    getInscriptionContent(inscriptionId) {
      return this.fetchContent(`/content/${inscriptionId}`);
    }

    // The inscription's OWN bytes. /content/<id> follows a delegate; this does not,
    // so a delegating inscription returns its own body here.
    getUndelegatedContent(inscriptionId) {
      return this.fetchContent(`/r/undelegated-content/${inscriptionId}`);
    }

    // One request instead of resolving the ID and then fetching it. Index -1 is the
    // latest inscription on the sat. Requires an ord with the sat index; an empty
    // sat and a server without that index both answer 404, and the thrown error
    // carries ord's own explanation of which it was.
    //
    // NOTE the deliberate difference from getSatLastInscriptionContent, which
    // resolves null for an empty sat because /r/sat/<n>/at/-1 answers 200 with
    // {"id": null}. Switching to this cheaper method converts that null into a
    // thrown 404.
    getSatInscriptionContent(satNumber, index = -1) {
      return this.fetchContent(`/r/sat/${satNumber}/at/${index}/content`);
    }

    async fetchContent(endpoint) {
      const response = await fetch(this.baseURL + endpoint);
      if (!response.ok) {
        throw await OrdJS.httpError(endpoint, response);
      }
      const contentType = response.headers.get('Content-Type');
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        mime: contentType,
        base64: OrdJS.toBase64(bytes)
      };
    }

    // ord explains its own failures in the response body ("inscription on sat 1 not
    // found", "...metadata not found"). Carrying that text turns an opaque status
    // into an actionable message; the status and endpoint stay in the message so a
    // caller can still branch on them.
    static async httpError(endpoint, response) {
      const detail = await response.text().catch(() => '');
      const error = new Error(`OrdJS ${response.status} ${endpoint}: ${detail.trim().slice(0, 200)}`);
      error.status = response.status;
      return error;
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
      // Validate before loading: malformed metadata must not cost a decoder fetch.
      const bytes = OrdJS.fromHex(encodedMetadata);
      await this.loadAndUseDependency();
      return CBOR.decode(bytes.buffer);
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

    // Treats only '', null, undefined and NaN as absent, so numeric 0 is kept
    // while an unparsed Number() stays a fallback instead of a 404 path segment.
    static given(value) {
      return value !== '' && value !== null && value !== undefined && value === value;
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
