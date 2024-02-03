/**
 * OrdJS Library
 * Version: 0.1.1-beta
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
    }

    async init() {
        await this.loadAndUseDependency();
        this.isInitialized = true;
        console.log('OrdJS initialized successfully');
    }

    async loadAndUseDependency() {
        // Dependencies are inscribed on Bitcoin mainnet
        await this.loadScript(`/content/a9f6a9b050af3de1a4ce714978c1f2231ba731f1f46731a16d0e411f89308566i0`); //cbor
        await this.loadScript(`/content/fb15f2a6ed1d3031aa214cc12d3fa696508080c0baa194463920c8a79d21aa54i0`, true);  // buffer
    }

    getInscriptionId() {
        const parts = window.location.pathname.split("/");
        if (
                parts.length >= 3
                && parts[1] === "content"
            ) {
            return parts[2]; 
        } else {
            console.error("URL does not contain a valid inscription ID.");
            return null; 
        }
    }
      
    async request(endpoint) {
      if (!this.isInitialized) {
        await this.init();
      }
      const response = await fetch(this.baseURL + endpoint);
      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }
      return response.json();
    }

    getBlockhash(height = '') {
        const endpoint = (height !== undefined && height !== '') ? `/r/blockhash/${height}` : '/r/blockhash';
        return this.request(endpoint);
    }
      
    getBlockheight() {
      return this.request('/r/blockheight');
    }
  
    getBlocktime() {
      return this.request('/r/blocktime');
    }
  
    getChildren(inscriptionId, page = '') {
      const endpoint = `/r/children/${inscriptionId}${page ? `/${page}` : ''}`;    
      return this.request(endpoint);
    }
      
    getMetadata(inscriptionId) {
      return this.request(`/r/metadata/${inscriptionId}`);
    }
  
    getSatInscriptions(satNumber, page = '', index = '') {
      const endpoint = `/r/sat/${satNumber}${page ? `/${page}` : ''}${index ? `/at/${index}` : ''}`;
      return this.request(endpoint);
    }

    async getInscriptionContent(inscriptionId) {
        const response = await fetch(this.baseURL + `/content/${inscriptionId}`);
        if (!response.ok) {
          throw new Error(`HTTP error! Status: ${response.status}`);
        }
        const contentType = response.headers.get('Content-Type');
        const buffer = await response.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
        return {
          mime: contentType,
          base64: base64
        };
    }
       
    async getSatLastInscription(satNumber) {
      return this.request(`/r/sat/${satNumber}/at/-1`);
    }
    
    async getSatLastInscriptionContent(satNumber) {
      const lastInscriptionId = await this.getSatLastInscription(satNumber);
      return this.getInscriptionContent(lastInscriptionId.id);
    }

    async getDecodedMetadata(inscriptionId) {
      const encodedMetadata = await this.getMetadata(inscriptionId);
      const buffer = Buffer.from(encodedMetadata, 'hex');
      return CBOR.decode(buffer.buffer);
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

}