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
    this.supportedSystems = new Set();
    this.termCapsCache = new Map();
    this.termCapsCacheTtlMs = (config?.fallback?.metadataCacheMinutes || 30) * 60 * 1000;
    
    if (this.enabled) {
      log.info(`Fallback proxy enabled: ${this.server}`);
    }
  }

  /**
   * Normalize a CodeSystem URL for consistent matching.
   * - trims whitespace
   * - drops version suffix after '|'
   * - removes trailing slash
   * - lowercases scheme/host when parseable
   * @param {string} url
   * @returns {string|null}
   */
  normalizeSystemUrl(url) {
    if (url === null || url === undefined) {
      return null;
    }

    let normalized = String(url).trim();
    if (!normalized) {
      return null;
    }

    const versionSeparator = normalized.indexOf('|');
    if (versionSeparator >= 0) {
      normalized = normalized.substring(0, versionSeparator);
    }

    normalized = normalized.replace(/\/+$/, '');

    try {
      const parsed = new URL(normalized);
      parsed.protocol = parsed.protocol.toLowerCase();
      parsed.hostname = parsed.hostname.toLowerCase();
      normalized = parsed.toString().replace(/\/+$/, '');
    } catch {
      // Keep original normalized string for non-URL canonicals
    }

    return normalized;
  }

  /**
   * Register a locally-supported CodeSystem URL (called by Library after loading)
   * @param {string} url - CodeSystem URL
   */
  addSupportedSystem(url) {
    const normalized = this.normalizeSystemUrl(url);
    if (normalized && !this.supportedSystems.has(normalized)) {
      this.supportedSystems.add(normalized);
    }
  }

  /**
   * Get count of registered locally-supported systems
   * @returns {number}
   */
  getSupportedSystemCount() {
    return this.supportedSystems.size;
  }

  getFallbackTermCapsPath(fhirVersion) {
    const version = String(fhirVersion || '5.0');
    const major = version.split('.')[0];
    return major === '4' ? 'r4' : 'r5';
  }

  normalizeServerUrl() {
    return (this.server || '').replace(/\/+$/, '');
  }

  async getFallbackCodeSystemEntries(fhirVersion) {
    if (!this.enabled) {
      return [];
    }

    const fhirPath = this.getFallbackTermCapsPath(fhirVersion);
    const cacheKey = fhirPath;
    const now = Date.now();
    const cached = this.termCapsCache.get(cacheKey);
    if (cached && (now - cached.timestamp) < this.termCapsCacheTtlMs) {
      return cached.entries;
    }

    const url = `${this.normalizeServerUrl()}/${fhirPath}/metadata?mode=terminology`;

    try {
      const response = await axios.get(url, {
        timeout: 30000,
        headers: {
          Accept: 'application/fhir+json'
        },
        validateStatus: () => true
      });

      if (response.status !== 200 || !response.data || response.data.resourceType !== 'TerminologyCapabilities') {
        log.warn(`Fallback terminology capabilities not available from ${url} (status ${response.status})`);
        this.termCapsCache.set(cacheKey, { timestamp: now, entries: [] });
        return [];
      }

      const entries = [];
      for (const cs of response.data.codeSystem || []) {
        if (!cs || !cs.uri) {
          continue;
        }
        const entry = { uri: cs.uri };
        if (Array.isArray(cs.version) && cs.version.length > 0) {
          const versions = cs.version
            .map(v => v && v.code)
            .filter(Boolean)
            .map(code => ({ code }));
          if (versions.length > 0) {
            entry.version = versions;
          }
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

  /**
   * Check if a code system is supported locally (not requiring fallback)
   */
  isSupportedSystem(systemUrl) {
    const originalInput = systemUrl === null || systemUrl === undefined
      ? null
      : String(systemUrl).trim();
    const normalizedInput = this.normalizeSystemUrl(systemUrl);
    if (!normalizedInput) {
      return false;
    }

    if (originalInput && originalInput !== normalizedInput) {
      log.warn(`Normalized incoming system URL from '${originalInput}' to '${normalizedInput}'`);
    }

    return this.supportedSystems.has(normalizedInput);
  }

  /**
   * Extract the system parameter from FHIR Parameters resource or query params
   */
  extractSystem(params) {
    // Check direct parameter (from query string)
    if (params.system) {
      return params.system;
    }

    // CodeSystem/$validate-code commonly uses 'url' for the target code system
    if (params.url) {
      return params.url;
    }

    // Check FHIR Parameters resource (from POST body)
    if (params.parameter && Array.isArray(params.parameter)) {
      const systemParam = params.parameter.find(p => p.name === 'system');
      if (systemParam) {
        return systemParam.valueUri || systemParam.valueString;
      }

      const urlParam = params.parameter.find(p => p.name === 'url');
      if (urlParam) {
        return urlParam.valueUri || urlParam.valueCanonical || urlParam.valueString;
      }

      const codingParam = params.parameter.find(p => p.name === 'coding');
      if (codingParam?.valueCoding?.system) {
        return codingParam.valueCoding.system;
      }

      const codeableConceptParam = params.parameter.find(p => p.name === 'codeableConcept');
      if (codeableConceptParam?.valueCodeableConcept?.coding?.[0]?.system) {
        return codeableConceptParam.valueCodeableConcept.coding[0].system;
      }
    }

    // Check Coding
    if (params.coding) {
      return params.coding.system;
    }

    // Check CodeableConcept
    if (params.codeableConcept?.coding?.[0]) {
      return params.codeableConcept.coding[0].system;
    }

    return null;
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
