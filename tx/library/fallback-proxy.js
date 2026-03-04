//
// Fallback Proxy - Forwards unknown code systems to tx.fhir.org
//

const axios = require('axios');
const Logger = require('../../library/logger');
const log = Logger.getInstance().child({ module: 'fallback-proxy' });

class FallbackProxy {
  constructor(config) {
    this.enabled = config?.fallback?.enabled || false;
    this.server = config?.fallback?.server || 'https://tx.fhir.org';
    this.termCapsCache = new Map();
    this.termCapsCacheTtlMs = (config?.fallback?.metadataCacheMinutes || 30) * 60 * 1000;

    if (this.enabled) {
      log.info(`Fallback proxy enabled: ${this.server}`);
    }
  }

  /**
   * Check whether the system is directly handled by one of the locally
   * registered CodeSystem factory providers or static CodeSystem providers.
   * As a last resort, asks the Provider to resolve a CodeSystemProvider
   * instance for the URL.
   *
   * @param {string}           system
   * @param {Provider}         provider
   * @param {OperationContext} opContext
   * @returns {Promise<boolean>}
   */
  static async isLocallySupportedSystem(system, provider, opContext) {
    if (!system || !provider) {
      return false;
    }

    // Fast-path: exact key match (with or without trailing version separator)
    const hasKey = (map, key) => map && (map.has(key) || map.has(`${key}|`));
    if (
      hasKey(provider.codeSystemFactories, system) ||
      hasKey(provider.codeSystems, system)
    ) {
      return true;
    }

    // Final fallback: ask the provider to resolve the system
    try {
      const csp = await provider.getCodeSystemProvider(opContext, system, null, []);
      return !!csp;
    } catch {
      return false;
    }
  }

  /**
   * Extract code system URLs declared in a ValueSet resource.
   * Handles both compose.include and expansion.contains.
   *
   * @param {Object} valueSet - ValueSet resource (raw JSON or wrapped)
   * @returns {string[]}
   */
  static extractValueSetSystems(valueSet) {
    const raw = valueSet?.jsonObj || valueSet;
    const systems = new Set();

    for (const include of raw?.compose?.include || []) {
      if (include.system) systems.add(include.system);
    }

    const collectFromContains = (contains) => {
      for (const entry of contains || []) {
        if (entry.system) systems.add(entry.system);
        if (entry.contains?.length) collectFromContains(entry.contains);
      }
    };
    collectFromContains(raw?.expansion?.contains);

    return Array.from(systems);
  }

  /**
   * Check whether a ValueSet should be proxied to the fallback server.
   * Returns true when proxy is enabled and the ValueSet either is an HL7
   * core ValueSet or references at least one system not handled locally.
   *
   * @param {Object}          valueSet  - ValueSet resource (raw or wrapped)
   * @param {Provider}        provider
   * @param {OperationContext} opContext
   * @returns {Promise<boolean>}
   */
  static async shouldProxyValueSet(valueSet, provider, opContext) {
    if (!opContext?.fallbackProxy?.enabled || !valueSet) {
      return false;
    }

    const raw = valueSet.jsonObj || valueSet;
    if (raw.url?.startsWith('http://hl7.org/fhir/ValueSet/')) {
      return true;
    }

    const systems = FallbackProxy.extractValueSetSystems(valueSet);
    if (systems.length === 0) {
      return false;
    }

    for (const system of systems) {
      if (!await FallbackProxy.isLocallySupportedSystem(system, provider, opContext)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Fetch the list of CodeSystem entries from the fallback server's
   * TerminologyCapabilities (cached per FHIR version).
   *
   * @param {string} fhirVersion - e.g. '5.0.0' or '4.0.1'
   * @returns {Promise<Array>}
   */
  async getFallbackCodeSystemEntries(fhirVersion) {
    if (!this.enabled) {
      return [];
    }

    const fhirPath = this._fallbackFhirPath(fhirVersion);
    const cacheKey = fhirPath;
    const now = Date.now();
    const cached = this.termCapsCache.get(cacheKey);
    if (cached && (now - cached.timestamp) < this.termCapsCacheTtlMs) {
      return cached.entries;
    }

    const url = `${(this.server || '').replace(/\/+$/, '')}/${fhirPath}/metadata?mode=terminology`;

    try {
      const response = await axios.get(url, {
        timeout: 30000,
        headers: { Accept: 'application/fhir+json' },
        validateStatus: () => true
      });

      if (response.status !== 200 || !response.data || response.data.resourceType !== 'TerminologyCapabilities') {
        log.warn(`Fallback terminology capabilities not available from ${url} (status ${response.status})`);
        this.termCapsCache.set(cacheKey, { timestamp: now, entries: [] });
        return [];
      }

      const entries = [];
      for (const cs of response.data.codeSystem || []) {
        if (!cs?.uri) continue;
        const entry = { uri: cs.uri };
        if (Array.isArray(cs.version) && cs.version.length > 0) {
          const versions = cs.version.map(v => v?.code).filter(Boolean).map(code => ({ code }));
          if (versions.length > 0) entry.version = versions;
        }
        entries.push(entry);
      }

      this.termCapsCache.set(cacheKey, { timestamp: now, entries });
      log.info(`Loaded ${entries.length} fallback code systems from ${url}`);
      return entries;
    } catch (error) {
      log.warn(`Failed to load fallback terminology capabilities from ${url}: ${error.message}`);
      this.termCapsCache.set(cacheKey, { timestamp: now, entries: [] });
      return [];
    }
  }

  _fallbackFhirPath(fhirVersion) {
    const major = String(fhirVersion || '5.0').split('.')[0];
    return major === '4' ? 'r4' : 'r5';
  }

  /**
   * Proxy a request to tx.fhir.org
   */
  async proxyRequest(req, res) {
    if (!this.enabled) {
      return this.sendNotSupported(res);
    }

    try {
      // Use originalUrl to get full path including FHIR version
      // Our endpoints are /tx/r4/... or /tx/r5/... 
      // tx.fhir.org expects /r4/... or /r5/...
      // So strip the /tx prefix
      const targetPath = req.originalUrl.replace(/^\/tx/, '').split('?')[0]; // Remove query params, will pass via params
      const targetUrl = `${this.server}${targetPath}`;
      log.info(`Proxying to ${targetUrl}`);

      // Forward most headers, excluding problematic ones
      const headersToExclude = ['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding'];
      const forwardedHeaders = {};
      Object.keys(req.headers).forEach(header => {
        if (!headersToExclude.includes(header.toLowerCase())) {
          forwardedHeaders[header] = req.headers[header];
        }
      });

      // Ensure required headers are set properly
      forwardedHeaders['Accept'] = 'application/fhir+json';
      forwardedHeaders['Content-Type'] = 'application/fhir+json';

      const axiosConfig = {
        method: req.method,
        url: targetUrl,
        params: req.query,
        headers: forwardedHeaders,
        timeout: 30000,
        validateStatus: () => true // Accept any status code
      };

      // Include body for POST/PUT requests
      if (req.body && (req.method === 'POST' || req.method === 'PUT')) {
        axiosConfig.data = req.body;
      }

      const response = await axios(axiosConfig);

      // Forward response
      res.status(response.status);
      Object.keys(response.headers).forEach(header => {
        if (header.toLowerCase() !== 'transfer-encoding') { // Skip problematic headers
          res.setHeader(header, response.headers[header]);
        }
      });
      res.send(response.data);

    } catch (error) {
      // If the error is an HTTP response with FHIR OperationOutcome, forward it
      if (error.response && error.response.data) {
        const data = error.response.data;
        // Check if it's a FHIR OperationOutcome
        if (typeof data === 'object' && data.resourceType === 'OperationOutcome') {
          log.info(`Fallback server returned OperationOutcome (status ${error.response.status}): ${JSON.stringify(data.issue[0])}`);
          res.status(error.response.status);
          Object.keys(error.response.headers).forEach(header => {
            if (header.toLowerCase() !== 'transfer-encoding') {
              res.setHeader(header, error.response.headers[header]);
            }
          });
          return res.send(data);
        }
      }
      
      log.error(`Fallback proxy error: ${error.message}`);
      this.sendError(res, error);
    }
  }

  sendNotSupported(res) {
    res.status(404).json({
      resourceType: 'OperationOutcome',
      issue: [{
        severity: 'error',
        code: 'not-supported',
        diagnostics: 'Code system not supported by this server and fallback is disabled'
      }]
    });
  }

  sendError(res, error) {
    res.status(500).json({
      resourceType: 'OperationOutcome',
      issue: [{
        severity: 'error',
        code: 'exception',
        diagnostics: `Fallback proxy error: ${error.message}`
      }]
    });
  }
}

module.exports = { FallbackProxy };
